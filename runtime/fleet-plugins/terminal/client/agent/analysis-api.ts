import type { ClientApiCapability, ConsoleTheme } from "@fleet-console/sdk/plugin";
import { ApiError } from "@fleet-console/sdk/operations/browser";
import { parseAnalysisCatalog, parseAnalysisError, parseAnalysisEvent, type AnalysisCatalog, type AnalysisError, type AnalysisEvent, type AnalysisSelection } from "./analysis-types.js";

export class AnalysisApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const base = (operationId: string) => `analysis/${encodeURIComponent(operationId)}`;
const GLOBAL_STREAM_URL = "/plugins/terminal/analysis/stream";
const SESSION_NOT_FOUND: AnalysisEvent = { type: "error", error: { code: "analysis_session_not_found", message: "Analysis session was not found." } };
const RECREATE_BASE_DELAY_MS = 250;
const RECREATE_MAX_DELAY_MS = 4_000;

type OperationListener = (event: AnalysisEvent) => void;
interface OperationRecord {
  listeners: Set<OperationListener>;
  confirmedEpoch: number | null;
}

let physicalSource: EventSource | null = null;
let physicalSourceId = 0;
let rosterEpoch = 0;
let lastRoster = new Set<string>();
let rosterFresh = false;
let pendingRecreateTimer: ReturnType<typeof setTimeout> | null = null;
let recreateDelayMs = RECREATE_BASE_DELAY_MS;
const operations = new Map<string, OperationRecord>();

/**
 * 아티팩트 문서에 넘기는 Console 테마 좌표(v2). ground/foreground만 필수이고 나머지는 서버가
 * 단계적으로 폴백한다 — 값이 비면 아예 싣지 않아 서버 폴백이 그대로 서게 둔다.
 * ground/card는 콘솔 패널면 기준이다(v1의 ink-veil/ink-deep은 깊이 방향을 역전시켰다).
 */
export type ArtifactThemeColors = {
  readonly ground: string;
  readonly foreground: string;
  readonly card?: string;
  readonly inset?: string;
  readonly hairline?: string;
  readonly hairlineStrong?: string;
  readonly accent?: string;
  readonly muted?: string;
  readonly faint?: string;
  readonly positive?: string;
  readonly warn?: string;
  readonly critical?: string;
  readonly focus?: string;
  /** 콘솔 번들 @font-face에서 읽은 same-origin 서체 경로 — 문서가 콘솔 서체를 잇는다. */
  readonly sansFont?: string;
  readonly monoFont?: string;
};

const ARTIFACT_OPTIONAL_PARAMS = ["card", "inset", "hairline", "hairlineStrong", "accent", "muted", "faint", "positive", "warn", "critical", "focus", "sansFont", "monoFont"] as const;

export function analysisArtifactUrl(artifactId: string, theme: ConsoleTheme, colors: ArtifactThemeColors): string {
  const query = new URLSearchParams({ theme, ground: colors.ground, foreground: colors.foreground });
  for (const key of ARTIFACT_OPTIONAL_PARAMS) {
    const value = colors[key];
    if (value) query.set(key, value);
  }
  return `/plugins/terminal/analysis/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`;
}

