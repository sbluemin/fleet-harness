import { promises as fs } from "node:fs";
import path from "node:path";

import {
  createClaudeGatewaySdk,
  type ClaudeGatewayEffort,
  type ClaudeGatewayMessage,
  type ClaudeGatewaySdk,
} from "@dotobokuri/core-agent/claude";

import {
  AGENT_CHAT_ASK_TOOLS,
  agentChatAskFromToolInput,
  chatEventsFromSdkMessage,
  chatReplayFromTranscriptLine,
  type AgentChatJournalEvent,
  type AgentChatQuestion,
  type AgentChatStreamEvent,
} from "./chat-events.js";
import type { AgentProviderSession } from "./types.js";

/**
 * Chat Mode 세션 하나의 서버 소유 상태.
 *
 * PTY가 없다 — 같은 Claude 세션을 core-agent SDK가 격리 config dir에서 이어받아 돌린다.
 * 원 세션의 트랜스크립트는 생성 시 격리 dir로 복사돼 resume의 근거가 되고(스파이크로 실증),
 * 매 턴이 끝나면 원 projects 디렉터리로 되쓴다 — Console 재시작·터미널 복귀(--resume)·
 * Session Analyst가 전부 그 원본 경로 하나를 계속 권위로 삼게 하기 위해서다.
 */

/**
 * 이 세션이 어디서 시작하는가. 두 길은 대칭이 아니다 — `resume`은 이미 있는 트랜스크립트가
 * 세션 id와 projects 디렉터리 이름을 **둘 다** 말해 주지만, `fresh`는 아직 아무것도 없어서
 * 그 둘을 SDK가 첫 턴에 만들어 준 뒤에야 알 수 있다.
 *
 * `fresh`가 아는 것은 되쓸 뿌리 하나뿐이다. cwd → projects 디렉터리 이름의 인코딩 규칙은
 * 여기서도 재구현하지 않는다: SDK가 자기 격리 dir 안에 만든 디렉터리 이름을 그대로 읽어
 * 같은 이름으로 뿌리 아래에 내려놓는다(resume이 원 경로의 부모 이름을 그대로 쓰는 것과 같은 규율).
 */
export type AgentChatSessionOrigin =
  | { readonly kind: "resume"; readonly transcriptPath: string }
  | { readonly kind: "fresh"; readonly transcriptRoot: string };

export interface AgentChatSessionSeed {
  readonly baseUrl: string;
  readonly model: string;
  readonly effort?: ClaudeGatewayEffort;
  readonly cwd: string;
  readonly origin: AgentChatSessionOrigin;
  readonly onProviderSessionUpdate: (providerSession: AgentProviderSession) => void;
  /**
   * 이 세션의 실행 활동을 Operation 활동축에 보고한다. 반환 false는 축이 이 보고를 받지 못했다는
   * 뜻이며, 그때는 턴을 시작하지 않는다 — 배선이 끊긴 채 도는 턴은 화면에 휴면으로 보이고,
   * 그 조용한 거짓말이 이 계약이 존재하는 이유다.
   */
  readonly reportActivity: (working: boolean) => boolean;
  /**
   * 활동축이 이 세션의 보고를 받을 수 있는지 묻기만 한다 — 아무것도 쓰지 않는다.
   * 쓰는 프로브는 진행 중 턴을 유휴로 뒤집고 그 전이를 방송해, 첫 턴이 도는 중에 들어온
   * 두 번째 메시지가 조기 턴 종료 신호를 만든다.
   */
  readonly canReportActivity: () => boolean;
  /**
   * 사용자의 답을 기다리는 구간을 활동축에 보고한다. 진행 중 턴 안에서만 서므로 working 보고를
   * 끄지 않는다 — 이 값을 읽는 쪽이 대기를 작업보다 앞세운다.
   */
  readonly reportAwaiting: (awaiting: boolean) => void;
}

/**
 * 사용자에게 건넨 답변. 한 질문에 하나씩이며, 값은 고른 라벨(다중 선택은 콤마로 이어 붙인 것)
 * 이거나 사용자가 직접 쓴 문장이다 — 도구는 목록 밖 문자열도 그대로 받아들인다(실측).
 */
