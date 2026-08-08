import type { CliMessagePolicy } from "@dotobokuri/fleet-admiral";
import type { SessionIdentityResolver } from "@dotobokuri/core-unified-agent";

export interface TerminalLaunchSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cleanup?: () => void | Promise<void>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly messagePolicy?: CliMessagePolicy;
  readonly renameCommand?: string;
  readonly goalCommand?: string;
  /** Spawn-time selected opaque provider identity reader; never browser-visible. */
  readonly sessionIdentityResolver?: SessionIdentityResolver;
  readonly terminalName?: string;
}

export interface TerminalLaunchContext {
  readonly sessionId?: string;
  readonly operationId?: string;
  readonly operationType?: string;
  readonly pluginId?: string;
  /** Opaque server-owned Theater identity; never a browser path. */
  readonly theaterId?: string;
  readonly kind?: "fleet" | "shell";
  readonly cliId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly goalCheckLimit?: number;
  /** 런치 시 첫 턴으로 제출될 프롬프트. argv 위치 인자로 나가며 PTY로 주입하지 않는다. */
  readonly prompt?: string;
  readonly resumeSessionId?: string;
  /** 콘솔 테마 극성 힌트 — spawn env COLORFGBG로만 소비된다. PTY는 최초 spawn 시점 값에 고정된다. */
  readonly colorScheme?: "light" | "dark";
}

export interface TerminalTicket {
  readonly ticket: string;
  readonly ttlMs: number;
}

export interface TerminalTicketContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly operationId?: string;
  readonly operationType?: string;
  readonly pluginId?: string;
  readonly theaterId?: string;
  readonly kind?: "fleet" | "shell";
  readonly cliId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** 런치 시 첫 턴으로 제출될 프롬프트. argv 위치 인자로 나가며 PTY로 주입하지 않는다. */
  readonly prompt?: string;
  readonly resumeSessionId?: string;
  readonly colorScheme?: "light" | "dark";
  /**
   * 이 티켓이 여는 소켓의 역할. 생략하면 `control`이다 — 지금까지 발급된 모든 티켓이 그것이었고,
   * 기본값을 바꾸면 옛 클라이언트가 조용히 읽기 전용이 된다.
   *
   * `viewer`는 출력만 받는다. 세션을 만들지도, 앞의 소켓을 밀어내지도, 입력이나 리사이즈를
   * 보내지도 못한다.
   */
  readonly role?: TerminalSocketRole;
}

export type TerminalSocketRole = "control" | "viewer";

export interface TerminalPtyDataDisposable {
  dispose(): void;
}

export interface TerminalPtyHandle {
  readonly fd?: number;
  onData(callback: (data: string) => void): TerminalPtyDataDisposable;
  onExit(callback: () => void): TerminalPtyDataDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  destroy?(): void;
}

export interface TerminalSocket {
  readonly readyState: number;
  send(data: Buffer, options: { readonly binary: true }): void;
  send(data: Buffer, options: { readonly binary: false }): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: TerminalSocketData, isBinary: boolean) => void): void;
  once(event: "close", listener: () => void): void;
}

export type TerminalSocketData = Buffer | ArrayBuffer | Buffer[];

export type TerminalTitleListener = (sessionId: string, title: string) => unknown;

export interface TerminalSessionManager {
  canAttach(sessionId: string): boolean;
  createSession(context: TerminalTicketContext): Promise<void>;
  attach(socket: TerminalSocket, context: TerminalTicketContext): Promise<void>;
  /**
   * 읽기 전용으로 붙는다. 이미 살아 있는 세션에만 붙을 수 있다 — 볼 것이 없는데 PTY를 새로
   * 띄우면 관전이 실행이 된다. 없는 세션이면 false를 돌려주고 호출자가 소켓을 닫는다.
   */
  attachViewer(socket: TerminalSocket, sessionId: string): boolean;
  getSessionMessagePolicy(sessionId: string): CliMessagePolicy | undefined;
  getSessionRenameCommand(sessionId: string): string | undefined;
  getSessionGoalCommand(sessionId: string): string | undefined;
  getSessionLastActivityAt(sessionId: string): number | null;
  resolveSessionIdentity(sessionId: string, providerSessionId: string): Promise<string | null>;
  terminate(sessionId: string): boolean;
  stop(): Promise<void>;
  writeToSession(sessionId: string, data: string): boolean;
}
