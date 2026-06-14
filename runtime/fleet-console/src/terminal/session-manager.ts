import type { CliMessagePolicy } from "@dotobokuri/fleet-admiral";

import { startTerminalShell, type TerminalLaunchResolver } from "./launch.js";
import type { TerminalPtyHandle, TerminalSessionManager, TerminalSocket, TerminalSocketData, TerminalTicketContext } from "./types.js";

export interface TerminalSessionManagerDeps {
  readonly launch: TerminalLaunchResolver;
  readonly startShell?: typeof startTerminalShell;
  // DI 계약 유지용으로 받지만 더 이상 동시 세션 상한을 강제하지 않는다(상한 해제됨).
  readonly maxSessions?: number;
  readonly scrollbackLimit?: number;
  // PTY가 종료되거나 세션이 정리될 때(멱등) 정확히 한 번 호출 — 콘솔 세션 목록 정리에 쓰인다.
  readonly onSessionExit?: (sessionId: string) => void;
}

interface TerminalSession {
  readonly id: string;
  readonly pty: TerminalPtyHandle;
  readonly disposables: { dispose(): void }[];
  readonly scrollback: Buffer[];
  readonly cleanup?: () => void | Promise<void>;
  readonly messagePolicy?: CliMessagePolicy;
  activeSocket: TerminalSocket | null;
  cols: number;
  rows: number;
}

interface KillSessionOptions {
  readonly killPty?: boolean;
}

const DEFAULT_TERMINAL_SESSION_ID = "default";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK_LIMIT = 512;
const WS_OPEN_STATE = 1;

