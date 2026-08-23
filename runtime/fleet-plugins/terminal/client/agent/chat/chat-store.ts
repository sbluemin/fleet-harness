import { React } from "@fleet-console/sdk/plugin/browser";

import { TerminalTicketError, buildTerminalWsUrl } from "../../shared/terminal-connection.js";
import { initialAgentChatLogState, readChatJournalEvent, reduceAgentChatLog, type AgentChatLogState } from "./chat-events.js";

export type AgentChatConnection = "connecting" | "open" | "lost" | "idle";

export interface AgentChatAnswerCommand {
  readonly askId: string;
  readonly answers?: readonly string[];
  readonly approve?: boolean;
  readonly message?: string;
}

export interface AgentChatViewState extends AgentChatLogState {
  readonly connection: AgentChatConnection;
  readonly stopTurn: () => Promise<void>;
  /** 아직 시작하지 않은 예약 지시 하나를 거둔다. 이미 시작했으면 서버가 거절한다. */
  readonly cancelQueued: (queueId: string) => Promise<void>;
  readonly answerAsk: (body: AgentChatAnswerCommand) => Promise<void>;
}

const CHAT_TICKET_PATH = "/plugins/terminal/agent/ticket";
const CHAT_WS_PATH = "/plugins/terminal/ws";
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
const OPEN_READY_STATE = 1;
const COMMAND_WAIT_MS = 8_000;

/**
 * Operation 하나의 채팅 소켓.
 *
 * PTY와 같은 수명이다: 티켓 POST → `/plugins/terminal/ws` upgrade → 저널 리플레이.
 * `live`가 false면 소켓을 열지 않는다. 본문 풀이 주차·최소화·숨김 본문을 살려 두므로,
 * 그때도 구독하면 화면 밖 패널마다 소켓을 하나씩 점유한다. 덱 타일은 본문이
 * 그려지므로 live로 남긴다.
 */
