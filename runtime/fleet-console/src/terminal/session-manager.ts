import { startTerminalShell, type TerminalLaunchResolver } from "./launch.js";
import type { TerminalPtyHandle, TerminalSessionManager, TerminalSocket, TerminalSocketData, TerminalTicketContext } from "./types.js";

export interface TerminalSessionManagerDeps {
  readonly launch: TerminalLaunchResolver;
  readonly startShell?: typeof startTerminalShell;
  readonly maxSessions?: number;
  readonly graceMs?: number;
  readonly scrollbackLimit?: number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

interface TerminalSession {
  readonly id: string;
  readonly pty: TerminalPtyHandle;
  readonly disposables: { dispose(): void }[];
  readonly scrollback: Buffer[];
  activeSocket: TerminalSocket | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  cols: number;
  rows: number;
}

interface KillSessionOptions {
  readonly killPty?: boolean;
}

const DEFAULT_TERMINAL_SESSION_ID = "default";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_GRACE_MS = 180_000;
const DEFAULT_SCROLLBACK_LIMIT = 512;
const WS_OPEN_STATE = 1;
export const MAX_TERMINAL_SESSIONS = 3;

export function createTerminalSessionManager(deps: TerminalSessionManagerDeps): TerminalSessionManager {
  const startShell = deps.startShell ?? startTerminalShell;
  const maxSessions = deps.maxSessions ?? MAX_TERMINAL_SESSIONS;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const scrollbackLimit = deps.scrollbackLimit ?? DEFAULT_SCROLLBACK_LIMIT;
  const setTimeoutImpl = deps.setTimeout ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeout ?? clearTimeout;
  const sessions = new Map<string, TerminalSession>();

  function canAttach(sessionId: string): boolean {
    return sessions.has(sessionId) || sessions.size < maxSessions;
  }

  function attach(socket: TerminalSocket, context: TerminalTicketContext): void {
    const session = getOrCreateSession(context);
    if (session.activeSocket && session.activeSocket !== socket) {
      session.activeSocket.close(4000, "terminal_replaced");
    }
    if (session.graceTimer) {
      clearTimeoutImpl(session.graceTimer);
      session.graceTimer = null;
    }
    session.activeSocket = socket;
    session.pty.resize(session.cols, session.rows);
    replayScrollback(session, socket);
    socket.on("message", (data, isBinary) => handleSocketMessage(session, data, isBinary));
    socket.once("close", () => detachSocket(session, socket));
  }

  function createSession(context: TerminalTicketContext): void {
    getOrCreateSession(context);
  }

  function stop(): void {
    for (const session of sessions.values()) {
      killSession(session);
    }
    sessions.clear();
  }

  function getOrCreateSession(context: TerminalTicketContext): TerminalSession {
    const current = sessions.get(context.sessionId);
    if (current) return current;
    if (sessions.size >= maxSessions) throw new Error("Terminal session capacity exhausted");
    const pty = startShell(deps.launch(context.cwd, { sessionId: context.sessionId }), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    const session: TerminalSession = {
      id: context.sessionId,
      pty,
      disposables: [],
      scrollback: [],
      activeSocket: null,
      graceTimer: null,
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
    session.activeSocket = null;
    session.graceTimer = setTimeoutImpl(() => removeSession(session), graceMs);
  }

  function replayScrollback(session: TerminalSession, socket: TerminalSocket): void {
    for (const chunk of session.scrollback) {
      if (socket.readyState !== WS_OPEN_STATE) return;
      socket.send(chunk, { binary: true });
    }
  }

  function removeSession(session: TerminalSession, options: KillSessionOptions = {}): void {
    if (!sessions.has(session.id)) return;
    killSession(session, options);
    sessions.delete(session.id);
  }

  function killSession(session: TerminalSession, options: KillSessionOptions = {}): void {
    const killPty = options.killPty ?? true;
    if (session.graceTimer) {
      clearTimeoutImpl(session.graceTimer);
      session.graceTimer = null;
    }
    session.activeSocket?.close(4001, "terminal_closed");
    session.activeSocket = null;
    for (const disposable of session.disposables) disposable.dispose();
    if (killPty) session.pty.kill();
  }

  return { canAttach, createSession, attach, stop };
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
