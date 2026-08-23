import type { TerminalSocket, TerminalSocketData } from "../shared/terminal-types.js";

import type { AgentChatAnswerInput, AgentChatAnswerResult } from "./chat-session.js";
import type { AgentChatJournalEvent } from "./chat-events.js";

const MAX_CHAT_ANSWER_MESSAGE_CHARS = 2_000;
const CHAT_UNAVAILABLE_CLOSE_CODE = 1013;

export interface AgentChatSocketSession {
  subscribe(listener: (entry: AgentChatJournalEvent) => void): () => void;
  stopTurn(): boolean;
  cancelQueued(queueId: string): boolean;
  answer(id: string, input: AgentChatAnswerInput): AgentChatAnswerResult;
}

/**
 * 채팅 티켓이 연 소켓 하나. 저널은 내려가고, 뷰의 중지·답만 올라온다.
 * 새 턴을 넣는 message는 이 소켓에 없다 — Quick Launch HTTP가 그 자리다.
 */
export function attachAgentChatSocket(
  socket: TerminalSocket,
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
  socket.on("message", (data, isBinary) => {
    if (closed || isBinary || !session) return;
    const command = readChatSocketCommand(decodeSocketText(data));
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
    if ("error" in ready) {
      sendJson(socket, { seq: 0, event: { kind: "error", code: ready.error } });
      socket.close(CHAT_UNAVAILABLE_CLOSE_CODE, ready.error);
      return;
    }
    session = ready;
    unsubscribe = ready.subscribe((entry) => {
      if (!closed) sendJson(socket, entry);
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
