import type { AnalysisArtifact, AnalysisCatalog, AnalysisEvent, AnalysisSelection } from "./analysis-types.js";

// Must match the server's MAX_ANALYSIS_ARTIFACTS per-operation cap.
export const MAX_ANALYSIS_ARTIFACTS = 32;

export interface AnalysisEntry { readonly role: "user" | "analyst"; readonly text: string; readonly at?: number; }
export type AnalysisPhase = "idle" | "starting" | "reasoning" | "tool" | "writing" | "complete" | "stopped" | "error";
export type AnalysisActivity =
  | { readonly kind: "starting"; readonly connected: boolean }
  | { readonly kind: "reasoning" }
  | { readonly kind: "tool"; readonly title: string; readonly status: string }
  | { readonly kind: "writing" };

export interface AnalysisState {
  readonly catalog: AnalysisCatalog | null;
  readonly cliId: string;
  readonly model: string;
  readonly effort: string;
  readonly draft: string;
  readonly queue: readonly string[];
  readonly started: boolean;
  readonly busy: boolean;
  readonly phase: AnalysisPhase;
  readonly latestActivity: AnalysisActivity | null;
  readonly runStartedAt: number | null;
  readonly runEndedAt: number | null;
  readonly entries: readonly AnalysisEntry[];
  readonly tools: readonly { readonly title: string; readonly status: string }[];
  readonly artifacts: readonly AnalysisArtifact[];
  readonly artifactAuthoring: { readonly startedAt: number } | null;
  readonly artifactPublished: { readonly artifact: AnalysisArtifact; readonly durationMs: number | null } | null;
  readonly artifactsAutoOpenArmed: boolean;
  readonly selectionLocked: boolean;
  readonly selectionSaved: boolean;
  readonly error: string | null;
}

export const initialAnalysisState: AnalysisState = {
  catalog: null,
  cliId: "",
  model: "",
  effort: "",
  draft: "",
  queue: [],
  started: false,
  busy: false,
  phase: "idle",
  latestActivity: null,
  runStartedAt: null,
  runEndedAt: null,
  entries: [],
  tools: [],
  artifacts: [],
  artifactAuthoring: null,
  artifactPublished: null,
  artifactsAutoOpenArmed: true,
  selectionLocked: false,
  selectionSaved: false,
  error: null,
};

export type AnalysisAction =
  | { readonly type: "catalog"; readonly catalog: AnalysisCatalog; readonly selection?: AnalysisSelection | null }
  | { readonly type: "select-cli"; readonly cliId: string }
  | { readonly type: "select-model"; readonly model: string }
  | { readonly type: "select-effort"; readonly effort: string }
  | { readonly type: "set-draft"; readonly draft: string }
  | { readonly type: "queue-push"; readonly text: string }
  | { readonly type: "queue-cancel"; readonly index: number }
  | { readonly type: "queue-clear" }
  | { readonly type: "sending"; readonly started: boolean; readonly text: string; readonly now: number }
  | { readonly type: "event"; readonly event: AnalysisEvent; readonly now: number }
  | { readonly type: "error"; readonly message: string; readonly now: number }
  | { readonly type: "session-lost"; readonly now: number }
  | { readonly type: "start-failed"; readonly message: string; readonly now: number }
  | { readonly type: "stopped"; readonly now: number }
  | { readonly type: "stop-failed"; readonly message: string; readonly now: number }
  | { readonly type: "reset"; readonly selection?: AnalysisSelection | null }
  | { readonly type: "selection-lock"; readonly locked: boolean }
  | { readonly type: "selection-saved" }
  | { readonly type: "selection-saved-clear" }
  | { readonly type: "clear-artifacts" }
  | { readonly type: "artifacts-chip-disarm" }
  | { readonly type: "artifacts-chip-rearm" };