export async function fetchAnalysisCatalog(api: ClientApiCapability): Promise<AnalysisCatalog> {
  const response = await fetchOrThrow(api, "analysis/catalog");
  const payload = await response.json().catch(() => null);
  const catalog = parseAnalysisCatalog(payload);
  if (catalog) return catalog;
  throw errorFrom(response.status, payload);
}
export async function fetchAnalysisReady(api: ClientApiCapability, operationId: string): Promise<boolean> {
  try {
    const response = await fetchOrThrow(api, `${base(operationId)}/ready`);
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return !!payload && typeof payload === "object" && !Array.isArray(payload) && (payload as { ready?: unknown }).ready === true;
  } catch {
    return false;
  }
}
export async function startAnalysis(api: ClientApiCapability, operationId: string, input: AnalysisSelection & { readonly language?: "en" | "ko" }, signal?: AbortSignal): Promise<void> { await request(api, `${base(operationId)}/start`, input, signal); }
export async function sendAnalysisMessage(api: ClientApiCapability, operationId: string, text: string): Promise<void> { await request(api, `${base(operationId)}/message`, { text }); }
export async function stopAnalysis(api: ClientApiCapability, operationId: string): Promise<void> { await request(api, `${base(operationId)}/stop`, {}); }
export async function clearAnalysisArtifacts(api: ClientApiCapability, operationId: string): Promise<void> {
  const response = await fetchOrThrow(api, `${base(operationId)}/artifacts`, { method: "DELETE" });
  if (!response.ok) throw errorFrom(response.status, await response.json().catch(() => null));
}

export function subscribeAnalysis(_api: ClientApiCapability, operationId: string, onEvent: (event: AnalysisEvent) => void): () => void {
  return subscribeOperation(operationId, onEvent);
}

export function resetAnalysisStreamHubForTests(): void {
  cancelPendingRecreate();
  markRosterStale();
  physicalSource?.close();
  physicalSource = null;
  physicalSourceId = 0;
  rosterEpoch = 0;
  lastRoster = new Set();
  resetRecreateBackoff();
  operations.clear();
}

function subscribeOperation(operationId: string, listener: OperationListener): () => void {
  let record = operations.get(operationId);
  if (!record) {
    record = { listeners: new Set(), confirmedEpoch: null };
    operations.set(operationId, record);
  }
  record.listeners.add(listener);
  ensurePhysicalSource();
  queueMicrotask(() => {
    if (!record!.listeners.has(listener)) return;
    if (physicalSource?.readyState !== EventSource.OPEN) return;
    if (!rosterFresh || !lastRoster.has(operationId)) return;
    if (record!.confirmedEpoch !== null) return;
    record!.confirmedEpoch = rosterEpoch;
    listener({ type: "connected" });
  });
  return () => {
    record!.listeners.delete(listener);
    if (record!.listeners.size === 0) operations.delete(operationId);
    closePhysicalIfIdle();
  };
}

function hasSubscribers(): boolean {
  for (const record of operations.values()) {
    if (record.listeners.size > 0) return true;
  }
  return false;
}

function markRosterStale(): void {
  rosterFresh = false;
}

function resetRecreateBackoff(): void {
  recreateDelayMs = RECREATE_BASE_DELAY_MS;
}

function cancelPendingRecreate(): void {
  if (pendingRecreateTimer === null) return;
  clearTimeout(pendingRecreateTimer);
  pendingRecreateTimer = null;
}

function closePhysicalIfIdle(): void {
  if (hasSubscribers()) return;
  cancelPendingRecreate();
  markRosterStale();
  physicalSource?.close();
  physicalSource = null;
  resetRecreateBackoff();
}

function replacePhysicalSource(): void {
  cancelPendingRecreate();
  markRosterStale();
  physicalSource?.close();
  physicalSourceId += 1;
  const sourceId = physicalSourceId;
  const source = new EventSource(GLOBAL_STREAM_URL);
  physicalSource = source;
  bindSourceHandlers(source, sourceId);
}

function ensurePhysicalSource(): void {
  if (physicalSource && physicalSource.readyState !== EventSource.CLOSED) return;
  if (physicalSource?.readyState === EventSource.CLOSED) {
    if (hasSubscribers()) scheduleBoundedRecreate();
    return;
  }
  replacePhysicalSource();
}

function bindSourceHandlers(source: EventSource, sourceId: number): void {
  source.onmessage = (message) => {
    if (physicalSource !== source || physicalSourceId !== sourceId) return;
    if (typeof message.data === "string") dispatchWirePayload(message.data, sourceId);
  };
  source.onerror = () => {
    if (physicalSource !== source || physicalSourceId !== sourceId) return;
    markRosterStale();
    if (source.readyState === EventSource.CONNECTING) return;
    if (source.readyState === EventSource.CLOSED && hasSubscribers()) scheduleBoundedRecreate();
  };
}