export function useAgentChatStream(operationId: string, live = true): AgentChatViewState {
  const [connection, setConnection] = React.useState<AgentChatConnection>(live ? "connecting" : "idle");
  const [log, setLog] = React.useState<AgentChatLogState>(initialAgentChatLogState);
  const sessionRef = React.useRef<ChatSocketSession | null>(null);

  React.useEffect(() => {
    if (!live) {
      setConnection("idle");
      sessionRef.current = null;
      return;
    }
    setConnection("connecting");
    setLog(initialAgentChatLogState);
    const session = createChatSocketSession({
      operationId,
      onConnection: (next) => {
        // 서버는 접속마다 보유 저널을 처음부터 되쓴다. 채팅 출생은 replay-start를 남기지
        // 않고, JOURNAL_CAP에 걸린 세션은 그 마커가 앞에서 잘린다. 열릴 때 비우지 않으면
        // 재접속 리플레이가 남은 턴·잡·질문 카드 위에 겹친다(옛 EventSource onopen과 같은 자리).
        if (next === "open") {
          // 화면 로그는 snapshot으로 다시 쓰되, 서버가 준 누적 턴 좌표는 재접속 전 값을 보존한다.
          // 저널 상한으로 과거 행이 잘려도 이 좌표와 새 snapshot-end의 차이는 단조다.
          setLog((current) => ({ ...initialAgentChatLogState, observedTurns: current.observedTurns }));
        }
        setConnection(next);
      },
      onEvent: (raw) => {
        const entry = readChatJournalEvent(raw);
        if (!entry) return;
        setLog((current) => reduceAgentChatLog(current, entry.event));
      },
    });
    sessionRef.current = session;
    session.start();
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [operationId, live]);

  const stopTurn = React.useCallback(async () => {
    await sessionRef.current?.send({ type: "stop" });
  }, []);
  const cancelQueued = React.useCallback(async (queueId: string) => {
    await sessionRef.current?.send({ type: "cancel-queued", queueId });
  }, []);
  const answerAsk = React.useCallback(async (body: AgentChatAnswerCommand) => {
    await sessionRef.current?.send({ type: "answer", ...body });
  }, []);

  return React.useMemo(
    () => ({ ...log, connection, stopTurn, cancelQueued, answerAsk }),
    [log, connection, stopTurn, cancelQueued, answerAsk],
  );
}

interface ChatSocketSession {
  start(): void;
  send(command: ChatOutboundCommand): Promise<void>;
  dispose(): void;
}

type ChatOutboundCommand =
  | { readonly type: "stop" }
  | { readonly type: "cancel-queued"; readonly queueId: string }
  | { readonly type: "answer"; readonly askId: string; readonly answers?: readonly string[]; readonly approve?: boolean; readonly message?: string };

interface ChatSocketSessionOptions {
  readonly operationId: string;
  readonly onConnection: (connection: AgentChatConnection) => void;
  readonly onEvent: (raw: string) => void;
  readonly location?: Pick<Location, "host" | "protocol">;
  readonly webSocketFactory?: (url: string) => ChatWebSocketLike;
  readonly fetchImpl?: typeof fetch;
}

export interface ChatWebSocketLike {
  readonly readyState: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: string | ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

function createChatSocketSession(options: ChatSocketSessionOptions): ChatSocketSession {
  const abort = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let socket: ChatWebSocketLike | null = null;
  let commandSeq = 0;
  const pending = new Map<string, { readonly resolve: () => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();

  const rejectPending = (error: Error): void => {
    for (const wait of pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(error);
    }
    pending.clear();
  };

  const attach = async (url: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const ws = (options.webSocketFactory ?? defaultChatWebSocketFactory)(url);
      socket = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        options.onConnection("open");
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          const frame = parsed as { readonly type?: unknown; readonly id?: unknown; readonly error?: unknown };
          if ((frame.type === "ok" || frame.type === "nack") && typeof frame.id === "string") {
            const wait = pending.get(frame.id);
            if (!wait) return;
            pending.delete(frame.id);
            clearTimeout(wait.timer);
            if (frame.type === "ok") wait.resolve();
            else wait.reject(new Error(typeof frame.error === "string" ? frame.error : "chat_command_failed"));
            return;
          }
        }
        options.onEvent(event.data);
      };
      ws.onerror = () => {
        if (!opened) reject(new Error("chat_socket_error"));
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        rejectPending(new Error("chat_socket_closed"));
        if (opened) resolve();
        else reject(new Error("chat_socket_closed"));
      };
    });
  };

  const connectLoop = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      options.onConnection("connecting");
      try {
        const ticket = await requestChatTicket(options.operationId, abort.signal, fetchImpl);
        if (abort.signal.aborted) return;
        await attach(buildTerminalWsUrl(ticket, options.location, CHAT_WS_PATH));
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      } catch {
        if (abort.signal.aborted) return;
        options.onConnection("lost");
      }
      if (abort.signal.aborted) return;
      await delay(reconnectDelay, abort.signal);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  };

  return {
    start: () => {
      void connectLoop();
    },
    send: (command) => {
      const ws = socket;
      if (!ws || ws.readyState !== OPEN_READY_STATE) return Promise.reject(new Error("chat_not_connected"));
      const id = `c${++commandSeq}`;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("chat_command_timeout"));
        }, COMMAND_WAIT_MS);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, ...command }));
      });
    },
    dispose: () => {
      abort.abort();
      rejectPending(new Error("chat_socket_closed"));
      socket?.close();
      socket = null;
    },
  };
}

async function requestChatTicket(operationId: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(CHAT_TICKET_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, channel: "chat" }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new TerminalTicketError(typeof payload?.error === "string" ? payload.error : `http_${response.status}`, response.status);
  }
  const payload = await response.json() as { readonly ticket?: unknown };
  if (typeof payload.ticket !== "string") throw new Error("Invalid chat ticket response");
  return payload.ticket;
}

function defaultChatWebSocketFactory(url: string): ChatWebSocketLike {
  return new WebSocket(url) as unknown as ChatWebSocketLike;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}
