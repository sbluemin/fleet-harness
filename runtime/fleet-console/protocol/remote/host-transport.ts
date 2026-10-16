/**
 * 로컬 Console 문서가 원격 호스트로 나가는 제품 API.
 *
 * 브라우저는 이 타입만 보내고, 셸은 같은 파서를 읽는다. 자격·티켓·임의 헤더·임의 URL은
 * 이 계약에 없다. `local`은 이 경로를 쓰지 않고 기존 ticket·HTTP·SSE·WebSocket을 유지한다.
 *
 * 요청 본문의 세대는 `expectedEpoch`다. 스트림·자원·소켓 URL의 세대는 쿼리 `epoch`다.
 * 둘 다 마지막으로 받은 `HostPresence.epoch`여야 하며, 서버는 상류로 보내기 전에 비교한다.
 * gateway 프로세스 수명은 별개의 `instanceId`다. 본문은 `expectedInstanceId`, scoped URL은
 * `instanceId`로 고정한다. 이 UUID는 인증값도 Desktop bridge의 instanceId도 아니다.
 * presence GET/presenceEvents만 수명 발견용 비고정 읽기이고, 모든 응답/사건에 현재 수명을 싣는다.
 */
export const HOST_TERMINAL_UPGRADE_PATH = "/api/v1/terminal/ws";
export const HOST_PRESENCE_EVENT = "host-presence";
export const HOST_JSON_CONTENT_TYPE = "application/json";
export const HOST_JSON_MAX_CHARS = 1_048_576;
export const HOST_BYTE_MAX_BYTES = 8 * 1024 * 1024;
/** 제품 첨부 라우트가 받는 원시 이미지 상한. base64는 전송 형식일 뿐이며 이 바이트를 넘기면 거절한다. */
export const HOST_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/**
 * 자원(resources) 응답 한 건의 원시 바이트 상한. 제품이 저장하는 가장 큰 이미지(첨부·결과물)를 그대로 미리 볼 수 있어야
 * 하므로 업로드 상한과 같다. 일반 파일 내려받기 통로가 아니다 — JSON·이벤트·소켓 상한은 따로 유지한다.
 */
export const HOST_RESOURCE_MAX_BYTES = HOST_UPLOAD_MAX_BYTES;
export const HOST_EPOCH_QUERY = "epoch";
export const HOST_INSTANCE_QUERY = "instanceId";
export const HOST_PATH_QUERY = "path";
export const HOST_SOCKET_CHANNEL_QUERY = "channel";
export const HOST_SOCKET_OPERATION_QUERY = "operationId";

export const HOST_TRANSPORT_ERRORS = [
  "invalid_host_request",
  "stale_epoch",
  "stale_instance",
  "remote_host_unknown",
  "remote_host_not_paired",
  "remote_link_required",
  "paired_device_limit",
  "observer_only",
  "remote_host_fingerprint_mismatch",
  "remote_host_unreachable",
  "remote_host_unavailable",
  "host_unsupported",
  "host_inactive",
  "route_denied",
  "read_only",
  "not_controller",
] as const;
export type HostTransportError = (typeof HOST_TRANSPORT_ERRORS)[number];

/** 오류 코드의 HTTP 상태. `stale_epoch`만 현재 세대를 함께 싣는다. */
export const HOST_ERROR_STATUS: Readonly<Record<HostTransportError, number>> = {
  invalid_host_request: 400,
  stale_epoch: 409,
  stale_instance: 409,
  remote_host_unknown: 404,
  remote_host_not_paired: 401,
  remote_link_required: 409,
  paired_device_limit: 409,
  observer_only: 403,
  remote_host_fingerprint_mismatch: 409,
  remote_host_unreachable: 409,
  remote_host_unavailable: 409,
  host_unsupported: 409,
  host_inactive: 409,
  route_denied: 403,
  read_only: 403,
  not_controller: 403,
};

/**
 * 중계가 표현할 수 있는 동사. 이 목록에 있다는 것은 허용이 아니다.
 * 경로별 허용 목록에 없는 GET도, 여기 없는 PUT도 거절한다.
 */
export const HOST_RELAY_METHODS = ["GET", "HEAD", "POST", "PATCH", "DELETE"] as const;
export type HostRelayMethod = (typeof HOST_RELAY_METHODS)[number];