export interface AgentChatAnswerInput {
  /** 질문 카드: 질문 순서대로의 답. 빈 문자열은 "그 질문은 건너뛴다"가 아니라 거절 사유가 된다. */
  readonly answers?: readonly string[];
  /** 계획 카드: 승인. */
  readonly approve?: boolean;
  /** 질문의 물리기와 계획의 수정 요청이 함께 쓰는 자리 — 자식에게 오류 결과로 전달된다. */
  readonly message?: string;
}

export type AgentChatAnswerResult =
  | { readonly ok: true; readonly outcome: "answered" | "dismissed" | "approved" | "revised" }
  | { readonly ok: false; readonly error: "ask_not_found" | "invalid_answer" | "plan_truncated" };

/** 답을 기다리며 붙들고 있는 도구 호출 하나. */
interface PendingAsk {
  readonly form: "question" | "plan";
  readonly input: Readonly<Record<string, unknown>>;
  readonly questions: readonly AgentChatQuestion[];
  /**
   * 답을 실을 키 — 도구가 받은 **원본** 질문 텍스트다. 카드가 보여 주는 questions[].question은
   * 상한과 trim을 지난 표시용이라, 그것을 키로 쓰면 400자를 넘거나 앞뒤 공백이 있는 질문에서
   * 키가 어긋난다. 그때 라우트는 200을 돌려주고 카드는 접히는데 모델은 답을 못 받는다.
   */
  readonly answerKeys: readonly string[];
  /**
   * 계획이 상한에 잘렸다. 승인 거절은 카드가 아니라 여기서 진다 — 버튼을 감추는 것은 화면의
   * 예의일 뿐이고, 리로드하지 않은 옛 번들은 그 사실을 모른 채 승인을 보낼 수 있다.
   * 보지 못한 것을 승인할 수 없다는 규칙은 그 요청이 닿는 자리에 있어야 규칙이 된다.
   */
  readonly truncated: boolean;
  readonly settle: (permission: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }) => void;
}

/** 테스트가 실 SDK 스폰 없이 레지스트리를 돌리기 위한 주입점. */
export type CreateChatSdk = (options: {
  readonly baseUrl: string;
  readonly models: readonly string[];
}) => Promise<ClaudeGatewaySdk>;

const JOURNAL_CAP = 2_000;
const TOOL_NAME_CAP = 500;

/**
 * 닫힌 턴 뒤에 이 이벤트가 오면 모델이 다시 말하기 시작한 것이다. 잡 이벤트는 여기 들지 않는다 —
 * 백그라운드 맥박은 턴이 닫힌 뒤에도 계속 흐르는 것이 정상이고, 그것으로 턴을 열면 아무 말도
 * 없는 빈 턴이 선다.
 */
function opensChatTurn(event: AgentChatStreamEvent): boolean {
  return event.kind === "text" || event.kind === "text-delta" || event.kind === "tool" || event.kind === "tool-start";
}

class AgentChatSession {
  readonly operationId: string;
  private readonly seed: AgentChatSessionSeed;
  private readonly createSdk: CreateChatSdk;
  private sdk: ClaudeGatewaySdk | null = null;
  private sdkFlight: Promise<ClaudeGatewaySdk> | null = null;
  /**
   * resume 좌표는 트랜스크립트 파일명이 말하는 세션 id다 — 캡처 id는 드리프트할 수 있다.
   * `fresh`는 아직 세션이 없으므로 null로 출발하고, 첫 SDK 메시지의 session_id가 이 자리를 채운다.
   */
  private latestSessionId: string | null;
  private journal: AgentChatJournalEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(event: AgentChatJournalEvent) => void>();
  private turnFlight: Promise<void> = Promise.resolve();
  private pendingTurns = 0;
  private disposed = false;
  /**
   * tool_use id → 도구 이름. 결과 블록은 자기가 어떤 도구의 결말인지 모르는데, 무엇을 요약해도
   * 되는지는 도구가 정한다(읽기·쓰기 계열의 성공 결과는 내용이라 싣지 않는다). 긴 세션에서
   * 무한히 자라지 않게 상한을 두고 오래된 것부터 버린다 — 결과는 호출 직후에 오므로 잃을 게 없다.
   */
  private readonly toolNames = new Map<string, string>();
  /**
   * 답을 기다리는 도구 호출들. 만료는 두지 않는다(제품 결정) — 사용자가 답하거나 물릴 때까지,
   * 아니면 턴이 끊길 때까지 산다. 그래서 이 맵을 비우는 자리는 셋뿐이다: answer(), 턴 중단,
   * dispose(). 어느 경로로도 비워지지 않으면 SDK는 무기한 멈춘다(권한 요청에 park deadline이 없다).
   */
  private readonly pendingAsks = new Map<string, PendingAsk>();

