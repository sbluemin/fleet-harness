import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import {
  appendNotice,
  appendUser,
  initialChatState,
  lastQuestion,
  reduceChatEvent,
  type ChatState,
} from "./chat-store.js";
import { getT } from "./scuttlebutt-catalog.js";
import {
  connectChatStream,
  type ChatStreamConnection,
  type ChatStreamEvent,
} from "./sse-client.js";

export interface ChatSessionSnapshot {
  readonly state: ChatState;
  readonly draft: string;
}

export type AdmiralId = "tori" | "bori" | "dori";

export interface ChatLaunchChoice {
  readonly model: string;
  readonly effort: "low" | "medium" | "high";
}

export interface ChatSessionDeps {
  readonly admiral: AdmiralId;
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly connect?: (
    chatId: string,
    onEvent: (event: ChatStreamEvent) => void,
  ) => ChatStreamConnection;
  readonly locale?: () => ConsoleLocale | undefined;
  /** 세션을 시작할 때의 모델·강도. 설정에서 바꾸면 다음 세션부터 따른다. */
  readonly launch?: () => ChatLaunchChoice | null;
  /**
   * 실험 "부관의 Console 읽기"가 켜졌을 때 메시지에 실을 Console 스냅샷. 꺼져 있으면 null을 돌려주고
   * 본문은 오늘과 같은 `{ text }`다 — 서버도 그 경우 도구를 붙이지 않는다.
   */
  readonly console?: () => ConsoleSnapshotPayload | null;
}

export interface ConsoleSnapshotPayload {
  readonly theaters: readonly { readonly id: string; readonly label: string }[];
  readonly operations: readonly { readonly id: string; readonly theaterId: string; readonly type: string; readonly title: string; readonly activity: string }[];
}

export interface ChatSession {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ChatSessionSnapshot;
  readonly setDraft: (draft: string) => void;
  readonly ask: (text: string) => Promise<void>;
  /** 마지막 질문을 다시 보낸다. 오류 뒤의 「다시 시도」. */
  readonly retry: () => Promise<void>;
  /** 진행 중인 답만 멈춘다. */
  readonly stop: () => Promise<void>;
  /** 화면의 대화를 비운다. 서버 세션은 그대로라 부관은 앞의 맥락을 기억한다. */
  readonly clear: () => void;
  readonly close: () => void;
}

const INITIAL_SNAPSHOT: ChatSessionSnapshot = { state: initialChatState, draft: "" };

/** 이 코드들은 서버 세션이 사라졌다는 뜻이다 — 다음 질문은 새 세션으로 간다. */
const SESSION_GONE = new Set(["session_not_found", "chat_exited", "stream_closed"]);

/**
 * 대화는 카드가 아니라 마스코트에 매인다. 카드를 닫아도 스트림이 살아 있어야 답이 끝까지
 * 도착하고, 그래야 완료 연출이 나오고 '생각 중' 말풍선이 걷힌다. 카드가 소유하면 닫는 순간
 * 스트림이 끊겨 마스코트가 thinking 상태로 굳는다.
 *
 * 세션은 서버가 상한·자식 종료로 조용히 거둘 수 있다. 그때 chatId를 붙들고 있으면 이후 질문마다
 * 404가 오류 행이 된다 — 사라진 세션은 잊고, 다음 질문에서 새로 시작해 한 번 자동으로 다시 보낸다.
 */