function scheduleBoundedRecreate(): void {
  if (pendingRecreateTimer !== null) return;
  const delay = recreateDelayMs;
  recreateDelayMs = Math.min(recreateDelayMs * 2, RECREATE_MAX_DELAY_MS);
  pendingRecreateTimer = setTimeout(() => {
    pendingRecreateTimer = null;
    if (!hasSubscribers()) return;
    if (physicalSource !== null && physicalSource.readyState !== EventSource.CLOSED) return;
    replacePhysicalSource();
  }, delay);
}

function dispatchToOperation(operationId: string, event: AnalysisEvent): void {
  const record = operations.get(operationId);
  if (!record) return;
  for (const listener of record.listeners) listener(event);
}

function applyRoster(operationIds: readonly string[], sourceId: number): void {
  if (physicalSourceId !== sourceId) return;
  const rosterSet = new Set(operationIds);
  for (const [operationId, record] of operations) {
    if (record.confirmedEpoch !== null && !rosterSet.has(operationId)) {
      dispatchToOperation(operationId, SESSION_NOT_FOUND);
      record.confirmedEpoch = null;
    }
  }
  rosterEpoch += 1;
  lastRoster = rosterSet;
  rosterFresh = true;
  resetRecreateBackoff();
  for (const operationId of operationIds) {
    const record = operations.get(operationId);
    if (!record) continue;
    record.confirmedEpoch = rosterEpoch;
    dispatchToOperation(operationId, { type: "connected" });
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function parseConnectedFrame(payload: Record<string, unknown>): readonly string[] | null {
  if (!hasExactKeys(payload, new Set(["type", "operationIds"]))) return null;
  if (payload.type !== "connected") return null;
  if (!Array.isArray(payload.operationIds)) return null;
  for (const value of payload.operationIds) {
    if (typeof value !== "string") return null;
  }
  return payload.operationIds as string[];
}

function parseEventFrame(payload: Record<string, unknown>): { readonly operationId: string; readonly event: AnalysisEvent } | null {
  if (!hasExactKeys(payload, new Set(["type", "operationId", "event"]))) return null;
  if (payload.type !== "event") return null;
  if (typeof payload.operationId !== "string") return null;
  if (!payload.event || typeof payload.event !== "object" || Array.isArray(payload.event)) return null;
  const event = parseAnalysisEvent(payload.event);
  if (!event) return null;
  return { operationId: payload.operationId, event };
}

function dispatchWirePayload(raw: string, sourceId: number): void {
  if (physicalSourceId !== sourceId) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const payload = parsed as Record<string, unknown>;
  const connected = parseConnectedFrame(payload);
  if (connected) {
    applyRoster(connected, sourceId);
    return;
  }
  const eventFrame = parseEventFrame(payload);
  if (eventFrame) dispatchToOperation(eventFrame.operationId, eventFrame.event);
}

async function request(api: ClientApiCapability, path: string, body: object, signal?: AbortSignal): Promise<void> {
  const response = await fetchOrThrow(api, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  if (!response.ok) throw errorFrom(response.status, await response.json().catch(() => null));
}
// SDK api.fetch는 non-2xx에서 본문을 ApiError.body로 실어 throw한다 — 동결 오류 DTO를 복원해 코드 기반 분기를 가능하게 한다.
async function fetchOrThrow(api: ClientApiCapability, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await api.fetch("terminal", path, init);
  } catch (error) {
    if (error instanceof ApiError) throw errorFrom(error.status, error.body);
    throw error;
  }
}
function errorFrom(status: number, payload: unknown): AnalysisApiError { const error: AnalysisError | null = parseAnalysisError(payload); return new AnalysisApiError(error?.code ?? `analysis_http_${status}`, error?.message ?? "Analysis is unavailable."); }
