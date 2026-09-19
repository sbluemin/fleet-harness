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

/** 서버가 Settings › 실험 기능 › AI 확장 › Session Analyst를 카탈로그와 대조해 정한 실행 좌표. */
export interface AnalysisSelection {
  readonly cliId: string;
  readonly model: string;
  readonly effort: string;
  /** 설정의 모델이 목록에 없어(꺼진 Gateway 모델) Sonnet으로 내려간 상태. */
  readonly fallback: boolean;
}
export interface AnalysisCatalog { readonly clis: readonly AnalysisCli[]; readonly selection?: AnalysisSelection; }
export interface AnalysisError { readonly code: string; readonly message: string; }
export interface AnalysisArtifact { readonly id: string; readonly title: string; readonly html: string; readonly createdAt: number; }
/** 사람이 아닌 질문자 — Console Use 로 물은 Operation. 제목만 온다. */
export type AnalysisOrigin = { readonly kind: "operation"; readonly operationId: string; readonly title: string } | { readonly kind: "plugin"; readonly pluginId: string };
export function analysisOriginLabel(origin: AnalysisOrigin): string { return origin.kind === "operation" ? origin.title : origin.pluginId; }

export type AnalysisEvent =
  | { readonly type: "connected" }
  /** 원장 항목 — 질문 하나가 접수됐다(사람의 것도, 에이전트의 것도). */
  | { readonly type: "user"; readonly text: string; readonly at: number; readonly by?: AnalysisOrigin }
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "thought"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "artifact"; readonly artifact: AnalysisArtifact }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: AnalysisError };

const FORBIDDEN_ANALYSIS_KEYS = new Set(["path", "cwd", "canonicalcwd", "transcriptpath", "providersession", "sessionid", "token", "ticket", "url", "mcpurl", "rawtranscript"]);
export const MAX_ARTIFACT_BYTES = 50 * 1024;

function hasForbiddenAnalysisKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenAnalysisKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_ANALYSIS_KEYS.has(key.toLowerCase()) || hasForbiddenAnalysisKey(child));
}

export function parseAnalysisCatalog(value: unknown): AnalysisCatalog | null {
  if (hasForbiddenAnalysisKey(value) || !isRecord(value) || !Array.isArray(value.clis)) return null;
  const clis = value.clis.map(parseCli);
  if (!clis.every((cli): cli is AnalysisCli => cli !== null)) return null;
  const selection = parseSelection(value.selection);
  return selection ? { clis, selection } : { clis };
}

export function parseAnalysisEvent(value: unknown): AnalysisEvent | null {
  if (hasForbiddenAnalysisKey(value) || !isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "connected") return { type: "connected" };
  if (value.type === "user" && typeof value.text === "string" && typeof value.at === "number") {
    const by = isRecord(value.by) ? (value.by.kind === "operation" && typeof value.by.operationId === "string" ? { kind: "operation" as const, operationId: value.by.operationId, title: typeof value.by.title === "string" ? value.by.title : value.by.operationId } : value.by.kind === "plugin" && typeof value.by.pluginId === "string" ? { kind: "plugin" as const, pluginId: value.by.pluginId } : undefined) : undefined;
    return { type: "user", text: value.text, at: value.at, ...(by ? { by } : {}) };
  }
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
function parseSelection(value: unknown): AnalysisSelection | undefined {
  if (!isRecord(value) || typeof value.cliId !== "string" || typeof value.model !== "string" || typeof value.effort !== "string") return undefined;
  return { cliId: value.cliId, model: value.model, effort: value.effort, fallback: value.fallback === true };
}
function isError(value: unknown): value is AnalysisError { return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function utf8Size(value: string): number { return new TextEncoder().encode(value).byteLength; }