  constructor(operationId: string, seed: AgentChatSessionSeed, createSdk: CreateChatSdk) {
    this.operationId = operationId;
    this.seed = seed;
    this.createSdk = createSdk;
    this.latestSessionId = seed.origin.kind === "resume"
      ? path.basename(seed.origin.transcriptPath, ".jsonl")
      : null;
  }

  get busy(): boolean {
    return this.pendingTurns > 0;
  }

  async replayTranscript(): Promise<void> {
    // 채팅으로 태어난 세션에는 되돌려줄 과거가 없다 — 빈 리플레이는 "읽지 못했다"와 다르므로
    // 오류 이벤트도 내지 않고, 로그는 첫 턴부터 자란다.
    if (this.seed.origin.kind === "fresh") return;
    const transcriptPath = this.seed.origin.transcriptPath;
    this.push({ kind: "replay-start" });
    let turns = 0;
    // 재생 턴의 소요 시간은 트랜스크립트가 이미 들고 있다 — 디스패치 줄과 그 턴 마지막 줄의
    // 시각 차이다. 이것이 없으면 접힘 줄이 과거 턴에서만 시간을 잃는다.
    let turnAt: number | null = null;
    let lastAt: number | null = null;
    const closeReplayedTurn = (): void => {
      if (turnAt !== null && lastAt !== null && lastAt > turnAt) {
        this.push({ kind: "turn-end", ok: true, durationMs: lastAt - turnAt });
      }
      turnAt = null;
      lastAt = null;
    };
    try {
      const raw = await fs.readFile(transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const mapped = chatReplayFromTranscriptLine(line, { cwd: this.seed.cwd, toolNames: this.toolNames });
        for (const event of mapped.events) {
          if (event.kind === "dispatch") {
            closeReplayedTurn();
            turns += 1;
            turnAt = mapped.at ?? null;
          }
          this.rememberTool(event);
          this.push(event);
        }
        if (mapped.events.length > 0 && mapped.at !== undefined) lastAt = mapped.at;
      }
      closeReplayedTurn();
    } catch {
      // 트랜스크립트를 읽지 못해도 세션은 계속된다 — 로그가 비어 보일 뿐 새 턴은 돌 수 있다.
      this.push({ kind: "error", code: "chat_replay_unavailable" });
    }
    this.push({ kind: "replay-end", turns });
  }