export const HOST_PRESENCE_INTENTS = ["observe", "activate", "release"] as const;
export type HostPresenceIntent = (typeof HOST_PRESENCE_INTENTS)[number];
export const HOST_MODES = ["off", "observer", "controller"] as const;
export type HostMode = (typeof HOST_MODES)[number];
export const HOST_ACCESS_LEVELS = ["full", "monitoring"] as const;
export type HostAccess = (typeof HOST_ACCESS_LEVELS)[number];
export const HOST_CONNECTIONS = ["connecting", "ready", "blocked", "closed"] as const;
export type HostConnection = (typeof HOST_CONNECTIONS)[number];
export const HOST_CAPABILITIES = ["supported", "unsupported"] as const;
export type HostCapability = (typeof HOST_CAPABILITIES)[number];
export const HOST_SOCKET_CHANNELS = ["chat", "terminal"] as const;
export type HostSocketChannel = (typeof HOST_SOCKET_CHANNELS)[number];
export const HOST_BYTE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/plain; charset=utf-8", "application/octet-stream"] as const;
export type HostByteContentType = (typeof HOST_BYTE_CONTENT_TYPES)[number];

export interface HostPresenceRequest {
  readonly intent: HostPresenceIntent;
  readonly expectedEpoch: number;
  readonly expectedInstanceId: string;
}

/** 최초 페어링. 자격·intent·기기 이름은 브라우저 본문에 없다. */
export interface HostPairRequest {
  readonly expectedEpoch: number;
  readonly expectedInstanceId: string;
}

export interface HostPresence {
  readonly hostKey: string;
  readonly epoch: number;
  readonly instanceId: string;
  readonly mode: HostMode;
  readonly access: HostAccess | null;
  readonly connection: HostConnection;
  /** 원격이 관찰·제어를 말하지 않으면 supported로 추정하지 않는다. */
  readonly capability: HostCapability;
}

export interface HostTransportErrorBody {
  readonly error: HostTransportError;
  readonly epoch?: number;
}

/** `json`을 빼면 본문이 없다. `null`은 JSON null이다. */
export interface HostJsonRequest {
  readonly requestId: string;
  readonly expectedEpoch: number;
  readonly expectedInstanceId: string;
  readonly method: HostRelayMethod;
  readonly path: string;
  readonly json?: unknown;
}

export interface HostJsonResult {
  readonly requestId: string;
  readonly epoch: number;
  readonly instanceId: string;
  readonly status: number;
  readonly contentType: typeof HOST_JSON_CONTENT_TYPE | null;
  readonly json?: unknown;
}

/** 바이트 다운로드. 요청에 contentType과 본문을 싣지 않는다. */
export interface HostByteRequest {
  readonly requestId: string;
  readonly expectedEpoch: number;
  readonly expectedInstanceId: string;
  readonly path: string;
}

/**
 * 허용된 첨부 경로에만 보내는 원시 이미지.
 * `path`의 질의만 파일 이름을 담을 수 있고, MIME·multipart·별도 파일 이름 필드는 없다.
 * 원격은 Content-Type이 아니라 머리 바이트로 형식을 판정한다.
 */
export interface HostUploadRequest {
  readonly requestId: string;
  readonly expectedEpoch: number;
  readonly expectedInstanceId: string;
  readonly path: string;
  readonly dataBase64: string;
}

export interface HostByteResult {
  readonly requestId: string;
  readonly epoch: number;
  readonly instanceId: string;
  readonly status: number;
  readonly contentType: HostByteContentType;
  readonly dataBase64: string;
}

export interface HostStreamQuery {
  readonly path: string;
  readonly epoch: number;
  readonly instanceId: string;
}

/** 브라우저 소켓 쿼리. ticket·role·path는 없다. 업그레이드 경로는 셸 내부다. */
export interface HostSocketParams {
  readonly epoch: number;
  readonly instanceId: string;
  readonly channel: HostSocketChannel;
  readonly operationId: string;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const REMOTE_HOST_KEY = /^(?!local$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_HOST_PATH_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function isHostInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

export function isHostEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isRemoteHostKey(value: unknown): value is string {
  return typeof value === "string" && REMOTE_HOST_KEY.test(value);
}

export function isHostRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

export function isHostOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID.test(value);
}

/** origin·scheme·상위 경로를 거절한다. 질의는 한 번만 허용한다. */
export function isHostRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HOST_PATH_LENGTH) return false;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("#") || value.includes(" ")) return false;
  const parts = value.split("?");
  if (parts.length > 2) return false;
  const pathname = parts[0] ?? "";
  if (pathname.length === 0) return false;
  return pathname.split("/").every((segment) => segment !== "." && segment !== "..");
}

export function isHostTerminalUpgradePath(value: unknown): value is typeof HOST_TERMINAL_UPGRADE_PATH {
  return value === HOST_TERMINAL_UPGRADE_PATH;
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isListed<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function jsonChars(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && text.length <= HOST_JSON_MAX_CHARS ? text.length : null;
  } catch {
    return null;
  }
}

export function isHostPresenceRequest(value: unknown): value is HostPresenceRequest {
  return isRecord(value)
    && hasOnlyKeys(value, ["intent", "expectedEpoch", "expectedInstanceId"])
    && isListed(HOST_PRESENCE_INTENTS, value.intent)
    && isHostEpoch(value.expectedEpoch)
    && isHostInstanceId(value.expectedInstanceId);
}

