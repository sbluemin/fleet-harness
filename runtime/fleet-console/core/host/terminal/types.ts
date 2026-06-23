import type { TerminalMessagePolicy } from "@fleet-console/sdk/terminal";

export type { TerminalLaunchContext, TerminalLaunchSpec, TerminalMessagePolicy, TerminalTicket } from "@fleet-console/sdk/terminal";

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
  getSessionMessagePolicy(sessionId: string): TerminalMessagePolicy | undefined;
  // 세션이 실제로 launch한 Agent CLI 프로파일이 제공한 rename 슬래시 명령. 없으면 undefined.
  getSessionRenameCommand(sessionId: string): string | undefined;
  // 운영자 종료(X 버튼) — PTY 자식까지 끝내고 onSessionExit로 콘솔 목록을 정리한다. 세션이 없으면 false(멱등).
  terminate(sessionId: string): boolean;
  stop(): Promise<void>;
  writeToSession(sessionId: string, data: string): boolean;
}