  /** 저널 전체를 되돌려준 뒤 라이브 이벤트를 흘린다. 반환값은 구독 해제다. */
  subscribe(listener: (event: AgentChatJournalEvent) => void): () => void {
    for (const entry of this.journal) listener(entry);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 턴을 직렬화해 실행한다. 반환은 큐 등록 시점이다 — 진행·실패는 저널 이벤트로 전달된다.
   * 실패한 턴은 반드시 run.close()로 슬롯을 반납한다(스파이크에서 실증한 함정).
   */
  /**
   * 활동축이 이 세션의 턴을 받을 수 있는지 미리 확인한다. 큐에 넣은 뒤에는 HTTP 응답이 이미
   * 떠났으므로, 거절은 요청 경계에서만 시끄러울 수 있다.
   */
  canReportActivity(): boolean {
    return this.seed.canReportActivity();
  }

  send(text: string): void {
    if (this.disposed) return;
    this.pendingTurns += 1;
    this.turnFlight = this.turnFlight
      .then(() => this.runTurn(text))
      .catch(() => undefined)
      .finally(() => {
        this.pendingTurns -= 1;
      });
  }

  /** 지금 답을 기다리는 도구 호출이 있는가. 라우트가 대기 유무를 묻는 자리. */
  get awaiting(): boolean {
    return this.pendingAsks.size > 0;
  }

  /**
   * 대기 중인 질문 하나를 사용자의 답으로 푼다.
   *
   * 답변이 자식에게 닿는 통로는 권한 응답 하나다: 질문은 `updatedInput.answers`(질문 텍스트 → 답)로,
   * 계획은 allow 자체가 승인이 되고, 거절 메시지는 계획 쪽에서 곧 수정 요청이 되어 모델이 계획을
   * 고쳐 다시 낸다(실측).
   */
  answer(id: string, input: AgentChatAnswerInput): AgentChatAnswerResult {
    const pending = this.pendingAsks.get(id);
    if (!pending) return { ok: false, error: "ask_not_found" };
    const message = typeof input.message === "string" ? input.message.trim() : "";

    if (pending.form === "plan") {
      // 잘린 계획은 승인만 막는다. 수정 요청은 그대로 열려 있어 더 짧은 계획을 받을 수 있고,
      // 대기도 유지된다 — 여기서 대기를 풀면 사용자는 답할 자리를 잃는다.
      if (pending.truncated && input.approve === true) return { ok: false, error: "plan_truncated" };
      this.pendingAsks.delete(id);
      if (input.approve === true) {
        pending.settle({ behavior: "allow", updatedInput: { ...pending.input } });
        this.settleAsk(id, "approved");
        return { ok: true, outcome: "approved" };
      }
      if (message.length === 0) {
        this.pendingAsks.set(id, pending);
        return { ok: false, error: "invalid_answer" };
      }
      pending.settle({ behavior: "deny", message });
      this.settleAsk(id, "revised");
      return { ok: true, outcome: "revised" };
    }

    // 물리기 — 답을 주지 않고 나간다. 07번 실측대로 턴은 깨지지 않고 모델이 그 사실을 알고 계속한다.
    if (!Array.isArray(input.answers)) {
      this.pendingAsks.delete(id);
      pending.settle({
        behavior: "deny",
        message: message.length > 0 ? message : "The user dismissed the question without answering.",
      });
      this.settleAsk(id, "dismissed");
      return { ok: true, outcome: "dismissed" };
    }

    const values = input.answers.map((value) => (typeof value === "string" ? value.trim() : ""));
    if (values.length !== pending.questions.length || values.some((value) => value.length === 0)) {
      return { ok: false, error: "invalid_answer" };
    }
    const answers: Record<string, string> = {};
    pending.answerKeys.forEach((key, index) => {
      answers[key] = values[index] ?? "";
    });
    this.pendingAsks.delete(id);
    pending.settle({ behavior: "allow", updatedInput: { ...pending.input, answers } });
    this.settleAsk(id, "answered", pending.questions.map((question, index) => ({
      header: question.header,
      value: values[index] ?? "",
    })));
    return { ok: true, outcome: "answered" };
  }

  /** 결말을 저널에 남기고, 남은 대기가 없으면 활동축의 대기 표시를 거둔다. */
  private settleAsk(
    id: string,
    outcome: "answered" | "dismissed" | "approved" | "revised",
    answers?: readonly { readonly header: string; readonly value: string }[],
  ): void {
    this.push({ kind: "ask-settled", id, outcome, ...(answers ? { answers } : {}) });
    if (this.pendingAsks.size === 0) this.seed.reportAwaiting(false);
  }

  /**
   * 남은 대기를 전부 거절로 접는다. 턴이 끊기거나 세션이 사라지는 자리에서 부른다 — 풀리지 않은
   * promise 하나가 SDK 스트림을 영원히 붙들기 때문이다.
   */
  private abandonAsks(reason: string): void {
    if (this.pendingAsks.size === 0) return;
    for (const [id, pending] of this.pendingAsks) {
      this.pendingAsks.delete(id);
      pending.settle({ behavior: "deny", message: reason });
      this.push({ kind: "ask-settled", id, outcome: "dismissed" });
    }
    this.seed.reportAwaiting(false);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abandonAsks("The chat session closed before the question was answered.");
    // SDK를 먼저 접는다 — dispose가 활성 런을 close해 진행 중 턴을 끊는다. 순서를 뒤집어
    // 턴 완주를 먼저 기다리면, 멈춘 턴 하나가 Operation 삭제·Console 셧다운을 무기한 막는다.
    const sdk = this.sdk;
    this.sdk = null;
    if (sdk) await sdk.dispose().catch(() => undefined);
    await this.turnFlight.catch(() => undefined);
    this.listeners.clear();
  }

  /** 도구 이벤트가 지나갈 때 id→이름을 적어 둔다. 결과 요약 정책이 이 축 위에서 결정된다. */
  private rememberTool(event: AgentChatStreamEvent): void {
    if (event.kind !== "tool" && event.kind !== "tool-start") return;
    if (event.id === undefined) return;
    this.toolNames.set(event.id, event.name);
    if (this.toolNames.size > TOOL_NAME_CAP) {
      const oldest = this.toolNames.keys().next();
      if (!oldest.done) this.toolNames.delete(oldest.value);
    }
  }

  /**
   * 자식이 도구를 쓰기 전에 부르는 자리. 대화형 도구 둘만 여기서 멈춰 사용자를 기다리고,
   * 나머지는 즉시 통과한다.
   *
   * 반환 promise는 answer()가 풀 때까지 열려 있고, 그동안 SDK 스트림도 함께 멈춘다 — 그것이
   * 이 기능의 작동 방식이자 위험이다. 그래서 푸는 자리를 셋으로 못 박고(answer·중단·dispose),
   * 형태를 못 읽은 입력은 카드를 세우지 않고 그냥 통과시킨다.
   */
  private async askUser(
    name: string,
    input: Readonly<Record<string, unknown>>,
    context: { readonly toolUseId: string; readonly signal: AbortSignal },
  ): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    if (!AGENT_CHAT_ASK_TOOLS.has(name)) return { behavior: "allow" };
    const id = context.toolUseId.length > 0 ? context.toolUseId : `ask-${this.seq + 1}`;
    const parsed = agentChatAskFromToolInput(name, id, input);
    if (!parsed) return { behavior: "allow" };
    const ask = parsed.event;
    if (this.disposed) return { behavior: "deny", message: "The chat session is closing." };

    // 이미 끊긴 턴에는 카드를 세우지 않는다. AbortSignal은 지나간 abort를 재생하지 않으므로,
    // 등록 전에 끊겼다면 아래 리스너는 영영 불리지 않는다 — 턴 종료의 abandonAsks가 결국
    // 거두긴 하지만, 그 사이 이미 끝난 턴의 질문이 화면에 서고 사이드바가 대기라고 말한다.
    if (context.signal.aborted) {
      return { behavior: "deny", message: "The turn ended before the question was answered." };
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (permission: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }): void => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", onAbort);
        resolve(permission);
      };
      function onAbort(): void {
        settle({ behavior: "deny", message: "The turn ended before the question was answered." });
      }
      // 턴이 끊기면 카드도 끝난다. 이 배선이 없으면 중단된 턴의 질문이 맵에 남아, 다음 턴이
      // 시작될 때까지 사이드바가 대기라고 말한다.
      context.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingAsks.set(id, {
        form: ask.form,
        input,
        questions: ask.questions ?? [],
        answerKeys: parsed.answerKeys,
        truncated: ask.truncated === true,
        settle: (permission) => {
          settle(permission);
          this.pendingAsks.delete(id);
        },
      });
      this.push(ask);
      this.seed.reportAwaiting(true);
    });
  }

  private push(event: AgentChatStreamEvent): void {
    const entry: AgentChatJournalEvent = { seq: ++this.seq, event };
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_CAP) this.journal.splice(0, this.journal.length - JOURNAL_CAP);
    for (const listener of this.listeners) listener(entry);
  }

  /**
   * 라이브 구독자에게만 흘리고 저널에는 남기지 않는다 — 글자 단위 델타를 저널(cap 2000)에
   * 쌓으면 즉시 소진된다. 재접속 리플레이는 완성 text 이벤트(병합본)로 같은 내용을 복원하고,
   * 그 완성 이벤트가 델타 유실의 정정 앵커를 겸한다. seq는 저널과 한 축을 공유한다.
   */
  private pushEphemeral(event: AgentChatStreamEvent): void {
    const entry: AgentChatJournalEvent = { seq: ++this.seq, event };
    for (const listener of this.listeners) listener(entry);
  }

  private async ensureSdk(): Promise<ClaudeGatewaySdk> {
    if (this.sdk) return this.sdk;
    if (!this.sdkFlight) {
      this.sdkFlight = (async () => {
        const sdk = await this.createSdk({ baseUrl: this.seed.baseUrl, models: [this.seed.model] });
        try {
          await this.copyTranscriptIntoConfigDir(sdk.configDir);
        } catch (error) {
          await sdk.dispose().catch(() => undefined);
          throw error;
        }
        if (this.disposed) {
          await sdk.dispose().catch(() => undefined);
          throw new Error("chat session disposed");
        }
        this.sdk = sdk;
        return sdk;
      })().finally(() => {
        this.sdkFlight = null;
      });
    }
    return this.sdkFlight;
  }

  /**
   * 원 트랜스크립트를 격리 config dir의 같은 projects/<인코딩된 cwd>/ 아래로 복사한다.
   * 인코딩 규칙을 재구현하지 않는다 — 원 경로의 부모 디렉터리 이름이 곧 그 인코딩이다.
   * 채팅으로 태어난 세션에는 복사할 원본이 없다 — SDK가 자기 dir 안에 스스로 만든다.
   */
  private async copyTranscriptIntoConfigDir(configDir: string): Promise<void> {
    if (this.seed.origin.kind === "fresh") return;
    const projectDirName = path.basename(path.dirname(this.seed.origin.transcriptPath));
    const dest = path.join(configDir, "projects", projectDirName, `${this.latestSessionId}.jsonl`);
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fs.copyFile(this.seed.origin.transcriptPath, dest);
  }

  private async runTurn(text: string): Promise<void> {
    if (this.disposed) return;
    this.push({ kind: "dispatch", text, at: Date.now() });
    this.push({ kind: "turn-start", at: Date.now() });
    // 활동 보고가 먼저다. 실패하면 SDK를 부르지 않는다 — 턴이 도는데 축이 휴면이라고 말하는
    // 상태를 만들지 않기 위해, 여기서는 일을 시작하지 않는 쪽을 고른다.
    if (!this.seed.reportActivity(true)) {
      this.push({ kind: "error", code: "chat_activity_unavailable" });
      this.push({ kind: "turn-end", ok: false });
      return;
    }
    let sawResult = false;
    try {
      const sdk = await this.ensureSdk();
      const run = await sdk.startTurn({
        prompt: text,
        model: this.seed.model,
        ...(this.seed.effort ? { effort: this.seed.effort } : {}),
        cwd: this.seed.cwd,
        // 채팅으로 태어난 세션의 첫 턴에는 이어붙일 좌표가 없다 — resume 없이 시작하고,
        // SDK가 돌려주는 session_id가 그 자리를 채운다(그다음 턴부터는 resume이 선다).
        ...(this.latestSessionId ? { resume: this.latestSessionId } : {}),
        permissionMode: "bypassPermissions",
        // 이 콜백은 권한 게이트가 아니다. 모드는 그대로 bypass이고 평범한 도구는 여기서 그냥
        // 통과한다 — 콜백을 주는 이유는 그래야 자식이 대화형 도구를 갖기 때문이다(실측: 29→32).
        canUseTool: (name, input, context) => this.askUser(name, input, context),
        // 스트리밍 감각의 근거 — 글자 단위 text_delta를 받으려면 부분 메시지가 필요하다.
        includePartialMessages: true,
      });
      // 하나의 startTurn이 result를 여러 번 낸다. 백그라운드 작업이 끝나면 SDK가 새 system/init과
      // 함께 모델을 다시 깨우고, 그 응답이 두 번째 result로 닫힌다(2026-08-16 실측). 닫힌 턴에
      // 그 응답을 이어 붙이면 앞 턴의 Answer가 갈아치워지므로, 내용이 다시 흐르기 시작하면
      // 디스패치 없는 새 턴을 연다.
      let turnClosed = false;
      try {
        for await (const message of run as AsyncIterable<ClaudeGatewayMessage>) {
          if (typeof message.session_id === "string" && message.session_id.length > 0) {
            this.latestSessionId = message.session_id;
          }
          for (const event of chatEventsFromSdkMessage(message, { cwd: this.seed.cwd, toolNames: this.toolNames })) {
            if (event.kind === "turn-end") {
              sawResult = true;
              turnClosed = true;
            } else if (turnClosed && opensChatTurn(event)) {
              this.push({ kind: "turn-start", at: Date.now() });
              turnClosed = false;
            }
            this.rememberTool(event);
            // 대화형 도구는 스텝을 세우지 않는다 — 카드가 이미 그 자리에 서 있고, 그 옆에 "질문함"
            // 한 줄을 더 세우면 같은 사건이 두 번 읽힌다. 결과 줄은 짝을 못 찾아 스스로 버려진다.
            if ((event.kind === "tool" || event.kind === "tool-start") && AGENT_CHAT_ASK_TOOLS.has(event.name)) continue;
            // tool-start는 완성 tool 이벤트가 같은 스텝을 다시 세우므로 저널에 남기지 않는다 —
            // 남기면 재접속 리플레이에서 좌표 없는 빈 스텝이 한 줄 더 선다.
            if (event.kind === "text-delta" || event.kind === "tool-start") this.pushEphemeral(event);
            else this.push(event);
          }
        }
      } finally {
        // 정상 소진이면 no-op, 도중 이탈이면 슬롯 반납 — 없으면 다음 턴이 영영 막힌다.
        run.close();
      }
      if (!sawResult) this.push({ kind: "turn-end", ok: true });
      await this.writeBackTranscript();
    } catch {
      this.push({ kind: "error", code: "chat_turn_failed" });
      if (!sawResult) this.push({ kind: "turn-end", ok: false });
    } finally {
      // 정상 경로에서는 이미 비어 있다(답이 풀려야 스트림이 끝난다). 중단된 턴에서만 일이 있다.
      this.abandonAsks("The turn ended before the question was answered.");
      this.seed.reportActivity(false);
    }
  }

  /**
   * 격리 dir에서 자란 트랜스크립트를 원 projects 디렉터리로 되쓴다. 우리 사본은 원본에서
   * 출발했으므로 길이가 원본 이상일 때만 덮어쓴다 — 외부에서 자란 원본을 지우지 않는 경계다.
   */
  private async writeBackTranscript(): Promise<void> {
    const sdk = this.sdk;
    // 세션 id가 없으면 되쓸 파일 이름조차 없다 — 첫 턴이 session_id 없이 끝난 경우다.
    if (!sdk || !this.latestSessionId) return;
    const sessionId = this.latestSessionId;
    const projectDirName = await this.resolveProjectDirName(sdk.configDir);
    if (!projectDirName) return;
    const source = path.join(sdk.configDir, "projects", projectDirName, `${sessionId}.jsonl`);
    const sourceStat = await fs.stat(source).catch(() => null);
    if (!sourceStat?.isFile()) return;
    const destDir = this.seed.origin.kind === "resume"
      ? path.dirname(this.seed.origin.transcriptPath)
      : path.join(this.seed.origin.transcriptRoot, projectDirName);
    const dest = path.join(destDir, `${sessionId}.jsonl`);
    const destStat = await fs.stat(dest).catch(() => null);
    if (destStat?.isFile() && destStat.size > sourceStat.size) return;
    // 복사가 실패하면 providerSession을 갱신하지 않는다 — 존재하지 않는 파일을 durable 권위로
    // 가리키면 터미널 복귀·재시작·Analyst가 조용히 턴을 잃는다. 실패는 저널로 표면화한다.
    try {
      // 채팅으로 태어난 세션은 이 디렉터리를 처음 만든다. resume 경로에서는 만들지 않는다 —
      // 그쪽에서 목적지가 사라졌다면 원본이 밖에서 치워진 것이고, 되살려 쓰는 것은 그 삭제를
      // 조용히 되돌리는 일이다. 실패를 저널로 표면화하는 기존 계약을 그대로 둔다.
      if (this.seed.origin.kind === "fresh") await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
      await fs.copyFile(source, dest);
    } catch {
      this.push({ kind: "error", code: "chat_writeback_failed" });
      return;
    }
    this.seed.onProviderSessionUpdate({
      provider: "claude",
      sessionId,
      transcriptPath: dest,
      source: "chat-mode",
      capturedAt: new Date().toISOString(),
    });
  }

  /**
   * 이 세션의 트랜스크립트가 앉은 projects 디렉터리 이름. resume은 원 경로가 이미 말해 주고,
   * fresh는 SDK가 자기 dir 안에 만든 이름을 읽는다 — cwd 인코딩 규칙을 재구현하지 않기 위해서다.
   * 격리 dir은 이 세션 전용이라 그 아래 projects 항목은 하나뿐이며, 여럿이면 무엇이 우리 것인지
   * 말할 수 없으므로 되쓰지 않는다(잘못된 뿌리에 남의 세션을 심는 것보다 낫다).
   */
  private async resolveProjectDirName(configDir: string): Promise<string | null> {
    if (this.seed.origin.kind === "resume") return path.basename(path.dirname(this.seed.origin.transcriptPath));
    const entries = await fs.readdir(path.join(configDir, "projects"), { withFileTypes: true }).catch(() => null);
    if (!entries) return null;
    const dirs = entries.filter((entry) => entry.isDirectory());
    return dirs.length === 1 ? dirs[0]?.name ?? null : null;
  }
}