export function isHostPairRequest(value: unknown): value is HostPairRequest {
  return isRecord(value)
    && hasOnlyKeys(value, ["expectedEpoch", "expectedInstanceId"])
    && isHostEpoch(value.expectedEpoch)
    && isHostInstanceId(value.expectedInstanceId);
}

export function isHostPresence(value: unknown): value is HostPresence {
  if (!isRecord(value) || !hasOnlyKeys(value, ["hostKey", "epoch", "instanceId", "mode", "access", "connection", "capability"])) return false;
  if (!isRemoteHostKey(value.hostKey) || !isHostEpoch(value.epoch) || !isHostInstanceId(value.instanceId)) return false;
  if (!isListed(HOST_MODES, value.mode) || !isListed(HOST_CONNECTIONS, value.connection) || !isListed(HOST_CAPABILITIES, value.capability)) return false;
  if (value.access !== null && !isListed(HOST_ACCESS_LEVELS, value.access)) return false;
  if (value.capability === "unsupported") return value.mode === "off" && value.access === null && value.connection === "blocked";
  if (value.mode === "off") return value.access === null;
  if (value.mode === "controller") return value.access === "full";
  return value.access !== null;
}

export function isHostTransportErrorBody(value: unknown): value is HostTransportErrorBody {
  if (!isRecord(value) || !isListed(HOST_TRANSPORT_ERRORS, value.error)) return false;
  if (value.error === "stale_epoch") return hasOnlyKeys(value, ["error", "epoch"]) && isHostEpoch(value.epoch);
  return hasOnlyKeys(value, ["error"]);
}

export function isHostJsonRequest(value: unknown): value is HostJsonRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["requestId", "expectedEpoch", "expectedInstanceId", "method", "path"], ["json"])) return false;
  if (!isHostRequestId(value.requestId) || !isHostEpoch(value.expectedEpoch) || !isHostInstanceId(value.expectedInstanceId) || !isListed(HOST_RELAY_METHODS, value.method) || !isHostRelativePath(value.path)) return false;
  return !Object.prototype.hasOwnProperty.call(value, "json") || jsonChars(value.json) !== null;
}

export function isHostJsonResult(value: unknown): value is HostJsonResult {
  if (!isRecord(value) || !isHostRequestId(value.requestId) || !isHostEpoch(value.epoch) || !isHostInstanceId(value.instanceId) || !isHttpStatus(value.status)) return false;
  const hasJson = Object.prototype.hasOwnProperty.call(value, "json");
  if (value.contentType === null) return !hasJson && hasOnlyKeys(value, ["requestId", "epoch", "instanceId", "status", "contentType"]);
  return value.contentType === HOST_JSON_CONTENT_TYPE && hasJson && jsonChars(value.json) !== null && hasOnlyKeys(value, ["requestId", "epoch", "instanceId", "status", "contentType", "json"]);
}

export function isHostByteRequest(value: unknown): value is HostByteRequest {
  return isRecord(value)
    && hasOnlyKeys(value, ["requestId", "expectedEpoch", "expectedInstanceId", "path"])
    && isHostRequestId(value.requestId)
    && isHostEpoch(value.expectedEpoch)
    && isHostInstanceId(value.expectedInstanceId)
    && isHostRelativePath(value.path);
}

export function isHostUploadRequest(value: unknown): value is HostUploadRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["requestId", "expectedEpoch", "expectedInstanceId", "path", "dataBase64"])) return false;
  if (!isHostRequestId(value.requestId) || !isHostEpoch(value.expectedEpoch) || !isHostInstanceId(value.expectedInstanceId) || !isHostRelativePath(value.path)) return false;
  if (typeof value.dataBase64 !== "string") return false;
  if (value.dataBase64.length > Math.ceil(HOST_UPLOAD_MAX_BYTES / 3) * 4) return false;
  const bytes = decodedBase64Bytes(value.dataBase64);
  return bytes !== null && bytes > 0 && bytes <= HOST_UPLOAD_MAX_BYTES;
}

function decodedBase64Bytes(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const stop = value.length - padding;
  for (let index = 0; index < stop; index += 1) {
    const code = value.charCodeAt(index);
    const digit = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 47;
    if (!digit) return null;
  }
  return (value.length / 4) * 3 - padding;
}

export function isHostByteResult(value: unknown): value is HostByteResult {
  return isRecord(value)
    && hasOnlyKeys(value, ["requestId", "epoch", "instanceId", "status", "contentType", "dataBase64"])
    && isHostRequestId(value.requestId)
    && isHostEpoch(value.epoch)
    && isHostInstanceId(value.instanceId)
    && isHttpStatus(value.status)
    && isListed(HOST_BYTE_CONTENT_TYPES, value.contentType)
    && typeof value.dataBase64 === "string"
    && decodedBase64Bytes(value.dataBase64) !== null
    && (decodedBase64Bytes(value.dataBase64) ?? HOST_BYTE_MAX_BYTES + 1) <= HOST_BYTE_MAX_BYTES;
}