export function createTerminalSessionManager(deps: TerminalSessionManagerDeps): TerminalSessionManager {
  const startShell = deps.startShell ?? startTerminalShell;
  const scrollbackLimit = deps.scrollbackLimit ?? DEFAULT_SCROLLBACK_LIMIT;
  const sessions = new Map<string, TerminalSession>();
  const pendingSessions = new Map<string, Promise<TerminalSession>>();

  function canAttach(): boolean {
    // 동시 세션 상한이 제거되어 항상 새 세션 부착을 허용한다.
    return true;
  }

  async function attach(socket: TerminalSocket, context: TerminalTicketContext): Promise<void> {
    const session = await getOrCreateSession(context);
    if (session.activeSocket && session.activeSocket !== socket) {
      session.activeSocket.close(4000, "terminal_replaced");
    }
    session.activeSocket = socket;
    session.pty.resize(session.cols, session.rows);
    replayScrollback(session, socket);
    socket.on("message", (data, isBinary) => handleSocketMessage(session, data, isBinary));
    socket.once("close", () => detachSocket(session, socket));
  }

  async function createSession(context: TerminalTicketContext): Promise<void> {
    await getOrCreateSession(context);
  }

  function terminate(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    // PTY 자식까지 죽이고(removeSession 기본 killPty: true) onSessionExit로 콘솔 세션 목록을 정리한다.
    removeSession(session);
    return true;
  }

  function getSessionMessagePolicy(sessionId: string): CliMessagePolicy | undefined {
    return sessions.get(sessionId)?.messagePolicy;
  }

  function writeToSession(sessionId: string, data: string): boolean {
    const session = sessions.get(sessionId);
    if (!session || typeof session.pty.write !== "function") return false;
    try {
      session.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  async function stop(): Promise<void> {
    const pending = [...pendingSessions.values()];
    pendingSessions.clear();
    const launched = await Promise.allSettled(pending);
    const sessionsToKill = new Set(sessions.values());
    for (const result of launched) {
      if (result.status === "fulfilled") sessionsToKill.add(result.value);
    }
    await Promise.all([...sessionsToKill].map((session) => killSession(session)));
    sessions.clear();
  }

  async function getOrCreateSession(context: TerminalTicketContext): Promise<TerminalSession> {
    const current = sessions.get(context.sessionId);
    if (current) return current;
    const pending = pendingSessions.get(context.sessionId);
    if (pending) return pending;
    const pendingLaunch = launchSession(context);
    pendingSessions.set(context.sessionId, pendingLaunch);
    try {
      return await pendingLaunch;
    } finally {
      if (pendingSessions.get(context.sessionId) === pendingLaunch) {
        pendingSessions.delete(context.sessionId);
      }
    }
  }

  async function launchSession(context: TerminalTicketContext): Promise<TerminalSession> {
    const launch = await deps.launch(context.cwd, { sessionId: context.sessionId, kind: context.kind });
    let pty: TerminalPtyHandle;
    try {
      pty = startShell(launch, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    } catch (error) {
      await runLaunchCleanup(launch.cleanup);
      throw error;
    }
    const session: TerminalSession = {
      id: context.sessionId,
      pty,
      disposables: [],
      scrollback: [],
      cleanup: launch.cleanup,
      messagePolicy: launch.messagePolicy,
      activeSocket: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
    const dataDisposable = pty.onData((data) => handlePtyData(session, data));
    const exitDisposable = pty.onExit(() => removeSession(session, { killPty: false }));
    session.disposables.push(dataDisposable, exitDisposable);
    sessions.set(session.id, session);
    return session;
  }

  function handlePtyData(session: TerminalSession, data: string): void {
    const buffer = Buffer.from(data, "utf8");
    session.scrollback.push(buffer);
    while (session.scrollback.length > scrollbackLimit) session.scrollback.shift();
    if (session.activeSocket && session.activeSocket.readyState === WS_OPEN_STATE) {
      session.activeSocket.send(buffer, { binary: true });
    }
  }

  function handleSocketMessage(session: TerminalSession, data: TerminalSocketData, isBinary: boolean): void {
    if (isBinary) {
      session.pty.write(toBuffer(data).toString("utf8"));
      return;
    }
    handleControlFrame(session, toBuffer(data).toString("utf8"));
  }

  function handleControlFrame(session: TerminalSession, text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!isResizeFrame(frame)) return;
    session.cols = frame.cols;
    session.rows = frame.rows;
    session.pty.resize(frame.cols, frame.rows);
  }

  function detachSocket(session: TerminalSession, socket: TerminalSocket): void {
    if (session.activeSocket !== socket) return;
    // 소켓이 끊겨도(콘솔 웹 종료·세션 전환 언마운트) PTY 세션은 유지한다. activeSocket만 비워
    // 죽은 소켓으로의 전송을 막고, 출력은 scrollback에 계속 쌓여 재연결 시 attach가 그대로 재생한다.
    // PTY는 오직 PTY 자가종료·운영자 terminate·서버 stop에서만 죽는다(자동 종료 grace 타이머는 제거됨).
    session.activeSocket = null;
  }

  function replayScrollback(session: TerminalSession, socket: TerminalSocket): void {
    for (const chunk of session.scrollback) {
      if (socket.readyState !== WS_OPEN_STATE) return;
      socket.send(chunk, { binary: true });
    }
  }

  function removeSession(session: TerminalSession, options: KillSessionOptions = {}): void {
    if (sessions.get(session.id) !== session) return;
    void killSession(session, options);
    sessions.delete(session.id);
    // 인스턴스 일치 가드 덕분에 PTY 자가종료(onExit)와 운영자 terminate가 겹쳐도 세션당 한 번만 통지된다.
    deps.onSessionExit?.(session.id);
  }

  async function killSession(session: TerminalSession, options: KillSessionOptions = {}): Promise<void> {
    const killPty = options.killPty ?? true;
    session.activeSocket?.close(4001, "terminal_closed");
    session.activeSocket = null;
    for (const disposable of session.disposables) disposable.dispose();
    if (killPty) session.pty.kill();
    await runLaunchCleanup(session.cleanup);
  }

  return { canAttach, createSession, attach, getSessionMessagePolicy, terminate, stop, writeToSession };
}

async function runLaunchCleanup(cleanup: (() => void | Promise<void>) | undefined): Promise<void> {
  try {
    await cleanup?.();
  } catch {
    // 서버 종료/PTY 종료 경로에서는 cleanup 실패를 브라우저로 노출하지 않는다.
  }
}

function toBuffer(data: TerminalSocketData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isResizeFrame(value: unknown): value is { readonly type: "resize"; readonly cols: number; readonly rows: number } {
  if (!value || typeof value !== "object") return false;
  const frame = value as { readonly type?: unknown; readonly cols?: unknown; readonly rows?: unknown };
  const cols = frame.cols;
  const rows = frame.rows;
  return frame.type === "resize" && typeof cols === "number" && typeof rows === "number" && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0;
}
