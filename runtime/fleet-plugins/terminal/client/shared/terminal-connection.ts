/**
 * 소켓 역할. 서버의 같은 이름 타입과 값이 일치해야 하지만 타입을 건너 들여오지는 않는다 —
 * 브라우저 코드가 서버 모듈을 참조하기 시작하면 그 경계는 조용히 사라진다. 서버는
 * `readSocketRole`에서 "viewer" 외의 값을 전부 control로 떨어뜨리므로 오타는 여기서 끝난다.
 */
export type TerminalSocketRole = "control" | "viewer";

export interface TerminalLike {
  readonly onData: (listener: (data: string) => void) => { readonly dispose: () => void };
  readonly write: (data: Uint8Array) => void;
  readonly drain: (callback: () => void) => void;
}

export interface TerminalConnectionOptions {
  readonly operationId: string;
  readonly terminal: TerminalLike;
  readonly ticketPath: string;
  readonly wsPath: string;
  /** 콘솔 테마 극성 — ticket 요청에 실려 spawn env COLORFGBG 힌트가 된다(최초 spawn 시점 고정). */
  readonly colorScheme?: "light" | "dark";
  readonly onStatus?: (status: TerminalConnectionStatus, message?: string) => void;
  /**
   * 서버 보유 scrollback을 재생하는 구간의 시작(true)과 끝(false)을 알린다. 재생 청크는 과거에 이미
   * 흘러간 바이트라, 그 안의 부수효과 시퀀스를 지금 다시 실행하면 안 되는 소비자를 위한 신호다.
   */
  readonly onReplayStateChange?: (replaying: boolean) => void;
  readonly onExit?: () => void;
  readonly location?: Pick<Location, "host" | "protocol">;
  readonly webSocketFactory?: (url: string) => WebSocketLike;
}

export interface TerminalCloseInfo {
  readonly code?: number;
}

export interface TerminalConnection {
  readonly start: () => void;
  readonly resize: (cols: number, rows: number) => void;
  /** 관전 중인 소켓을 끊고 제어로 다시 붙는다. 지금 몰고 있는 소켓은 밀려난다. */
  readonly takeBackControl: () => void;
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

/**
 * `viewer`는 붙어 있고 출력도 흐르지만 입력이 가지 않는 상태다. `live`와 갈라 두는 이유는
 * 화면이 그 차이를 말해야 하기 때문이다 — 반응 없는 키보드를 연결 문제로 읽게 두면 안 된다.
 */
export type TerminalConnectionStatus = "connecting" | "live" | "viewer" | "closed";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
const OPEN_READY_STATE = 1;
const TERMINAL_UNAVAILABLE_CLOSE_CODE = 1013;
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
  /**
   * 이 연결이 지금 요구하는 역할. 밀려나면(4000) control에서 viewer로 내려가고, 사용자가
   * 되찾겠다고 하면 control로 되돌린다 — 재접속 루프가 매 회 이 값으로 티켓을 받는다.
   */
  let role: TerminalSocketRole = "control";

  const disposeInput = () => {
    inputSubscription?.dispose();
    inputSubscription = null;
  };

