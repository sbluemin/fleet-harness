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
  /**
   * 티켓 요청 본문. 생략하면 `{ operationId }` — Operation 경로의 지금까지 계약이다.
   * Theater 셸처럼 Operation이 없는 세션은 여기에 `{ theaterId }`를 실어 보낸다.
   */
  readonly ticketBody?: Readonly<Record<string, string>>;
  readonly terminal: TerminalLike;
  readonly ticketPath: string;
  readonly wsPath: string;
  /** 콘솔 테마 극성 — ticket 요청에 실려 spawn env COLORFGBG 힌트가 된다(최초 spawn 시점 고정). */
  readonly colorScheme?: "light" | "dark";
  readonly onStatus?: (status: TerminalConnectionStatus, message?: string) => void;
  /**
   * 제어를 되찾을 수 있는 상태인지 알린다. 원격이 제어를 쥐고 있어 서버가 관전으로 내려보낸
   * 경우에는 되찾기가 성립하지 않는다 — 그 자리는 Console의 회수 버튼이 맡는다.
   */
  readonly onControlLockChange?: (lock: TerminalControlLock) => void;
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

/** 관전 중인 화면이 되찾기를 제안해도 되는지. 서버가 등급을 잠갔으면 제안할 수 없다. */
export type TerminalControlLock = "open" | "locked";

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
 *
 * `failed`도 같은 이유로 `connecting`과 갈라져 있다. 재연결 루프는 성공할 때까지 멈추지 않으므로
 * 영원히 거절당하는 연결도 기술적으로는 "연결 중"이지만, 화면이 그렇게 말하면 사용자는 곧 될 일을
 * 기다리게 된다 — 스스로 풀어야 하는 상황일 때가 있다.
 */
export type TerminalConnectionStatus = "connecting" | "live" | "viewer" | "closed" | "failed";

/**
 * 서버가 거절 이유를 body에 실어 보내면 그 코드를 그대로 나른다. 상태 코드만 들고 오면
 * 화면에 숫자만 남고, 사용자가 무엇을 해야 하는지는 어디에도 없다.
 */
export class TerminalTicketError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "TerminalTicketError";
  }
}

const INITIAL_RECONNECT_DELAY_MS = 250;
/** 이 횟수만큼 연달아 실패해야 화면이 실패를 말한다 — 한 번의 끊김은 재연결이 조용히 삼킨다. */
const FAILURE_REPORT_THRESHOLD = 2;
const MAX_RECONNECT_DELAY_MS = 5_000;
const OPEN_READY_STATE = 1;
const TERMINAL_UNAVAILABLE_CLOSE_CODE = 1013;
const TERMINAL_REPLACED_CLOSE_CODE = 4000;
const TERMINAL_CLOSED_CLOSE_CODE = 4001;
/** 제어 보유자가 바뀌어 서버가 재협상을 요구한 닫힘. 등급을 비우고 다시 물어본다. */
const TERMINAL_CONTROL_CHANGED_CLOSE_CODE = 4002;