export class AgentChatRegistry {
  private readonly sessions = new Map<string, AgentChatSession>();
  private readonly ensureFlights = new Map<string, Promise<AgentChatSession>>();
  /** dispose 진행 중 tombstone — 이 창에서의 ensure 재진입이 두 번째 필자를 만든다. */
  private readonly disposals = new Map<string, Promise<void>>();
  private readonly createSdk: CreateChatSdk;

  constructor(createSdk: CreateChatSdk = (options) => createClaudeGatewaySdk(options)) {
    this.createSdk = createSdk;
  }

  has(operationId: string): boolean {
    return this.sessions.has(operationId);
  }

  isBusy(operationId: string): boolean {
    return this.sessions.get(operationId)?.busy === true;
  }

  /** 세션이 없으면 만들고 트랜스크립트를 재생한다. 동시 진입은 한 생성으로 수렴한다. */
  async ensure(operationId: string, seed: () => AgentChatSessionSeed): Promise<AgentChatSession> {
    // dispose가 진행 중이면 새 세션을 만들지 않는다 — 터미널 복귀와 경합해 같은 Claude 세션의
    // 이중 필자가 되는 창이다. 호출자(스트림·메시지 라우트)는 chat_unavailable로 답한다.
    if (this.disposals.has(operationId)) throw new Error("chat_session_disposing");
    const existing = this.sessions.get(operationId);
    if (existing) return existing;
    const inFlight = this.ensureFlights.get(operationId);
    if (inFlight) return inFlight;
    const flight = (async () => {
      const session = new AgentChatSession(operationId, seed(), this.createSdk);
      await session.replayTranscript();
      this.sessions.set(operationId, session);
      return session;
    })().finally(() => {
      this.ensureFlights.delete(operationId);
    });
    this.ensureFlights.set(operationId, flight);
    return flight;
  }

  get(operationId: string): AgentChatSession | undefined {
    return this.sessions.get(operationId);
  }

  async dispose(operationId: string): Promise<void> {
    const pending = this.disposals.get(operationId);
    if (pending) return pending;
    // tombstone은 동기로 먼저 세운다 — 이후 도착하는 ensure는 전부 거부되고, 이미 in-flight인
    // 생성은 완주를 기다린 뒤 접는다. 그냥 돌아가면 DELETE가 터미널을 되살린 뒤에 pending
    // ensure가 chat 세션을 등록해 같은 Claude 세션의 이중 필자가 된다.
    const disposal = (async () => {
      const flight = this.ensureFlights.get(operationId);
      if (flight) await flight.then(() => undefined, () => undefined);
      const session = this.sessions.get(operationId);
      if (!session) return;
      this.sessions.delete(operationId);
      await session.dispose();
    })();
    this.disposals.set(operationId, disposal);
    try {
      await disposal;
    } finally {
      this.disposals.delete(operationId);
    }
  }

  async disposeAll(): Promise<void> {
    const operationIds = new Set([...this.sessions.keys(), ...this.ensureFlights.keys()]);
    await Promise.all([...operationIds].map((operationId) => this.dispose(operationId)));
  }
}