export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const connect = deps.connect ?? connectChatStream;
  const listeners = new Set<() => void>();
  let snapshot = INITIAL_SNAPSHOT;
  let stream: ChatStreamConnection | null = null;
  let chatId: string | null = null;
  /** 지금 세션을 띄울 때의 모델·강도·언어. 어느 하나라도 바뀌면 다음 질문은 새 세션으로 간다. */
  let launched: { readonly choice: ChatLaunchChoice | null; readonly locale: ConsoleLocale | undefined } | null = null;
  let closed = false;
  const name = () => getT(deps.locale?.())(`bird.${deps.admiral}`);

  function put(next: Partial<ChatSessionSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  }

  function forgetSession(): void {
    stream?.close();
    stream = null;
    chatId = null;
    launched = null;
  }

  /**
   * 설정의 모델·강도나 Console 언어가 띄운 세션과 다르면 옛 세션을 거두고 잊는다 — 「다음 질문부터
   * 적용」의 실체다. 언어는 서버의 프롬프트 한 단락에 굳어 있으므로 세션을 바꿔야 따라온다.
   */
  function retireIfLaunchChanged(): void {
    if (chatId === null || launched === null) return;
    const current = deps.launch?.() ?? null;
    const locale = deps.locale?.();
    const sameChoice = current?.model === launched.choice?.model && current?.effort === launched.choice?.effort;
    if (sameChoice && locale === launched.locale) return;
    const stale = chatId;
    forgetSession();
    // 서버 세션은 유휴 축출로도 사라지지만, 자식 프로세스를 그때까지 두지 않는다.
    void request(`chat/${encodeURIComponent(stale)}/stop`, {}).catch(() => undefined);
  }

  function receive(event: ChatStreamEvent): void {
    if (closed) return;
    if (event.type === "error" && SESSION_GONE.has(event.error.code)) forgetSession();
    put({ state: reduceChatEvent(snapshot.state, event, name(), deps.locale?.()) });
  }

  /**
   * 호스트의 fetch는 비-2xx에서 던진다(상태와 JSON 본문을 든 오류). 플러그인 번들은 호스트와
   * 모듈 사본이 다를 수 있어 그 클래스를 `instanceof`로 가르지 않는다 — 모양으로 읽어 코드로 옮긴다.
   */
  async function request(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await deps.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ChatRequestError(errorCodeOf(error));
    }
    if (!response.ok) throw new ChatRequestError(await readErrorCode(response));
    return response.json().catch(() => null);
  }

  async function start(): Promise<string> {
    const launch = deps.launch?.() ?? null;
    const locale = deps.locale?.();
    const payload = await request("chat/start", {
      admiral: deps.admiral,
      ...(launch ? { model: launch.model, effort: launch.effort } : {}),
      ...(locale ? { locale } : {}),
    }) as { readonly chatId?: unknown } | null;
    if (!payload || typeof payload.chatId !== "string") throw new ChatRequestError("generic");
    launched = { choice: launch, locale };
    return payload.chatId;
  }

  async function ensureSession(): Promise<string> {
    retireIfLaunchChanged();
    if (chatId !== null) return chatId;
    const started = await start();
    if (closed) throw new ChatRequestError("closed");
    chatId = started;
    stream = connect(started, receive);
    await stream.connected;
    return started;
  }

  async function deliver(question: string): Promise<void> {
    const id = await ensureSession();
    const console = deps.console?.() ?? null;
    await request(`chat/${encodeURIComponent(id)}/message`, console ? { text: question, console } : { text: question });
  }

  async function send(question: string): Promise<void> {
    put({ draft: "", state: { ...appendUser(snapshot.state, question), phase: "starting" } });
    try {
      try {
        await deliver(question);
      } catch (error) {
        // 서버가 세션을 거둔 뒤 첫 질문 — 새 세션으로 한 번만 다시 보낸다. 알림 한 줄이 그 사이를 설명한다.
        if (!(error instanceof ChatRequestError) || error.code !== "session_not_found" || closed) throw error;
        forgetSession();
        put({ state: appendNotice(snapshot.state, getT(deps.locale?.())("notice.rejoined", { name: name() })) });
        await deliver(question);
      }
      if (closed) return;
      // 답이 이 응답보다 먼저 끝났을 수 있다 — 그때는 도착한 상태를 덮지 않는다.
      if (snapshot.state.phase === "starting") put({ state: { ...snapshot.state, phase: "thinking" } });
    } catch (error) {
      if (closed) return;
      const code = error instanceof ChatRequestError ? error.code : "generic";
      if (SESSION_GONE.has(code)) forgetSession();
      put({
        state: reduceChatEvent(snapshot.state, {
          type: "error",
          error: { code, message: code },
        }, name(), deps.locale?.()),
      });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    setDraft(draft) {
      if (draft !== snapshot.draft) put({ draft });
    },
    async ask(text) {
      const question = text.trim();
      const phase = snapshot.state.phase;
      if (closed || !question || phase === "starting" || phase === "thinking") return;
      await send(question);
    },
    async retry() {
      const question = lastQuestion(snapshot.state);
      const phase = snapshot.state.phase;
      if (closed || question === null || phase === "starting" || phase === "thinking") return;
      await send(question);
    },
    async stop() {
      const id = chatId;
      const phase = snapshot.state.phase;
      if (closed || id === null || (phase !== "starting" && phase !== "thinking")) return;
      try {
        await request(`chat/${encodeURIComponent(id)}/cancel`, {});
      } catch {
        // 멈추기 실패는 조용히 둔다 — 답은 어차피 끝나고, 그때 카드가 풀린다.
      }
    },
    clear() {
      if (closed) return;
      put({ state: { ...initialChatState, phase: snapshot.state.phase === "error" ? "idle" : snapshot.state.phase } });
    },
    close() {
      closed = true;
      stream?.close();
      stream = null;
      listeners.clear();
    },
  };
}

class ChatRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** 호스트 fetch가 던진 오류에서 코드를 읽는다 — `{ status, body: { error } }` 모양이면 그 코드, 아니면 일반. */
function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== "object") return "generic";
  const body = (error as { body?: unknown }).body;
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return (error as { status?: unknown }).status === 403 ? "forbidden" : "generic";
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { readonly error?: unknown };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // 본문이 JSON이 아니면 상태 코드로 가른다.
  }
  return response.status === 403 ? "forbidden" : "generic";
}