export function isHostStreamQuery(value: unknown): value is HostStreamQuery {
  return isRecord(value) && hasOnlyKeys(value, ["path", "epoch", "instanceId"]) && isHostRelativePath(value.path) && isHostEpoch(value.epoch) && isHostInstanceId(value.instanceId);
}

export function isHostSocketParams(value: unknown): value is HostSocketParams {
  return isRecord(value)
    && hasOnlyKeys(value, ["epoch", "instanceId", "channel", "operationId"])
    && isHostEpoch(value.epoch)
    && isHostInstanceId(value.instanceId)
    && isListed(HOST_SOCKET_CHANNELS, value.channel)
    && isHostOperationId(value.operationId);
}

const TRANSPORT_KINDS = {
  presence: "presence",
  pair: "pair",
  presenceEvents: "presence/events",
  request: "request",
  bytes: "bytes",
  events: "events",
  resources: "resources",
  socket: "socket",
} as const;
export type HostTransportKind = keyof typeof TRANSPORT_KINDS;

export function hostTransportPath(kind: HostTransportKind, hostKey: string): string | null {
  if (!isRemoteHostKey(hostKey)) return null;
  return `/api/v1/hosts/${encodeURIComponent(hostKey)}/${TRANSPORT_KINDS[kind]}`;
}

function queryFrom(entries: readonly (readonly [string, string])[]): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.set(key, value);
  return params.toString();
}

export function hostEventsUrl(hostKey: string, query: HostStreamQuery): string | null {
  const path = hostTransportPath("events", hostKey);
  if (path === null || !isHostStreamQuery(query)) return null;
  return `${path}?${queryFrom([[HOST_PATH_QUERY, query.path], [HOST_EPOCH_QUERY, String(query.epoch)], [HOST_INSTANCE_QUERY, query.instanceId]])}`;
}

export function hostResourcesUrl(hostKey: string, query: HostStreamQuery): string | null {
  const path = hostTransportPath("resources", hostKey);
  if (path === null || !isHostStreamQuery(query)) return null;
  return `${path}?${queryFrom([[HOST_PATH_QUERY, query.path], [HOST_EPOCH_QUERY, String(query.epoch)], [HOST_INSTANCE_QUERY, query.instanceId]])}`;
}

export function hostSocketUrl(hostKey: string, params: HostSocketParams): string | null {
  const path = hostTransportPath("socket", hostKey);
  if (path === null || !isHostSocketParams(params)) return null;
  return `${path}?${queryFrom([[HOST_EPOCH_QUERY, String(params.epoch)], [HOST_INSTANCE_QUERY, params.instanceId], [HOST_SOCKET_CHANNEL_QUERY, params.channel], [HOST_SOCKET_OPERATION_QUERY, params.operationId]])}`;
}

function soleQuery(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] ?? null : null;
}

function exactQuery(params: URLSearchParams, keys: readonly string[]): boolean {
  const actual = [...params.keys()];
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function parseHostStreamQuery(params: URLSearchParams): HostStreamQuery | null {
  if (!exactQuery(params, [HOST_PATH_QUERY, HOST_EPOCH_QUERY, HOST_INSTANCE_QUERY])) return null;
  const path = soleQuery(params, HOST_PATH_QUERY);
  const epoch = parseHostEpochText(soleQuery(params, HOST_EPOCH_QUERY));
  const instanceId = soleQuery(params, HOST_INSTANCE_QUERY);
  const query = { path, epoch, instanceId };
  return isHostStreamQuery(query) ? query : null;
}

export function parseHostSocketQuery(params: URLSearchParams): HostSocketParams | null {
  if (!exactQuery(params, [HOST_EPOCH_QUERY, HOST_INSTANCE_QUERY, HOST_SOCKET_CHANNEL_QUERY, HOST_SOCKET_OPERATION_QUERY])) return null;
  const epoch = parseHostEpochText(soleQuery(params, HOST_EPOCH_QUERY));
  const instanceId = soleQuery(params, HOST_INSTANCE_QUERY);
  const channel = soleQuery(params, HOST_SOCKET_CHANNEL_QUERY);
  const operationId = soleQuery(params, HOST_SOCKET_OPERATION_QUERY);
  const parsed = { epoch, instanceId, channel, operationId };
  return isHostSocketParams(parsed) ? parsed : null;
}

function parseHostEpochText(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  const epoch = Number(value);
  return isHostEpoch(epoch) ? epoch : null;
}