export function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  if (action.type === "catalog") {
    return { ...state, catalog: action.catalog, ...resolvePersistedSelection(action.catalog, action.selection) };
  }
  if (action.type === "select-cli" && !state.started) {
    const cli = state.catalog?.clis.find((item) => item.cliId === action.cliId);
    const model = cli?.models.find((item) => item.id === cli.defaultModel) ?? cli?.models[0];
    return { ...state, cliId: action.cliId, model: model?.id ?? "", effort: model?.defaultEffort ?? model?.effortLevels[0] ?? "" };
  }
  if (action.type === "select-model" && !state.started) {
    const model = state.catalog?.clis.find((item) => item.cliId === state.cliId)?.models.find((item) => item.id === action.model);
    return { ...state, model: action.model, effort: model?.defaultEffort ?? model?.effortLevels[0] ?? "" };
  }
  if (action.type === "select-effort" && !state.started) return { ...state, effort: action.effort };
  if (action.type === "set-draft") return { ...state, draft: action.draft };
  if (action.type === "queue-push") return { ...state, queue: [...state.queue, action.text] };
  if (action.type === "queue-cancel") {
    if (action.index < 0 || action.index >= state.queue.length) return state;
    return { ...state, queue: state.queue.filter((_, index) => index !== action.index) };
  }
  if (action.type === "queue-clear") return state.queue.length > 0 ? { ...state, queue: [] } : state;
  if (action.type === "sending") return {
    ...state,
    started: state.started || action.started,
    busy: true,
    phase: "starting",
    latestActivity: { kind: "starting", connected: !action.started },
    runStartedAt: action.now,
    runEndedAt: null,
    error: null,
    tools: [],
    artifactAuthoring: null,
    artifactPublished: null,
    entries: [...state.entries, { role: "user", text: action.text, at: action.now }],
  };
  if (action.type === "error") return endWithError(state, action.message, action.now);
  if (action.type === "session-lost") return { ...endWithError(state, "Analysis session ended — send again to restart.", action.now), started: false };
  if (action.type === "start-failed") return { ...endWithError(state, action.message, action.now), started: false };
  if (action.type === "stopped") return { ...state, queue: [], started: false, busy: false, phase: "stopped", runEndedAt: action.now, artifactAuthoring: null, error: null };
  if (action.type === "stop-failed") return { ...endWithError(state, `Stop failed: ${action.message}`, action.now), started: false };
  if (action.type === "reset") {
    const catalog = state.catalog;
    return catalog
      ? { ...initialAnalysisState, catalog, selectionLocked: state.selectionLocked, ...resolvePersistedSelection(catalog, action.selection) }
      : { ...initialAnalysisState, selectionLocked: state.selectionLocked };
  }
  if (action.type === "selection-lock") return state.selectionLocked === action.locked ? state : { ...state, selectionLocked: action.locked };
  if (action.type === "selection-saved") return { ...state, selectionSaved: true };
  if (action.type === "selection-saved-clear") return state.selectionSaved ? { ...state, selectionSaved: false } : state;
  // Clear는 완료 카드도 함께 걷는다 — 삭제된 artifact를 여는 CTA가 남으면 안 된다.
  if (action.type === "clear-artifacts") return { ...state, artifacts: [], artifactPublished: null, artifactsAutoOpenArmed: true };
  if (action.type === "artifacts-chip-disarm") return state.artifactsAutoOpenArmed ? { ...state, artifactsAutoOpenArmed: false } : state;
  if (action.type === "artifacts-chip-rearm") return state.artifactsAutoOpenArmed ? state : { ...state, artifactsAutoOpenArmed: true };
  if (action.type !== "event") return state;

  const event = action.event;
  if (event.type === "connected") {
    return state.phase === "starting" ? { ...state, latestActivity: { kind: "starting", connected: true } } : state;
  }
  if (event.type === "chunk") return { ...state, phase: "writing", latestActivity: { kind: "writing" }, entries: appendAnalystChunk(state.entries, event.text, action.now) };
  // Thought content is deliberately neither stored nor rendered; only the observed event advances the phase.
  if (event.type === "thought") return { ...state, phase: "reasoning", latestActivity: { kind: "reasoning" } };
  if (event.type === "tool") {
    const status = event.status.toLowerCase();
    const isArtifactAuthoring = event.title.toLowerCase().includes("publish_artifact") && (status === "pending" || status === "in_progress");
    return {
      ...state,
      phase: "tool",
      latestActivity: { kind: "tool", title: event.title, status: event.status },
      tools: [...state.tools.filter((tool) => tool.title !== event.title), { title: event.title, status: event.status }],
      ...(isArtifactAuthoring ? { artifactAuthoring: state.artifactAuthoring ?? { startedAt: action.now }, artifactPublished: null } : {}),
    };
  }
  if (event.type === "artifact") return {
    ...state,
    artifacts: [event.artifact, ...state.artifacts.filter((artifact) => artifact.id !== event.artifact.id)].slice(0, MAX_ANALYSIS_ARTIFACTS),
    artifactPublished: { artifact: event.artifact, durationMs: state.artifactAuthoring ? action.now - state.artifactAuthoring.startedAt : null },
    artifactAuthoring: null,
  };
  // artifact 이벤트 없이 턴이 끝나면(툴 거부·실패) 저작 카드가 영구히 남지 않도록 함께 종료한다.
  if (event.type === "complete") return { ...state, busy: false, phase: "complete", runEndedAt: action.now, artifactAuthoring: null, error: null };
  return endWithError(state, event.error.message, action.now);
}

