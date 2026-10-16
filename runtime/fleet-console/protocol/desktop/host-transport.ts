/**
 * 로컬 Console과 그 창의 Desktop 셸만 쓰는 호스트 전송.
 * 명령에는 렌더러가 만든 URL·쿠키·티켓이 없다. 대상은 Console이 저장한 호스트다.
 */
export const DESKTOP_HOST_TRANSPORT_PATH = "/api/v1/desktop/host-transport";
export const DESKTOP_HOST_TRANSPORT_EVENTS_PATH = "/api/v1/desktop/host-transport/events";
export const DESKTOP_HOST_TRANSPORT_RELAY_PATH = "/api/v1/desktop/host-transport/relay";
export const DESKTOP_HOST_TRANSPORT_EVENT = "desktop:host-transport";

export const DESKTOP_HOST_OPS = ["presence", "http", "bytes", "sse", "ws-open", "ws-send", "ws-close", "abort"] as const;
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
}

const HOST_KEY = /^(?!local$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const FINGERPRINT = /^[0-9A-F]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDesktopHostSnapshot(value: unknown): value is DesktopHostSnapshot {
  return isRecord(value)
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
  return !("url" in value.params) && !("cookie" in value.params) && !("ticket" in value.params) && !("authorization" in value.params);
}

export function isDesktopHostRelay(value: unknown): value is DesktopHostRelay {
  if (!isRecord(value) || typeof value.id !== "number") return false;
  if ("cookie" in value || "ticket" in value || "authorization" in value) return false;
  return true;
}
