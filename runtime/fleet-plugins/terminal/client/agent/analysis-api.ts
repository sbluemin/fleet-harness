import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import { ApiError } from "@fleet-console/sdk/operations/browser";
import { parseAnalysisCatalog, parseAnalysisError, parseAnalysisEvent, type AnalysisCatalog, type AnalysisError, type AnalysisEvent } from "./analysis-types.js";

export class AnalysisApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const base = (operationId: string) => `analysis/${encodeURIComponent(operationId)}`;
export const analysisArtifactUrl = (artifactId: string): string => `/plugins/terminal/analysis/artifacts/${encodeURIComponent(artifactId)}`;

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
export async function startAnalysis(api: ClientApiCapability, operationId: string, input: { readonly cliId: string; readonly model: string; readonly effort: string }): Promise<void> { await request(api, `${base(operationId)}/start`, input); }
export async function sendAnalysisMessage(api: ClientApiCapability, operationId: string, text: string): Promise<void> { await request(api, `${base(operationId)}/message`, { text }); }
export async function stopAnalysis(api: ClientApiCapability, operationId: string): Promise<void> { await request(api, `${base(operationId)}/stop`, {}); }
export async function clearAnalysisArtifacts(api: ClientApiCapability, operationId: string): Promise<void> {
  const response = await fetchOrThrow(api, `${base(operationId)}/artifacts`, { method: "DELETE" });
  if (!response.ok) throw errorFrom(response.status, await response.json().catch(() => null));
}
export function subscribeAnalysis(api: ClientApiCapability, operationId: string, onEvent: (event: AnalysisEvent) => void): () => void {
  return api.subscribe("terminal", `${base(operationId)}/stream`, (message) => { try { const event = parseAnalysisEvent(JSON.parse(message.data)); if (event) onEvent(event); } catch {} });
}
async function request(api: ClientApiCapability, path: string, body: Record<string, string>): Promise<void> {
  const response = await fetchOrThrow(api, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