  const sendResize = (cols: number, rows: number) => {
    pendingSize = { cols, rows };
    if (role === "viewer") return;
    if (socket?.readyState === OPEN_READY_STATE) {
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  };

  const connectLoop = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      options.onStatus?.("connecting");
      try {
        const { ticket } = await requestTerminalTicket(options.ticketPath, options.operationId, abort.signal, options.colorScheme, role);
        if (abort.signal.aborted) return;
        await attachSocket(buildTerminalWsUrl(ticket, options.location, options.wsPath), options);
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
    // 모든 (재)연결은 서버 attach에서 scrollback 재생으로 시작한다 — 재생 종료는 replay_end가 알린다.
    connectionOptions.onReplayStateChange?.(true);
    await new Promise<void>((resolve, reject) => {
      const ws = (connectionOptions.webSocketFactory ?? defaultWebSocketFactory)(url);
      socket = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        connectionOptions.onStatus?.(role === "viewer" ? "viewer" : "live");
        // 관전자는 PTY 크기를 협상하지 않는다 — 보는 사람의 창이 모는 사람의 터미널을 흔들면 안 된다.
        if (role !== "viewer" && pendingSize) sendResize(pendingSize.cols, pendingSize.rows);
      };
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          connectionOptions.terminal.write(new Uint8Array(event.data));
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!isReplayEndFrame(frame)) return;
        connectionOptions.terminal.drain(() => {
          // 이 소켓이 아직 활성일 때만 재생 구간을 닫는다. drain은 출력 파싱을 기다리므로 소켓이 먼저
          // 닫히고 재접속이 새 재생을 시작한 뒤에 이 콜백이 도착할 수 있는데, 그때 창을 닫아버리면
          // 새 연결의 재생분이 클립보드를 덮는다. 다른 소켓이 주인이면 그 소켓이 자기 창을 닫는다.
          if (socket !== ws) return;
          // 재생 바이트가 모두 파싱된 뒤다. 아래 입력 구독 조건과 무관하게 창은 닫는다.
          connectionOptions.onReplayStateChange?.(false);
          // 입력 구독 자체를 만들지 않는 것이 관전의 실제 경계다. 서버도 viewer 소켓의 메시지를
          // 듣지 않지만, 보내지 않는 편이 화면과 전송을 같은 이야기로 만든다.
          if (role === "viewer") return;
          if (ws.readyState !== OPEN_READY_STATE || inputSubscription) return;
          disposeInput();
          inputSubscription = connectionOptions.terminal.onData((data) => {
            if (ws.readyState === OPEN_READY_STATE) ws.send(encoder.encode(data));
          });
        });
      };
      ws.onerror = () => {
        reject(new Error("Terminal WebSocket error"));
      };
      ws.onclose = (event) => {
        disposeInput();
        if (socket === ws) socket = null;
        const code = event?.code;
        if (code === TERMINAL_REPLACED_CLOSE_CODE) {
          /**
           * 밀려났다고 해서 볼 자격까지 잃는 것은 아니다. 예전에는 여기서 재접속을 영구 포기해
           * 화면에 `closed: terminal_replaced`만 남았는데, 그것은 터미널이 죽은 것인지 사람이
           * 가져간 것인지 구분해 주지 않는 문자열이었다.
           *
           * 역할만 내려놓고 루프는 계속 돈다 — 곧바로 관전자로 다시 붙어 같은 출력을 본다.
           */
          role = "viewer";
          connectionOptions.onStatus?.("connecting");
        } else if (code === TERMINAL_CLOSED_CLOSE_CODE) {
          abort.abort();
          connectionOptions.onStatus?.("closed", "terminal_closed");
          connectionOptions.onExit?.();
        } else if (code === TERMINAL_UNAVAILABLE_CLOSE_CODE) {
          abort.abort();
          connectionOptions.onStatus?.("closed", "terminal_unavailable");
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
    takeBackControl: () => {
      if (role === "control") return;
      role = "control";
      // 소켓을 닫으면 연결 루프가 다음 회차를 control 티켓으로 받는다.
      socket?.close();
    },
    dispose: () => {
      abort.abort();
      disposeInput();
      options.onStatus?.("closed");
      socket?.close();
      socket = null;
    },
  };
}

export function buildTerminalWsUrl(ticket: string, targetLocation: Pick<Location, "host" | "protocol"> = window.location, pathname: string): string {
  const protocol = targetLocation.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${targetLocation.host}${pathname}?ticket=${encodeURIComponent(ticket)}`;
}

async function requestTerminalTicket(ticketPath: string, operationId: string, signal: AbortSignal, colorScheme?: "light" | "dark", role?: TerminalSocketRole): Promise<{ readonly ticket: string; readonly ttlMs: number }> {
  const response = await fetch(ticketPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // control은 서버 기본값이라 싣지 않는다 — 옛 서버에 붙어도 같은 요청이 된다.
    body: JSON.stringify({ operationId, ...(colorScheme ? { colorScheme } : {}), ...(role === "viewer" ? { role } : {}) }),
    signal,
  });
  if (!response.ok) throw new Error(`Terminal ticket request failed: ${response.status}`);
  const payload = await response.json() as { readonly ticket?: unknown; readonly ttlMs?: unknown };
  if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") {
    throw new Error("Invalid terminal ticket response");
  }
  return { ticket: payload.ticket, ttlMs: payload.ttlMs };
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function isReplayEndFrame(value: unknown): value is { readonly type: "replay_end" } {
  return !!value && typeof value === "object" && (value as { readonly type?: unknown }).type === "replay_end";
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
