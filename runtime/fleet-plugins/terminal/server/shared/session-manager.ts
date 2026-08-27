import { closeSync, fstatSync, readdirSync } from "node:fs";

import type { CliMessagePolicy } from "@dotobokuri/fleet-admiral";
import type { SessionIdentityResolver } from "../agent-api/session-identity.js";

import { createOscTitleParser, type OscTitleParser } from "./osc-title-parser.js";
import { startTerminalShell, type TerminalLaunchResolver } from "./pty.js";
import type { TerminalPtyHandle, TerminalSessionManager, TerminalSocket, TerminalSocketData, TerminalTicketContext, TerminalTitleListener } from "./terminal-types.js";

export interface TerminalSessionManagerDeps {
  readonly launch: TerminalLaunchResolver;
  readonly startShell?: typeof startTerminalShell;
  // DI 계약 유지용으로 받지만 더 이상 동시 세션 상한을 강제하지 않는다(상한 해제됨).
  readonly maxSessions?: number;
  readonly scrollbackLimit?: number;
  readonly resolveTitleListener?: (context: TerminalTicketContext) => TerminalTitleListener | undefined;
  // PTY가 종료되거나 세션이 정리될 때(멱등) 정확히 한 번 호출 — 콘솔 세션 목록 정리에 쓰인다.
  readonly onSessionExit?: (sessionId: string) => unknown;
  /** Monotonic clock for idle tracking. Defaults to `performance.now`. */
  readonly now?: () => number;
}

interface TerminalSession {
  readonly id: string;
  readonly pty: TerminalPtyHandle;
  readonly ptyFds: readonly number[];
  readonly disposables: { dispose(): void }[];
  readonly scrollback: Buffer[];
  readonly cleanup?: () => void | Promise<void>;
  readonly messagePolicy?: CliMessagePolicy;
  readonly renameCommand?: string;
  readonly sessionIdentityResolver?: SessionIdentityResolver;
  readonly titleListener?: TerminalTitleListener;
  readonly titleParser?: OscTitleParser;
  activeSocket: TerminalSocket | null;
  /**
   * 출력만 받는 소켓들. 제어를 원격에 넘긴 로컬 사용자가 여기 들어와 같은 화면을 계속 본다.
   *
   * activeSocket과 분리해 두는 것이 요점이다 — 한 칸짜리 소유권을 그대로 두어야 "입력은 한
   * 곳에서만"이라는 성질이 유지되고, 관전자가 늘어도 누가 모는지는 여전히 하나로 답해진다.
   */
  readonly viewers: Set<TerminalSocket>;
  cols: number;
  rows: number;
  terminalQueryResidual: string;
  // 인메모리 유후 추적(서버 monotonic). 생성 시 시드되고 attach / PTY 출력 / binary 입력 / 서버 주입 write에서 갱신.
  lastActivityAt: number | undefined;
}

interface KillSessionOptions {
  readonly killPty?: boolean;
}

const DEFAULT_TERMINAL_SESSION_ID = "default";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK_LIMIT = 512;
const WS_OPEN_STATE = 1;
const FILE_TYPE_MASK = 0o170000;
const CHARACTER_DEVICE_TYPE = 0o020000;
const TERMINAL_QUERY_RESIDUAL_LIMIT = 64;
const ANSI_ESCAPE = "\x1b";
const ANSI_CSI_PREFIX = `${ANSI_ESCAPE}[`;
const DSR_STATUS_QUERY = `${ANSI_CSI_PREFIX}5n`;
const DSR_CURSOR_POSITION_QUERY = `${ANSI_CSI_PREFIX}6n`;
const PRIMARY_DEVICE_ATTRIBUTES_QUERY = `${ANSI_CSI_PREFIX}c`;
const PRIMARY_DEVICE_ATTRIBUTES_ZERO_QUERY = `${ANSI_CSI_PREFIX}0c`;
const SECONDARY_DEVICE_ATTRIBUTES_QUERY = `${ANSI_CSI_PREFIX}>c`;
const DSR_STATUS_RESPONSE = `${ANSI_CSI_PREFIX}0n`;
const PRIMARY_DEVICE_ATTRIBUTES_RESPONSE = `${ANSI_CSI_PREFIX}?1;2c`;
const SECONDARY_DEVICE_ATTRIBUTES_RESPONSE = `${ANSI_CSI_PREFIX}>0;0;0c`;

