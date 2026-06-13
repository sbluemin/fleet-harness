import { requestTerminalTicket } from "./api.js";

export interface TerminalLike {
  readonly onData: (listener: (data: string) => void) => { readonly dispose: () => void };
  readonly write: (data: Uint8Array) => void;
}

export interface TerminalConnectionOptions {
  readonly sessionId: string;
  readonly kind?: "shell";
  readonly terminal: TerminalLike;
  readonly onStatus?: (status: TerminalConnectionStatus, message?: string) => void;
  // 서버가 세션을 종료(PTY exit 등)해 재연결이 의미 없을 때 호출된다.
  readonly onExit?: () => void;
  readonly fetchTicket?: typeof requestTerminalTicket;
  readonly location?: Pick<Location, "host" | "protocol">;
  readonly webSocketFactory?: (url: string) => WebSocketLike;
}

export interface TerminalCloseInfo {
  readonly code?: number;
}

export interface TerminalConnection {
  readonly start: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly dispose: () => void;
}

export interface WebSocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  readonly send: (data: string | Uint8Array) => void;
  readonly close: () => void;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent<ArrayBuffer | string>) => void) | null;
  onclose: ((event: TerminalCloseInfo) => void) | null;
  onerror: (() => void) | null;
}

export type TerminalConnectionStatus = "connecting" | "live" | "closed";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
const OPEN_READY_STATE = 1;
// 서버가 세션을 의도적으로 닫을 때 쓰는 WS close 코드 — 받으면 재연결하지 않는다.
const TERMINAL_REPLACED_CLOSE_CODE = 4000;
const TERMINAL_CLOSED_CLOSE_CODE = 4001;

export function createTerminalConnection(options: TerminalConnectionOptions): TerminalConnection {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let socket: WebSocketLike | null = null;
  let inputSubscription: { readonly dispose: () => void } | null = null;
  let pendingSize: { readonly cols: number; readonly rows: number } | null = null;
  let started = false;

  const disposeInput = () => {
    inputSubscription?.dispose();
    inputSubscription = null;
  };

  const sendResize = (cols: number, rows: number) => {
    pendingSize = { cols, rows };
    if (socket?.readyState === OPEN_READY_STATE) {
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  };

  const connectLoop = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      options.onStatus?.("connecting");
      try {
        const fetchTicket = options.fetchTicket ?? requestTerminalTicket;
        const { ticket } = await fetchTicket(options.sessionId, { kind: options.kind, signal: abort.signal });
        if (abort.signal.aborted) return;
        await attachSocket(buildTerminalWsUrl(ticket, options.location), options);
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      } catch (err) {
        if (abort.signal.aborted) return;
        options.onStatus?.("connecting", err instanceof Error ? err.message : String(err));
      }
      await delay(reconnectDelay, abort.signal);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  };

  const attachSocket = async (url: string, connectionOptions: TerminalConnectionOptions): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const ws = (connectionOptions.webSocketFactory ?? defaultWebSocketFactory)(url);
      socket = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        connectionOptions.onStatus?.("live");
        disposeInput();
        inputSubscription = connectionOptions.terminal.onData((data) => {
          if (ws.readyState === OPEN_READY_STATE) ws.send(encoder.encode(data));
        });
        if (pendingSize) sendResize(pendingSize.cols, pendingSize.rows);
      };
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          connectionOptions.terminal.write(new Uint8Array(event.data));
        }
      };
      ws.onerror = () => {
        reject(new Error("Terminal WebSocket error"));
      };
      ws.onclose = (event) => {
        disposeInput();
        if (socket === ws) socket = null;
        const code = event?.code;
        if (code === TERMINAL_REPLACED_CLOSE_CODE) {
          // 다른 소켓이 이 세션을 인계받음 — 이 연결은 재연결하지 않는다.
          abort.abort();
        } else if (code === TERMINAL_CLOSED_CLOSE_CODE) {
          // 서버가 세션을 종료(PTY 종료 등) — 재연결을 멈추고 종료를 통지한다.
          abort.abort();
          connectionOptions.onExit?.();
        }
        resolve();
      };
    });
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      void connectLoop();
    },
    resize: sendResize,
    dispose: () => {
      abort.abort();
      disposeInput();
      options.onStatus?.("closed");
      socket?.close();
      socket = null;
    },
  };
}

export function buildTerminalWsUrl(ticket: string, targetLocation: Pick<Location, "host" | "protocol"> = window.location): string {
  const protocol = targetLocation.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${targetLocation.host}/terminal/ws?ticket=${encodeURIComponent(ticket)}`;
}

// 브라우저 WebSocket을 테스트 seam 타입(WebSocketLike)으로 좁히는 기본 팩토리.
// 실제 WebSocket은 핸들러 시그니처가 더 넓어 구조적으로 직접 대입되지 않으므로 이 한 곳에서만 캐스트한다.
function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
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
