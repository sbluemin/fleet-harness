/**
 * 로컬 Console과 그 창의 Desktop 셸만 쓰는 호스트 전송.
 * 명령에는 렌더러가 만든 URL·쿠키·티켓이 없다. 대상은 Console이 저장한 호스트다.
 */
export const DESKTOP_HOST_TRANSPORT_PATH = "/api/v1/desktop/host-transport";
export const DESKTOP_HOST_TRANSPORT_EVENTS_PATH = "/api/v1/desktop/host-transport/events";
export const DESKTOP_HOST_TRANSPORT_RELAY_PATH = "/api/v1/desktop/host-transport/relay";
export const DESKTOP_HOST_TRANSPORT_EVENT = "desktop:host-transport";

/**
 * 셸 SSE가 한 프레임으로 받는 상한. 이보다 큰 스냅샷은 연결을 끊으므로 명령을 이 안에 둔다.
 * 값을 올리면 대기 중인 명령이 스냅샷마다 다시 전송된다.
 */
export const DESKTOP_HOST_FRAME_MAX_CHARS = 2_000_000;

/**
 * 스냅샷에 실리는 업로드 조각의 base64 길이. 4의 배수다.
 * 프레임 상한보다 작아서, 같은 스냅샷의 다른 명령과 함께 있어도 연결을 끊지 않는다.
 */
export const DESKTOP_HOST_UPLOAD_CHUNK_CHARS = 512 * 1024;

/** 본문을 붙잡고 전송 중인 업로드. 스냅샷에는 그 현재 조각만 있다. */
export const DESKTOP_HOST_UPLOAD_SLOTS = 1;

/** 전송 슬롯을 기다리는 업로드. 이를 넘으면 본문을 큐에 두지 않고 바로 거절한다. */
export const DESKTOP_HOST_UPLOAD_QUEUE = 1;

/** 조각 업로드 전체의 제한 시간. 큐 대기와 모든 조각 왕복을 포함한다. */
export const DESKTOP_HOST_UPLOAD_DEADLINE_MS = 15_000;

export const DESKTOP_HOST_OPS = ["presence", "pair", "http", "bytes", "sse", "ws-open", "ws-send", "ws-close", "abort"] as const;
export type DesktopHostOp = (typeof DESKTOP_HOST_OPS)[number];

export interface DesktopHostTarget {
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: string;
}

export interface DesktopHostCommand {
  readonly id: number;
  readonly hostKey: string;
  readonly epoch: number;
  readonly op: DesktopHostOp;
  readonly routeId: string;
  readonly target: DesktopHostTarget;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface DesktopHostSnapshot {
  /** 콘솔 프로세스가 살아있는 동안만 유지된다. 같은 출처로 다시 떠도 이 값이 바뀔 때만 셸이 명령 번호를 잊는다. */
  readonly instanceId: string;
  readonly generation: number;
  readonly commands: readonly DesktopHostCommand[];
}

export interface DesktopHostRelay {
  readonly id: number;
  readonly error?: string;
  readonly capability?: "supported" | "unsupported";
  readonly mode?: "off" | "observer" | "controller";
  readonly access?: "full" | "monitoring" | null;
  readonly status?: number;
  readonly contentType?: string | null;
  readonly json?: unknown;
  readonly dataBase64?: string;
  readonly text?: string;
  readonly end?: boolean;
  /** 소켓이 티켓을 소비해 열렸다. 티켓 자체는 싣지 않는다. */
  readonly ready?: boolean;
  /** 업로드 조각만 받았다. 원격 POST는 마지막 조각 뒤에 한 번이다. */
  readonly uploadAck?: number;
}

const HOST_KEY = /^(?!local$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const FINGERPRINT = /^[0-9A-F]{64}$/u;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDesktopHostSnapshot(value: unknown): value is DesktopHostSnapshot {
  return isRecord(value)
    && typeof value.instanceId === "string"
    && INSTANCE_ID.test(value.instanceId)
    && typeof value.generation === "number"
    && Number.isSafeInteger(value.generation)
    && Array.isArray(value.commands)
    && value.commands.every(isDesktopHostCommand);
}

export function isDesktopHostCommand(value: unknown): value is DesktopHostCommand {
  if (!isRecord(value) || !isRecord(value.target) || !isRecord(value.params)) return false;
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id <= 0) return false;
  if (typeof value.hostKey !== "string" || !HOST_KEY.test(value.hostKey)) return false;
  if (typeof value.epoch !== "number" || !Number.isSafeInteger(value.epoch) || value.epoch < 0) return false;
  if (typeof value.op !== "string" || !(DESKTOP_HOST_OPS as readonly string[]).includes(value.op)) return false;
  if (typeof value.routeId !== "string" || value.routeId.length === 0 || value.routeId.length > 64) return false;
  const target = value.target;
  if (typeof target.hostname !== "string" || target.hostname.length === 0 || target.hostname.includes("/") || target.hostname.includes(" ")) return false;
  if (typeof target.port !== "number" || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) return false;
  if (typeof target.fingerprint !== "string" || !FINGERPRINT.test(target.fingerprint)) return false;
  return !("url" in value.params) && !("cookie" in value.params) && !("ticket" in value.params) && !("authorization" in value.params) && !("token" in value.params);
}

export function isDesktopHostRelay(value: unknown): value is DesktopHostRelay {
  if (!isRecord(value) || typeof value.id !== "number") return false;
  if ("cookie" in value || "ticket" in value || "authorization" in value || "token" in value) return false;
  return true;
}