export function createTerminalSessionManager(deps: TerminalSessionManagerDeps): TerminalSessionManager {
  const startShell = deps.startShell ?? startTerminalShell;
  const scrollbackLimit = deps.scrollbackLimit ?? DEFAULT_SCROLLBACK_LIMIT;
  const now = deps.now ?? (() => performance.now());
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
    touchActivity(session);
    session.pty.resize(session.cols, session.rows);
    replayScrollback(session, socket);
    if (socket.readyState === WS_OPEN_STATE) {
      socket.send(Buffer.from(JSON.stringify({ type: "replay_end" }), "utf8"), { binary: false });
    }
    socket.on("message", (data, isBinary) => handleSocketMessage(session, data, isBinary));
    socket.once("close", () => detachSocket(session, socket));
  }

  /**
   * 읽기 전용 부착. 제어 소켓을 건드리지 않는 것이 이 함수의 전부다 — 밀어내지 않고,
   * activeSocket이 되지 않고, PTY를 리사이즈하지 않고, message 리스너를 달지 않는다.
   * 마지막 항목이 입력 차단의 실제 수단이다: 핸들러가 없으면 보낸 바이트는 갈 곳이 없다.
   *
   * 세션을 만들지도 않는다. 볼 대상이 없는 관전은 성립하지 않고, 여기서 PTY를 띄우면
   * 관전자가 프로세스를 시작시키는 셈이 된다.
   */
  function attachViewer(socket: TerminalSocket, sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.viewers.add(socket);
    replayScrollback(session, socket);
    if (socket.readyState === WS_OPEN_STATE) {
      socket.send(Buffer.from(JSON.stringify({ type: "replay_end" }), "utf8"), { binary: false });
    }
    socket.once("close", () => {
      session.viewers.delete(socket);
    });
    return true;
  }

  /**
   * 제어 보유자가 바뀌었으니 붙어 있는 소켓들을 다시 협상시킨다.
   *
   * 등급을 자리에서 올리고 내리는 대신 소켓을 닫는다. 클라이언트의 재연결 루프가 곧바로 새
   * 티켓을 받고, 그 티켓의 등급은 이미 서버가 정한다 — 이미 옳게 도는 경로 하나만 쓰면
   * 승격·강등 두 갈래를 따로 맞출 필요가 없다. 대가는 보유자가 바뀔 때의 scrollback 재생뿐이고,
   * 그 일은 원격 세션 하나당 많아야 두 번 일어난다.
   */
  function renegotiateSockets(): void {
    for (const session of sessions.values()) {
      const sockets = [session.activeSocket, ...session.viewers].filter((socket): socket is TerminalSocket => socket !== null);
      for (const socket of sockets) socket.close(4002, "terminal_control_changed");
    }
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

  function getSessionRenameCommand(sessionId: string): string | undefined {
    return sessions.get(sessionId)?.renameCommand;
  }

  function getSessionLastActivityAt(sessionId: string): number | null {
    const session = sessions.get(sessionId);
    return session?.lastActivityAt === undefined ? null : session.lastActivityAt;
  }

  async function resolveSessionIdentity(sessionId: string, providerSessionId: string): Promise<string | null> {
    const session = sessions.get(sessionId);
    const resolver = session?.sessionIdentityResolver;
    if (!resolver) return null;
    try {
      const title = await resolver.resolve(providerSessionId);
      // A detached reader may complete after PTY teardown. Do not let it revive
      // or mutate a removed/replaced Terminal session.
      return sessions.get(sessionId) === session ? title : null;
    } catch {
      return null;
    }
  }

  function writeToSession(sessionId: string, data: string): boolean {
    const session = sessions.get(sessionId);
    if (!session || typeof session.pty.write !== "function") return false;
    try {
      // 서버 주입 입력(reminder·rename)도 활동이다 — 직렬화된 주입 큐가 길어져도
      // 각 write가 다음 write(250ms)까지 유후 타이머를 밀어내 세션이 살아있는다.
      touchActivity(session);
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
    await Promise.all([...sessionsToKill].map((session) => notifySessionExit(session.id)));
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
    const launch = await deps.launch(context.cwd, {
      sessionId: context.sessionId,
      ...(context.operationId ? { operationId: context.operationId } : {}),
      ...(context.operationType ? { operationType: context.operationType } : {}),
      ...(context.pluginId ? { pluginId: context.pluginId } : {}),
      ...(context.theaterId ? { theaterId: context.theaterId } : {}),
      ...(context.kind ? { kind: context.kind } : {}),
      ...(context.cliId ? { cliId: context.cliId } : {}),
      ...(context.model ? { model: context.model } : {}),
      ...(context.effort ? { effort: context.effort } : {}),
      ...(context.prompt ? { prompt: context.prompt } : {}),
      ...(context.resumeSessionId ? { resumeSessionId: context.resumeSessionId } : {}),
      ...(context.colorScheme ? { colorScheme: context.colorScheme } : {}),
    });
    let pty: TerminalPtyHandle;
    let ptyFds: readonly number[] = [];
    try {
      const beforePtyFds = readOpenCharacterDeviceFds();
      pty = startShell(launch, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
      ptyFds = readSpawnedPtyFds(beforePtyFds, pty);
    } catch (error) {
      await runLaunchCleanup(launch.cleanup);
      throw error;
    }
    const titleListener = deps.resolveTitleListener?.(context);
    const session: TerminalSession = {
      id: context.sessionId,
      pty,
      ptyFds,
      disposables: [],
      scrollback: [],
      cleanup: launch.cleanup,
      messagePolicy: launch.messagePolicy,
      renameCommand: launch.renameCommand,
      sessionIdentityResolver: launch.sessionIdentityResolver,
      titleListener,
      ...(titleListener ? { titleParser: createOscTitleParser() } : {}),
      activeSocket: null,
      viewers: new Set<TerminalSocket>(),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      terminalQueryResidual: "",
      // 생성 시각으로 시드한다 — 조용한 PTY가 attach 전에 고아가 되어도 sweeper가 유후 판정할 수 있게 한다.
      lastActivityAt: now(),
    };
    try {
      const dataDisposable = pty.onData((data) => handlePtyData(session, data));
      session.disposables.push(dataDisposable);
      // 자연종료 후에도 node-pty agent.kill() 경로를 한 번 지나 conout/inSocket 정리를 시도한다.
      const exitDisposable = pty.onExit(() => removeSession(session));
      session.disposables.push(exitDisposable);
      sessions.set(session.id, session);
      return session;
    } catch (error) {
      for (const disposable of session.disposables) disposable.dispose();
      try {
        killPtyBestEffort(pty, ptyFds);
      } finally {
        await runLaunchCleanup(launch.cleanup);
      }
      throw error;
    }
  }

  function handlePtyData(session: TerminalSession, data: string): void {
    touchActivity(session);
    const buffer = Buffer.from(data, "utf8");
    const liveSocket = session.activeSocket?.readyState === WS_OPEN_STATE ? session.activeSocket : null;
    const queryResponses = scanTerminalQueries(session, buffer);
    // 라이브 중에도 파싱을 계속해 분절 질의의 prefix를 residual로 이월하고, 응답만 클라이언트에 위임한다.
    // 소유권 경계는 attach와 같은 동기 블록에서 전송되는 replay_end로 유지된다.
    if (!liveSocket) {
      for (const response of queryResponses) writeTerminalQueryResponse(session, response);
    }
    observeOscTitles(session, buffer);
    session.scrollback.push(buffer);
    while (session.scrollback.length > scrollbackLimit) session.scrollback.shift();
    liveSocket?.send(buffer, { binary: true });
    // 관전자는 같은 바이트를 받되 질의에는 답하지 않는다 — 응답 권한은 제어 소켓 하나에만
    // 있고, 둘이 답하면 PTY가 두 벌의 응답을 읽는다.
    for (const viewer of session.viewers) {
      if (viewer.readyState !== WS_OPEN_STATE) continue;
      viewer.send(buffer, { binary: true });
    }
  }

  function observeOscTitles(session: TerminalSession, buffer: Buffer): void {
    if (!session.titleParser || !session.titleListener) return;
    try {
      for (const title of session.titleParser.push(buffer)) {
        try {
          session.titleListener(session.id, title);
        } catch {
          continue;
        }
      }
    } catch {
      session.titleParser.reset();
    }
  }

  function handleSocketMessage(session: TerminalSession, data: TerminalSocketData, isBinary: boolean): void {
    if (isBinary) {
      touchActivity(session);
      session.pty.write(toBuffer(data).toString("utf8"));
      return;
    }
    handleControlFrame(session, toBuffer(data).toString("utf8"));
  }

  function touchActivity(session: TerminalSession): void {
    session.lastActivityAt = now();
  }

  function handleControlFrame(session: TerminalSession, text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!isResizeFrame(frame)) return;
    // 격자가 그대로면 PTY를 건드리지 않는다. pty.resize는 크기가 같아도 SIGWINCH를 보내고,
    // 전체 화면 TUI는 그 신호마다 프레임 전체를 다시 그린다 — 바뀐 것이 없을 때 그 재도색은
    // 사용자 눈에 깜빡임으로만 남는다. 클라이언트도 같은 판정을 하지만 서버가 마지막 방어선이다.
    if (session.cols === frame.cols && session.rows === frame.rows) return;
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
    void notifySessionExit(session.id);
  }

  async function notifySessionExit(sessionId: string): Promise<void> {
    await deps.onSessionExit?.(sessionId);
  }

  async function killSession(session: TerminalSession, options: KillSessionOptions = {}): Promise<void> {
    const killPty = options.killPty ?? true;
    session.activeSocket?.close(4001, "terminal_closed");
    session.activeSocket = null;
    // 관전자도 같은 이유로 끝난다 — 남겨 두면 죽은 PTY를 보며 살아 있는 화면인 척한다.
    for (const viewer of session.viewers) viewer.close(4001, "terminal_closed");
    session.viewers.clear();
    for (const disposable of session.disposables) disposable.dispose();
    try {
      if (killPty) killPtyBestEffort(session.pty, session.ptyFds);
    } finally {
      await runLaunchCleanup(session.cleanup);
    }
  }

  return { canAttach, createSession, attach, attachViewer, renegotiateSockets, getSessionMessagePolicy, getSessionRenameCommand, getSessionLastActivityAt, resolveSessionIdentity, terminate, stop, writeToSession };
}

async function runLaunchCleanup(cleanup: (() => void | Promise<void>) | undefined): Promise<void> {
  try {
    await cleanup?.();
  } catch {
    // 서버 종료/PTY 종료 경로에서는 cleanup 실패를 브라우저로 노출하지 않는다.
  }
}

function killPtyBestEffort(pty: TerminalPtyHandle, ptyFds: readonly number[] = []): void {
  const fds = new Set(ptyFds);
  if (typeof pty.fd === "number") fds.add(pty.fd);
  if (typeof pty.destroy === "function") {
    try {
      pty.destroy();
      closePtyFdsBestEffort(fds);
      return;
    } catch {
      // 네이티브 stream close 경로가 실패하면 signal-only 종료로 한 번 더 시도한다.
    }
  }
  try {
    pty.kill();
  } catch {
    // 정리 전용 경로이므로 kill 실패가 세션 종료나 launch cleanup을 막으면 안 된다.
  } finally {
    closePtyFdsBestEffort(fds);
  }
}

function closePtyFdsBestEffort(fds: Iterable<number>): void {
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      // 이미 닫힌 fd이거나 네이티브 정리와 경합한 경우에는 종료 흐름을 막지 않는다.
    }
  }
}

