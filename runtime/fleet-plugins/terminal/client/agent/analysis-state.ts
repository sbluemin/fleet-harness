import type { AnalysisArtifact, AnalysisCatalog, AnalysisEvent } from "./analysis-types.js";

export interface AnalysisState {
  readonly catalog: AnalysisCatalog | null;
  readonly cliId: string;
  readonly model: string;
  readonly effort: string;
  readonly started: boolean;
  readonly busy: boolean;
  readonly output: string;
  readonly thought: string;
  readonly tools: readonly { readonly title: string; readonly status: string }[];
  readonly artifacts: readonly AnalysisArtifact[];
  readonly error: string | null;
}
export const initialAnalysisState: AnalysisState = { catalog: null, cliId: "", model: "", effort: "", started: false, busy: false, output: "", thought: "", tools: [], artifacts: [], error: null };
export type AnalysisAction =
  | { readonly type: "catalog"; readonly catalog: AnalysisCatalog }
  | { readonly type: "select-cli"; readonly cliId: string }
  | { readonly type: "select-model"; readonly model: string }
  | { readonly type: "select-effort"; readonly effort: string }
  | { readonly type: "sending"; readonly started: boolean }
  | { readonly type: "event"; readonly event: AnalysisEvent }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "clear-artifacts" };

export function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  if (action.type === "catalog") { const cli = action.catalog.clis.find((item) => item.available) ?? action.catalog.clis[0]; const model = cli?.models.find((item) => item.id === cli.defaultModel) ?? cli?.models[0]; return { ...state, catalog: action.catalog, cliId: cli?.cliId ?? "", model: model?.id ?? "", effort: model?.defaultEffort ?? model?.effortLevels[0] ?? "" }; }
  if (action.type === "select-cli" && !state.started) { const cli = state.catalog?.clis.find((item) => item.cliId === action.cliId); const model = cli?.models.find((item) => item.id === cli.defaultModel) ?? cli?.models[0]; return { ...state, cliId: action.cliId, model: model?.id ?? "", effort: model?.defaultEffort ?? model?.effortLevels[0] ?? "" }; }
  if (action.type === "select-model" && !state.started) { const model = state.catalog?.clis.find((item) => item.cliId === state.cliId)?.models.find((item) => item.id === action.model); return { ...state, model: action.model, effort: model?.defaultEffort ?? model?.effortLevels[0] ?? "" }; }
  if (action.type === "select-effort" && !state.started) return { ...state, effort: action.effort };
  if (action.type === "sending") return { ...state, started: state.started || action.started, busy: true, error: null };
  if (action.type === "error") return { ...state, busy: false, error: action.message };
  if (action.type === "clear-artifacts") return { ...state, artifacts: [] };
  if (action.type !== "event") return state;
  const event = action.event;
  if (event.type === "chunk") return { ...state, output: state.output + event.text };
  if (event.type === "thought") return { ...state, thought: state.thought + event.text };
  if (event.type === "tool") return { ...state, tools: [...state.tools.filter((tool) => tool.title !== event.title), { title: event.title, status: event.status }] };
  if (event.type === "artifact") return { ...state, artifacts: [event.artifact, ...state.artifacts.filter((artifact) => artifact.id !== event.artifact.id)] };
  if (event.type === "complete") return { ...state, busy: false };
  return { ...state, busy: false, error: event.error.message };
}
