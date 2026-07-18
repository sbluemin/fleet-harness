import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import { parseAnalysisCatalog, parseAnalysisError, parseAnalysisEvent, type AnalysisCatalog, type AnalysisError, type AnalysisEvent } from "./analysis-types.js";

export class AnalysisApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const base = (operationId: string) => `analysis/${encodeURIComponent(operationId)}`;

export async function fetchAnalysisCatalog(api: ClientApiCapability): Promise<AnalysisCatalog> {
  const response = await api.fetch("terminal", "analysis/catalog");
  const payload = await response.json().catch(() => null);
  const catalog = response.ok ? parseAnalysisCatalog(payload) : null;
  if (catalog) return catalog;
  throw errorFrom(response.status, payload);
}
export async function startAnalysis(api: ClientApiCapability, operationId: string, input: { readonly cliId: string; readonly model: string; readonly effort: string }): Promise<void> { await request(api, `${base(operationId)}/start`, input); }
export async function sendAnalysisMessage(api: ClientApiCapability, operationId: string, text: string): Promise<void> { await request(api, `${base(operationId)}/message`, { text }); }
export async function stopAnalysis(api: ClientApiCapability, operationId: string): Promise<void> { await request(api, `${base(operationId)}/stop`, {}); }
export function subscribeAnalysis(api: ClientApiCapability, operationId: string, onEvent: (event: AnalysisEvent) => void): () => void {
  return api.subscribe("terminal", `${base(operationId)}/stream`, (message) => { try { const event = parseAnalysisEvent(JSON.parse(message.data)); if (event) onEvent(event); } catch {} });
}
async function request(api: ClientApiCapability, path: string, body: Record<string, string>): Promise<void> {
  const response = await api.fetch("terminal", path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw errorFrom(response.status, await response.json().catch(() => null));
}
function errorFrom(status: number, payload: unknown): AnalysisApiError { const error: AnalysisError | null = parseAnalysisError(payload); return new AnalysisApiError(error?.code ?? `analysis_http_${status}`, error?.message ?? "Analysis is unavailable."); }
