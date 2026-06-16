import type { CliMessagePolicy } from "@dotobokuri/fleet-admiral";

export interface TerminalLaunchSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cleanup?: () => void | Promise<void>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly messagePolicy?: CliMessagePolicy;
  readonly renameCommand?: string;
  readonly terminalName?: string;
}

export interface TerminalLaunchContext {
  readonly sessionId?: string;
  readonly kind?: "fleet" | "shell";
  readonly cliId?: string;
}

export interface TerminalTicket {
  readonly ticket: string;
  readonly ttlMs: number;
}

export interface TerminalTicketContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly kind?: "fleet" | "shell";
  readonly cliId?: string;
}

export interface TerminalPtyDataDisposable {
  dispose(): void;
}

export interface TerminalPtyHandle {
  onData(callback: (data: string) => void): TerminalPtyDataDisposable;
  onExit(callback: () => void): TerminalPtyDataDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalSocket {
  readonly readyState: number;
  send(data: Buffer, options: { readonly binary: true }): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: TerminalSocketData, isBinary: boolean) => void): void;
  once(event: "close", listener: () => void): void;
}

export type TerminalSocketData = Buffer | ArrayBuffer | Buffer[];

export interface TerminalSessionManager {
  canAttach(sessionId: string): boolean;
  createSession(context: TerminalTicketContext): Promise<void>;
  attach(socket: TerminalSocket, context: TerminalTicketContext): Promise<void>;
  getSessionMessagePolicy(sessionId: string): CliMessagePolicy | undefined;
  // 세션이 실제로 launch한 Agent CLI 프로파일이 제공한 rename 슬래시 명령. 없으면 undefined.
  getSessionRenameCommand(sessionId: string): string | undefined;
  // 운영자 종료(X 버튼) — PTY 자식까지 끝내고 onSessionExit로 콘솔 목록을 정리한다. 세션이 없으면 false(멱등).
  terminate(sessionId: string): boolean;
  stop(): Promise<void>;
  writeToSession(sessionId: string, data: string): boolean;
}