function readSpawnedPtyFds(before: ReadonlySet<number>, pty: TerminalPtyHandle): readonly number[] {
  const spawned = new Set<number>();
  for (const fd of readOpenCharacterDeviceFds()) {
    if (!before.has(fd)) spawned.add(fd);
  }
  if (typeof pty.fd === "number") spawned.add(pty.fd);
  return [...spawned];
}

function readOpenCharacterDeviceFds(): ReadonlySet<number> {
  const fds = new Set<number>();
  let names: string[];
  try {
    names = readdirSync("/dev/fd");
  } catch {
    return fds;
  }
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd < 0) continue;
    try {
      if ((fstatSync(fd).mode & FILE_TYPE_MASK) === CHARACTER_DEVICE_TYPE) fds.add(fd);
    } catch {
      continue;
    }
  }
  return fds;
}

function scanTerminalQueries(session: TerminalSession, buffer: Buffer): string[] {
  const text = `${session.terminalQueryResidual}${buffer.toString("utf8")}`;
  const responses: string[] = [];
  session.terminalQueryResidual = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(ANSI_CSI_PREFIX, cursor);
    if (start === -1) {
      session.terminalQueryResidual = readTrailingEscape(text);
      break;
    }
    const end = findCsiSequenceEnd(text, start + ANSI_CSI_PREFIX.length);
    if (end === -1) {
      session.terminalQueryResidual = trimTerminalQueryResidual(text.slice(start));
      break;
    }
    const response = resolveTerminalQueryResponse(session, text.slice(start, end + 1));
    if (response) responses.push(response);
    cursor = end + 1;
  }
  return responses;
}

