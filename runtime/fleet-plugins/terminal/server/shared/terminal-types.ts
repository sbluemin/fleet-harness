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
  /** Spawn-time selected opaque provider identity reader; never browser-visible. */
  readonly sessionIdentityResolver?: SessionIdentityResolver;
  readonly terminalName?: string;
}

export interface TerminalLaunchContext {
  readonly sessionId?: string;
  readonly operationId?: string;
  readonly operationType?: string;
  readonly pluginId?: string;
  /** Opaque server-owned Theater identity; never a browser path or Plan binding. */
  readonly theaterId?: string;
  readonly kind?: "fleet" | "shell";
  readonly cliId?: string;
  readonly resumeSessionId?: string;
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
  readonly resumeSessionId?: string;
}

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
  getSessionRenameCommand(sessionId: string): string | undefined;
  resolveSessionIdentity(sessionId: string, providerSessionId: string): Promise<string | null>;
  terminate(sessionId: string): boolean;
  stop(): Promise<void>;
  writeToSession(sessionId: string, data: string): boolean;
}
