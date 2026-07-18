export interface AnalysisModel {
  readonly id: string;
  readonly label: string;
  readonly effortLevels: readonly string[];
  readonly defaultEffort?: string;
}

export interface AnalysisCli {
  readonly cliId: string;
  readonly label: string;
  readonly available: boolean;
  readonly defaultModel?: string;
  readonly models: readonly AnalysisModel[];
}

export interface AnalysisCatalog { readonly clis: readonly AnalysisCli[]; }
export interface AnalysisError { readonly code: string; readonly message: string; }
export interface AnalysisArtifact { readonly id: string; readonly title: string; readonly html: string; readonly createdAt: number; }
export type AnalysisEvent =
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "thought"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "artifact"; readonly artifact: AnalysisArtifact }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: AnalysisError };

export const FORBIDDEN_ANALYSIS_KEYS = new Set(["path", "cwd", "canonicalcwd", "transcriptpath", "providersession", "sessionid", "token", "ticket", "url", "mcpurl", "rawtranscript"]);
export const MAX_ARTIFACT_BYTES = 50 * 1024;
export const ARTIFACT_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`;

export function hasForbiddenAnalysisKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenAnalysisKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_ANALYSIS_KEYS.has(key.toLowerCase()) || hasForbiddenAnalysisKey(child));
}

export function parseAnalysisCatalog(value: unknown): AnalysisCatalog | null {
  if (hasForbiddenAnalysisKey(value) || !isRecord(value) || !Array.isArray(value.clis)) return null;
  const clis = value.clis.map(parseCli);
  return clis.every((cli): cli is AnalysisCli => cli !== null) ? { clis } : null;
}

export function parseAnalysisEvent(value: unknown): AnalysisEvent | null {
  if (hasForbiddenAnalysisKey(value) || !isRecord(value) || typeof value.type !== "string") return null;
  if ((value.type === "chunk" || value.type === "thought") && typeof value.text === "string") return { type: value.type, text: value.text };
  if (value.type === "tool" && typeof value.title === "string" && typeof value.status === "string") return { type: "tool", title: value.title, status: value.status };
  if (value.type === "complete") return { type: "complete" };
  if (value.type === "error" && isError(value.error)) return { type: "error", error: value.error };
  if (value.type === "artifact" && isRecord(value.artifact) && typeof value.artifact.id === "string" && typeof value.artifact.title === "string" && typeof value.artifact.html === "string" && typeof value.artifact.createdAt === "number" && utf8Size(value.artifact.html) <= MAX_ARTIFACT_BYTES) return { type: "artifact", artifact: { id: value.artifact.id, title: value.artifact.title, html: value.artifact.html, createdAt: value.artifact.createdAt } };
  return null;
}

export function parseAnalysisError(value: unknown): AnalysisError | null {
  return !hasForbiddenAnalysisKey(value) && isRecord(value) && isError(value.error) ? value.error : null;
}

function parseCli(value: unknown): AnalysisCli | null {
  if (!isRecord(value) || typeof value.cliId !== "string" || typeof value.label !== "string" || typeof value.available !== "boolean" || !Array.isArray(value.models)) return null;
  const models = value.models.map((model): AnalysisModel | null => isRecord(model) && typeof model.id === "string" && typeof model.label === "string" && Array.isArray(model.effortLevels) && model.effortLevels.every((effort) => typeof effort === "string") ? { id: model.id, label: model.label, effortLevels: model.effortLevels, defaultEffort: typeof model.defaultEffort === "string" ? model.defaultEffort : undefined } : null);
  return models.every((model): model is AnalysisModel => model !== null) ? { cliId: value.cliId, label: value.label, available: value.available, defaultModel: typeof value.defaultModel === "string" ? value.defaultModel : undefined, models } : null;
}
function isError(value: unknown): value is AnalysisError { return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function utf8Size(value: string): number { return new TextEncoder().encode(value).byteLength; }