export function createTerminalConnection(options: TerminalConnectionOptions): TerminalConnection {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let socket: WebSocketLike | null = null;
  let inputSubscription: { readonly dispose: () => void } | null = null;
  let pendingSize: { readonly cols: number; readonly rows: number } | null = null;
  // 실제로 이 소켓으로 나간 마지막 격자. 연결마다 비워 (재)연결이 항상 한 번은 크기를 협상하게 한다 —
  // 새 소켓 너머의 세션이 어떤 크기를 알고 있는지는 클라이언트가 가정할 수 없다.
  let lastSentSize: { readonly cols: number; readonly rows: number } | null = null;
  let started = false;
  /**
   * 이 연결이 지금 요구하는 역할. 밀려나면(4000) control에서 viewer로 내려가고, 사용자가
   * 되찾겠다고 하면 control로 되돌린다 — 재접속 루프가 매 회 이 값으로 티켓을 받는다.
   */
  let role: TerminalSocketRole = "control";
  /** 연속 실패 횟수. 성공한 연결마다 0으로 돌아간다. */
  let consecutiveFailures = 0;

  const disposeInput = () => {
    inputSubscription?.dispose();
    inputSubscription = null;
  };

  const sendResize = (cols: number, rows: number) => {
    pendingSize = { cols, rows };
    if (role === "viewer") return;
    if (socket?.readyState !== OPEN_READY_STATE) return;
    // 같은 격자를 다시 보내지 않는다. 서버는 프레임을 그대로 pty.resize로 넘기고, 그 SIGWINCH는
    // 전체 화면 TUI의 프레임 전체 재렌더를 부른다 — 격자가 그대로면 그 재도색은 순수 낭비이자
    // 눈에 보이는 깜빡임이다. 상자가 한 셀보다 작게 움직이는 미세 드래그·창 크기 조정이 이 경로다.
    if (lastSentSize && lastSentSize.cols === cols && lastSentSize.rows === rows) return;
    lastSentSize = { cols, rows };
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
  };

  const connectLoop = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      if (consecutiveFailures === 0) options.onStatus?.("connecting");
      try {
        const requested = role;
        const { ticket, role: granted } = await requestTerminalTicket(options.ticketPath, options.ticketBody ?? { operationId: options.operationId }, abort.signal, options.colorScheme, requested);
        if (abort.signal.aborted) return;
        // 요청한 등급과 받은 등급이 갈리면 서버가 내려보낸 것이다 — 그 상태에서는 되찾기를 제안하지 않는다.
        role = granted;
        options.onControlLockChange?.(requested === "control" && granted === "viewer" ? "locked" : "open");
        await attachSocket(buildTerminalWsUrl(ticket, options.location, options.wsPath), options);
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      } catch (err) {
        if (abort.signal.aborted) return;
        consecutiveFailures += 1;
        // 첫 실패는 곧 이어지는 재연결이 삼키는 흔한 경우라 화면을 바꾸지 않는다. 두 번째부터는
        // 기다리면 풀릴 일이 아닐 수 있으므로 이유를 내보낸다 — 거절이 영구적인 경우가 이 경로다.
        const code = err instanceof TerminalTicketError ? err.code : err instanceof Error ? err.message : String(err);
        if (consecutiveFailures >= FAILURE_REPORT_THRESHOLD) options.onStatus?.("failed", code);
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
        // 티켓 발급이 아니라 소켓이 열린 것이 "연결 성공"이다. 발급 시점에 되돌리면, 티켓은
        // 매번 나오는데 업그레이드만 막히는 환경에서 카운터가 0과 1을 오가며 임계값에 닿지
        // 못해 화면이 영영 연결 중에 머문다.
        consecutiveFailures = 0;
        connectionOptions.onStatus?.(role === "viewer" ? "viewer" : "live");
        // 새 소켓은 크기 이력을 물려받지 않는다 — 비워야 아래 협상이 dedupe에 걸리지 않는다.
        lastSentSize = null;
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
        } else if (code === TERMINAL_CONTROL_CHANGED_CLOSE_CODE) {
          /**
           * 보유자가 바뀌었다. 지금 들고 있던 등급은 옛 사실에 대한 답이므로 버리고 control로
           * 되물어본다 — 승격이든 강등이든 판정은 서버가 하고, 이 자리에서 방향을 알 필요가 없다.
           */
          role = "control";
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

async function requestTerminalTicket(ticketPath: string, identity: Readonly<Record<string, string>>, signal: AbortSignal, colorScheme?: "light" | "dark", role?: TerminalSocketRole): Promise<{ readonly ticket: string; readonly ttlMs: number; readonly role: TerminalSocketRole }> {
  const response = await fetch(ticketPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // control은 서버 기본값이라 싣지 않는다 — 옛 서버에 붙어도 같은 요청이 된다.
    body: JSON.stringify({ ...identity, ...(colorScheme ? { colorScheme } : {}), ...(role === "viewer" ? { role } : {}) }),
    signal,
  });
  if (!response.ok) throw new TerminalTicketError(await readTicketErrorCode(response), response.status);
  const payload = await response.json() as { readonly ticket?: unknown; readonly ttlMs?: unknown; readonly role?: unknown };
  if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") {
    throw new Error("Invalid terminal ticket response");
  }
  // 옛 서버는 등급을 싣지 않는다. 그때는 요청한 대로 받은 것으로 본다.
  return { ticket: payload.ticket, ttlMs: payload.ttlMs, role: payload.role === "viewer" ? "viewer" : (role ?? "control") };
}

async function readTicketErrorCode(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { readonly error?: unknown };
    if (typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    // body가 JSON이 아니면 상태 코드만 남는다 — 그래도 숫자를 코드 자리에 넣어 두어야
    // 아래 매핑이 "모르는 이유"로 떨어질 수 있다.
  }
  return `http_${response.status}`;
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
