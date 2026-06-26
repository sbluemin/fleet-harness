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
  readonly operationId?: string;
  readonly operationType?: string;
  readonly pluginId?: string;
  readonly theaterId?: string;
}

export interface TerminalTicket {
  readonly ticket: string;
  readonly ttlMs: number;
}

export interface TerminalTicketContext {
  readonly operationId: string;
  readonly theaterId?: string;
  readonly cwd?: string;
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
  hasLiveSessions(): boolean;
  getSessionMessagePolicy(sessionId: string): CliMessagePolicy | undefined;
  getSessionRenameCommand(sessionId: string): string | undefined;
  terminate(sessionId: string): boolean;
  stop(): Promise<void>;
  writeToSession(sessionId: string, data: string): boolean;
}
