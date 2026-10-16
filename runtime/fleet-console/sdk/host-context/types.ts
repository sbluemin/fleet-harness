/** 저장 host의 opaque id다. origin이나 사용자 제공 주소를 식별자로 사용하지 않는다. */
export type HostKey = string;

/** 연결 수명은 선택 수명과 다르다. 화면을 옮겨도 다른 host의 연결은 살아 있을 수 있다. */
export interface HostScope {
  readonly hostKey: HostKey;
  readonly epoch: number;
  readonly signal: AbortSignal;
}

export type HostSelection =
  | { readonly hostKey: HostKey; readonly theaterId: string | null; readonly role: "commodore"; readonly operationId: null }
  | { readonly hostKey: HostKey; readonly theaterId: string; readonly role: "commander"; readonly operationId: string };

export type HostConnection = "connecting" | "ready" | "blocked" | "closed";
export type HostAccess = "full" | "monitoring";
export type HostMode = "off" | "observer" | "controller";
export type HostSnapshotPhase = "idle" | "loading" | "ready" | "error";

export interface HostTheaterSummary {
  readonly id: string;
  readonly label: string;
  readonly alias?: string;
}

export interface HostOperationSummary {
  readonly id: string;
  readonly theaterId: string;
  readonly title: string;
  readonly type: string;
  readonly parentOperationId?: string;
  readonly activity?: "idle" | "running" | "awaiting" | "background";
}

/** 목록에 남은 오류는 로컬 복귀와 독립적이다. ready 전에는 본문 데이터로 사용하지 않는다. */
export interface HostView {
  readonly hostKey: HostKey;
  readonly label: string;
  readonly epoch: number;
  readonly connection: HostConnection;
  readonly trust: "unknown" | "verified" | "mismatch";
  readonly access: HostAccess | null;
  readonly mode: HostMode;
  readonly phase: HostSnapshotPhase;
  readonly error: string | null;
  readonly theaters: readonly HostTheaterSummary[];
  readonly operations: readonly HostOperationSummary[];
}

export interface HostWorkspaceSnapshot {
  readonly hosts: readonly HostView[];
  readonly selection: HostSelection;
  /** 제어 획득과 현재 snapshot 확인을 모두 마친 선택만 이곳에 실린다. */
  readonly foreground: HostSelection | null;
  readonly selectionGeneration: number;
  readonly phase: HostSnapshotPhase;
  readonly canWrite: boolean;
  readonly error: string | null;
}

/** UI는 이 포트만 받는다. select는 제어권을 얻지 않으며 activateConversation만 명시적으로 요청한다. */
export interface HostWorkspacePort {
  readonly getSnapshot: () => HostWorkspaceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (selection: HostSelection) => void;
  readonly activateConversation: (selection: HostSelection) => Promise<void>;
  readonly returnLocal: () => void;
}

export interface HostEventSource {
  readonly readyState: number;
  onopen: EventSource["onopen"];
  onmessage: EventSource["onmessage"];
  onerror: EventSource["onerror"];
  readonly addEventListener: EventSource["addEventListener"];
  readonly removeEventListener: EventSource["removeEventListener"];
  readonly close: () => void;
}

export interface HostSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: WebSocket["onopen"];
  onmessage: WebSocket["onmessage"];
  onerror: WebSocket["onerror"];
  onclose: WebSocket["onclose"];
  readonly send: WebSocket["send"];
  readonly close: WebSocket["close"];
}

export interface HostSocketTarget {
  readonly operationId: string;
  readonly channel: "chat" | "terminal";
  readonly role?: "control" | "viewer";
  /** 로컬 단발 ticket만 받는다. 원격 구현은 renderer ticket을 거절한다. */
  readonly ticket?: string;
}

/** 하나의 불변 scope에 결박된다. path는 승인된 Console 상대 경로이며 외부 URL이 아니다. */
export interface HostTransport {
  readonly scope: HostScope;
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  readonly events: (path: string) => HostEventSource;
  readonly socket: (path: string, target: HostSocketTarget) => HostSocket;
  readonly resourceUrl: (path: string) => string;
}
