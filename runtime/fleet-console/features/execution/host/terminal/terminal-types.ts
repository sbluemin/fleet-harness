import type { CliMessagePolicy } from "@fleet-console/agent-runtime/fleet";
import type { SessionIdentityResolver } from "../agent/session-identity.js";

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
  readonly pluginId?: string | null;
  /** Opaque server-owned Theater identity; never a browser path. */
  readonly theaterId?: string;
  readonly kind?: "fleet" | "shell";
  readonly cliId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** 런치 시 첫 턴으로 제출될 프롬프트. argv 위치 인자로 나가며 PTY로 주입하지 않는다. */
  readonly prompt?: string;
  readonly resumeSessionId?: string;
  /** CLI 세션 표시 이름(세션 간 메시지 주소). spawn argv로만 나간다. */
  readonly sessionName?: string;
  /** 서브에이전트 전부 끄기 — 설정의 옵트아웃 목록 대신 `Agent` 도구 자체를 막는다. spawn 인자로만 나간다. */
  readonly disableSubagents?: boolean;
  /** 사람에게 묻는 도구(`AskUserQuestion`)를 뺀다. spawn 인자로만 나간다. */
  readonly disableUserQuestions?: boolean;
  /** 콘솔 테마 극성 힌트 — spawn env COLORFGBG로만 소비된다. PTY는 최초 spawn 시점 값에 고정된다. */
  readonly colorScheme?: "light" | "dark";
}

export interface TerminalTicket {
  readonly ticket: string;
  readonly ttlMs: number;
  /**
   * 이 티켓이 실제로 여는 등급. 요청이 무엇을 원했든 결정은 Console이 한다 — 클라이언트는
   * 자기가 무엇을 받았는지 알아야 입력 구독과 화면을 그 사실에 맞출 수 있다.
   */
  readonly role: TerminalSocketRole;
}

export interface TerminalTicketContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly operationId?: string;
  readonly operationType?: string;
  readonly pluginId?: string | null;
  readonly theaterId?: string;
  readonly kind?: "fleet" | "shell";
  readonly cliId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** 런치 시 첫 턴으로 제출될 프롬프트. argv 위치 인자로 나가며 PTY로 주입하지 않는다. */
  readonly prompt?: string;
  readonly resumeSessionId?: string;
  readonly sessionName?: string;
  readonly disableSubagents?: boolean;
  readonly disableUserQuestions?: boolean;
  readonly colorScheme?: "light" | "dark";
  /**
   * 이 티켓이 여는 소켓의 역할. 생략하면 `control`이다 — 지금까지 발급된 모든 티켓이 그것이었고,
   * 기본값을 바꾸면 옛 클라이언트가 조용히 읽기 전용이 된다.
   *
   * `viewer`는 출력만 받는다. 세션을 만들지도, 앞의 소켓을 밀어내지도, 입력이나 리사이즈를
   * 보내지도 못한다.
   */
  readonly role?: TerminalSocketRole;
  /**
   * 이 티켓이 여는 관측 면. 생략하면 PTY다 — 지금까지 발급된 모든 티켓이 그것이었고,
   * 기본값을 바꾸면 채팅 티켓이 살아 있는 PTY에 붙는다.
   *
   * `chat`은 저널 구독이다. PTY를 만들지도, canAttach를 묻지도 않는다.
   */
  readonly channel?: TerminalTicketChannel;
}

export type TerminalTicketChannel = "chat";

export type TerminalSocketRole = "control" | "viewer";

export interface TerminalPtyDataDisposable {
  dispose(): void;
}

export interface TerminalPtyHandle {
  readonly fd?: number;
  /** PTY 자식의 프로세스 id. 서버의 종료 확인과 peer 수신 출처 대조에만 쓴다. */
  readonly pid?: number;
  onData(callback: (data: string) => void): TerminalPtyDataDisposable;
  onExit(callback: () => void): TerminalPtyDataDisposable;
  write(data: string | Buffer): void;
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
  /**
   * 붙어 있는 모든 소켓을 닫아 등급을 다시 받게 한다. 제어 보유자가 바뀌었을 때 Console이 부른다 —
   * 티켓 발급 시점의 판정만으로는 이미 열려 있던 터미널이 옛 등급 그대로 남는다.
   */
  renegotiateSockets(): void;
  getSessionMessagePolicy(sessionId: string): CliMessagePolicy | undefined;
  getSessionRenameCommand(sessionId: string): string | undefined;
  getSessionLastActivityAt(sessionId: string): number | null;
  /** 서버 내부 소유 프로세스 대조 전용. 브라우저 세션 정보에는 포함하지 않는다. */
  getSessionProcessId(sessionId: string): number | undefined;
  resolveSessionIdentity(sessionId: string, providerSessionId: string): Promise<string | null>;
  terminate(sessionId: string): boolean;
  /** `terminate`와 같이 접고, PTY 자식 프로세스가 실제로 끝날 때까지 기다린다. 제한 시간 안에 확인하지 못하면 false. */
  terminateAndWait(sessionId: string, timeoutMs: number): Promise<boolean>;
  stop(): Promise<void>;
  writeToSession(sessionId: string, data: string): boolean;
}