function resolveInitialSelection(catalog: AnalysisCatalog): Pick<AnalysisState, "cliId" | "model" | "effort"> {
  const cli = catalog.clis.find((item) => item.cliId === "claude" && item.available)
    ?? catalog.clis.find((item) => item.available)
    ?? catalog.clis[0];
  const model = cli?.models.find((item) => cli.cliId === "claude" && item.id === "sonnet")
    ?? cli?.models.find((item) => item.id === cli.defaultModel)
    ?? cli?.models[0];
  const effort = model?.effortLevels.includes("medium")
    ? "medium"
    : model?.defaultEffort ?? model?.effortLevels[0] ?? "";
  return { cliId: cli?.cliId ?? "", model: model?.id ?? "", effort };
}

function resolvePersistedSelection(catalog: AnalysisCatalog, selection?: AnalysisSelection | null): Pick<AnalysisState, "cliId" | "model" | "effort"> {
  const fallback = resolveInitialSelection(catalog);
  if (!selection) return fallback;
  const persistedCli = catalog.clis.find((item) => item.cliId === selection.cliId && item.available);
  const cli = persistedCli ?? catalog.clis.find((item) => item.cliId === fallback.cliId);
  if (!cli) return fallback;
  const fallbackModel = persistedCli
    ? cli.models.find((item) => item.id === cli.defaultModel) ?? cli.models[0]
    : cli.models.find((item) => item.id === fallback.model)
      ?? cli.models.find((item) => item.id === cli.defaultModel)
      ?? cli.models[0];
  const persistedModel = cli.models.find((item) => item.id === selection.model);
  const model = persistedModel ?? fallbackModel;
  if (!model) return { cliId: cli.cliId, model: "", effort: "" };
  const fallbackEffort = model.effortLevels.includes("medium")
    ? "medium"
    : model.defaultEffort ?? model.effortLevels[0] ?? "";
  const effort = model.effortLevels.length === 0
    ? (selection.effort === "" ? "" : fallbackEffort)
    : (model.effortLevels.includes(selection.effort) ? selection.effort : fallbackEffort);
  return { cliId: cli.cliId, model: model.id, effort };
}

function endWithError(state: AnalysisState, message: string, now: number): AnalysisState {
  return { ...state, queue: [], busy: false, phase: "error", runEndedAt: now, artifactAuthoring: null, error: message };
}

function appendAnalystChunk(entries: readonly AnalysisEntry[], text: string, now: number): readonly AnalysisEntry[] {
  const last = entries.at(-1);
  return last?.role === "analyst" ? [...entries.slice(0, -1), { ...last, text: last.text + text }] : [...entries, { role: "analyst", text, at: now }];
}
