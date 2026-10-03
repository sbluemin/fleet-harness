import type { RequestLifetime } from "../context.js";
import type { TerminalSocket, TerminalSocketData } from "../terminal/terminal-types.js";

import type { AgentChatAnswerInput, AgentChatAnswerResult } from "./chat-session.js";
import type { AgentChatJournalEvent } from "./chat-events.js";

const MAX_CHAT_ANSWER_MESSAGE_CHARS = 2_000;
const CHAT_UNAVAILABLE_CLOSE_CODE = 1013;
/** 이 소켓을 연 접속(원격 세션)이 끝났다. 터미널 소켓의 4000번대 닫힘 코드와 같은 계열이다. */
const CHAT_SESSION_ENDED_CLOSE_CODE = 4003;

export interface AgentChatSocketSession {
  subscribe(listener: (entry: AgentChatJournalEvent) => void): () => void;
  stopTurn(): boolean;
  cancelQueued(queueId: string): boolean;
  answer(id: string, input: AgentChatAnswerInput): AgentChatAnswerResult;
}

/**
 * 채팅 티켓이 연 소켓 하나. 저널은 내려가고, 뷰의 중지·답만 올라온다.
 * 새 턴을 넣는 message는 이 소켓에 없다 — Quick Launch HTTP가 그 자리다.
 *
 * 입장 판정은 소켓을 열 때 한 번뿐이다. 그 접속이 회수·대체·언페어링·만료로 끝난 뒤에도 소켓이
 * 남아 있으면 끝난 기기가 승인·중지·대기 취소를 보낼 수 있으므로, 명령과 저널마다 `lifetime`을
 * 다시 묻고 끝났으면 거절하고 닫는다. 서버가 세션 종료 때 소켓을 직접 파기하는 것과는 별개의 방어다.
 */
export function attachAgentChatSocket(
  socket: TerminalSocket,
  lifetime: RequestLifetime,
  start: () => Promise<AgentChatSocketSession | { readonly error: string }>,
): void {
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let session: AgentChatSocketSession | null = null;
  socket.once("close", () => {
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    session = null;
  });
  const endForSession = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    session = null;
    socket.close(CHAT_SESSION_ENDED_CLOSE_CODE, "session_ended");
  };
  socket.on("message", (data, isBinary) => {
    if (closed || isBinary) return;
    const command = readChatSocketCommand(decodeSocketText(data));
    // 명령은 사람의 활동이라 유휴 수명을 민다(터미널 입력은 밀지 않는다 — 채팅은 HTTP 없이 승인만 이어 가는 화면이다).
    const live = command ? lifetime.touch() : lifetime.isLive();
    if (!live) {
      const id = command?.id ?? commandId(data);
      sendJson(socket, { type: "nack", error: "session_ended", ...(id ? { id } : {}) });
      endForSession();
      return;
    }
    if (!session) return;
    if (!command) {
      sendJson(socket, { type: "nack", error: "invalid_command", ...(commandId(data) ? { id: commandId(data) } : {}) });
      return;
    }
    if (command.type === "stop") {
      if (!session.stopTurn()) {
        sendJson(socket, { type: "nack", id: command.id, error: "chat_idle" });
        return;
      }
      sendJson(socket, { type: "ok", id: command.id });
      return;
    }
    if (command.type === "cancel-queued") {
      // 거둘 것이 없으면 거절한다 — 그 사이 자기 차례가 와 이미 시작한 지시이며, 그것을 ok로
      // 답하면 화면은 칩을 지우고 사용자는 취소되지 않은 턴을 취소된 것으로 읽는다.
      if (!session.cancelQueued(command.queueId)) {
        sendJson(socket, { type: "nack", id: command.id, error: "queue_not_found" });
        return;
      }
      sendJson(socket, { type: "ok", id: command.id });
      return;
    }
    const result = session.answer(command.askId, {
      ...(command.answers ? { answers: command.answers } : {}),
      ...(command.approve === true ? { approve: true } : {}),
      ...(command.message !== undefined ? { message: command.message.slice(0, MAX_CHAT_ANSWER_MESSAGE_CHARS) } : {}),
    });
    if (!result.ok) {
      sendJson(socket, { type: "nack", id: command.id, error: result.error });
      return;
    }
    sendJson(socket, { type: "ok", id: command.id });
  });
  void start().then((ready) => {
    if (closed) return;
    if (!lifetime.isLive()) { endForSession(); return; }
    if ("error" in ready) {
      sendJson(socket, { seq: 0, event: { kind: "error", code: ready.error } });
      socket.close(CHAT_UNAVAILABLE_CLOSE_CODE, ready.error);
      return;
    }
    session = ready;
    unsubscribe = ready.subscribe((entry) => {
      if (closed) return;
      // 끝난 접속에는 저널도 내려보내지 않는다. 이 판정은 유휴 수명을 늘리지 않는다.
      if (!lifetime.isLive()) { endForSession(); return; }
      sendJson(socket, entry);
    });
  }).catch(() => {
    if (closed) return;
    sendJson(socket, { seq: 0, event: { kind: "error", code: "chat_unavailable" } });
    socket.close(CHAT_UNAVAILABLE_CLOSE_CODE, "chat_unavailable");
  });
}

function sendJson(socket: TerminalSocket, value: unknown): void {
  if (socket.readyState !== 1) return;
  socket.send(Buffer.from(JSON.stringify(value), "utf8"), { binary: false });
}

function decodeSocketText(data: TerminalSocketData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function commandId(data: TerminalSocketData): string | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeSocketText(data));
    if (parsed && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string") {
      return (parsed as { id: string }).id;
    }
  } catch {
    // ignore
  }
  return undefined;
}

type ChatSocketCommand =
  | { readonly type: "stop"; readonly id: string }
  | { readonly type: "cancel-queued"; readonly id: string; readonly queueId: string }
  | {
      readonly type: "answer";
      readonly id: string;
      readonly askId: string;
      readonly answers?: readonly string[];
      readonly approve?: boolean;
      readonly message?: string;
    };

function readChatSocketCommand(raw: string): ChatSocketCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as {
    readonly type?: unknown;
    readonly id?: unknown;
    readonly queueId?: unknown;
    readonly askId?: unknown;
    readonly answers?: unknown;
    readonly approve?: unknown;
    readonly message?: unknown;
  };
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (value.type === "stop") return { type: "stop", id: value.id };
  if (value.type === "cancel-queued") {
    if (typeof value.queueId !== "string" || value.queueId.length === 0) return null;
    return { type: "cancel-queued", id: value.id, queueId: value.queueId };
  }
  if (value.type !== "answer" || typeof value.askId !== "string" || value.askId.length === 0) return null;
  const answers = Array.isArray(value.answers)
    ? value.answers.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  if (Array.isArray(value.answers) && answers?.length !== value.answers.length) return null;
  return {
    type: "answer",
    id: value.id,
    askId: value.askId,
    ...(answers ? { answers } : {}),
    ...(value.approve === true ? { approve: true } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}