function readTrailingEscape(text: string): string {
  return text.endsWith(ANSI_ESCAPE) ? ANSI_ESCAPE : "";
}

function findCsiSequenceEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function resolveTerminalQueryResponse(session: TerminalSession, sequence: string): string | undefined {
  if (sequence === DSR_CURSOR_POSITION_QUERY) return `${ANSI_CSI_PREFIX}${Math.max(1, session.rows)};${Math.max(1, session.cols)}R`;
  if (sequence === DSR_STATUS_QUERY) return DSR_STATUS_RESPONSE;
  if (sequence === PRIMARY_DEVICE_ATTRIBUTES_QUERY || sequence === PRIMARY_DEVICE_ATTRIBUTES_ZERO_QUERY) return PRIMARY_DEVICE_ATTRIBUTES_RESPONSE;
  if (sequence === SECONDARY_DEVICE_ATTRIBUTES_QUERY) return SECONDARY_DEVICE_ATTRIBUTES_RESPONSE;
  return undefined;
}

function writeTerminalQueryResponse(session: TerminalSession, response: string | undefined): void {
  if (!response) return;
  try {
    session.pty.write(response);
  } catch {
    return;
  }
}

function trimTerminalQueryResidual(residual: string): string {
  return residual.slice(-TERMINAL_QUERY_RESIDUAL_LIMIT);
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
