import type { AnalysisArtifact, AnalysisCatalog, AnalysisEvent, AnalysisOrigin } from "./analysis-types.js";

// Must match the server's MAX_ANALYSIS_ARTIFACTS per-operation cap.
export const MAX_ANALYSIS_ARTIFACTS = 32;

/* 턴이 끝나는 순간 그 턴의 결과를 엔트리에 봉인한다 — 전역 상태는 다음 send에서 초기화되므로,
   역사 턴의 헤드·영수증·노드 상태는 이 메타데이터만이 정직하게 말할 수 있다. */
export interface AnalysisToolStep { readonly title: string; readonly status: string; }
export interface AnalysisTurnReceipt {
  readonly outcome: "complete" | "stopped" | "error";
  readonly durationMs: number;
  readonly tools: readonly AnalysisToolStep[];
  /* 실패 턴의 사유 — 전역 error는 다음 send가 지우므로 역사 턴은 이 값만 말할 수 있다. */
  readonly error?: string;
}
/* 구간 = 모델의 문장 하나와 그 문장으로 한 일(채팅뷰 원장과 같은 단위). 텍스트가 흐르는 동안은
   같은 구간에 붙고, 도구가 한 번이라도 낀 뒤의 텍스트는 새 구간을 연다 — 중간 서술과 최종 답이
   한 덩어리로 병합되던 v1(`last.text + text`)의 봉합 자국이 여기서 사라진다. */
export interface AnalysisSegment { readonly text: string; readonly steps: readonly AnalysisToolStep[]; }
export type AnalysisEntry =
  | { readonly role: "user"; readonly text: string; readonly at?: number; readonly by?: AnalysisOrigin }
  | { readonly role: "analyst"; readonly segments: readonly AnalysisSegment[]; readonly at?: number; readonly receipt?: AnalysisTurnReceipt };

/* 원장을 과정과 확정 답으로 가른다. 답 = 도구가 뒤따르지 않은 마지막 텍스트 구간.
   스트리밍 중에도 같은 규칙이다 — 꼬리 구간에 도구가 붙는 순간 그 구간은 과정으로 승격되고,
   다음 텍스트가 새 답 후보를 연다. */
export function splitAnalystLedger(segments: readonly AnalysisSegment[]): { readonly process: readonly AnalysisSegment[]; readonly answer: AnalysisSegment | null } {
  const last = segments.at(-1);
  if (last && last.text !== "" && last.steps.length === 0) return { process: segments.slice(0, -1), answer: last };
  return { process: segments, answer: null };
}
export type AnalysisPhase = "idle" | "starting" | "reasoning" | "tool" | "writing" | "complete" | "stopped" | "error";
export type AnalysisActivity =
  | { readonly kind: "starting"; readonly connected: boolean }
  | { readonly kind: "reasoning" }
  | { readonly kind: "tool"; readonly title: string; readonly status: string }
  | { readonly kind: "writing" };

export interface AnalysisState {
  readonly catalog: AnalysisCatalog | null;
  /** 실행 좌표 — Settings › 실험 기능 › AI 확장 › Session Analyst의 값. 패널은 고르지 않고 보여 주기만 한다. */
  readonly cliId: string;
  readonly model: string;
  readonly effort: string;
  readonly modelFallback: boolean;
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
  /* 모드는 캡션의 세그먼트가 바꾸고 본문이 따른다 — 두 슬롯이 서로 다른 React 서브트리라
     지역 상태로는 공유되지 않는다. */
  readonly viewMode: "chat" | "artifacts";
  readonly error: string | null;
}

export const initialAnalysisState: AnalysisState = {
  catalog: null,
  cliId: "",
  model: "",
  effort: "",
  modelFallback: false,
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
  viewMode: "chat",
  error: null,
};

export type AnalysisAction =
  | { readonly type: "catalog"; readonly catalog: AnalysisCatalog }
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
  | { readonly type: "reset" }
  | { readonly type: "clear-artifacts" }
  | { readonly type: "view-mode"; readonly mode: "chat" | "artifacts" }
  /** 서버 원장으로 화면을 채운다 — 에이전트가 시작·질문한 분석가도 사람에게 같은 대화로 보인다. */
  | { readonly type: "hydrate"; readonly started: boolean; readonly model?: string; readonly entries: readonly { readonly at: number; readonly event: AnalysisEvent }[]; readonly now: number };

export function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  if (action.type === "catalog") {
    // 진행 중 세션의 좌표는 시작 때 값으로 잠긴다 — 목록은 갱신하되 표시 좌표는 갈아끼우지 않는다.
    return state.started ? { ...state, catalog: action.catalog } : { ...state, catalog: action.catalog, ...resolveCatalogSelection(action.catalog) };
  }
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
  if (action.type === "stopped") return { ...state, queue: [], started: false, busy: false, phase: "stopped", runEndedAt: action.now, artifactAuthoring: null, error: null, entries: sealLastAnalystEntry(state, "stopped", action.now) };
  if (action.type === "stop-failed") {
    // stop은 낙관적으로 stopped를 먼저 봉인한다 — 실패가 오면 그 봉인을 error로 승격해
    // 역사 턴이 "정상 중단"으로 남지 않게 한다. durationMs·tools는 중단 시점 값을 유지한다.
    const message = `Stop failed: ${action.message}`;
    return { ...endWithError({ ...state, entries: upgradeStoppedReceipt(state.entries, message) }, message, action.now), started: false };
  }
  if (action.type === "reset") {
    const catalog = state.catalog;
    return catalog ? { ...initialAnalysisState, catalog, ...resolveCatalogSelection(catalog) } : initialAnalysisState;
  }
  // Clear는 완료 카드도 함께 걷는다 — 삭제된 artifact를 여는 CTA가 남으면 안 된다.
  if (action.type === "clear-artifacts") return { ...state, artifacts: [], artifactPublished: null };
  if (action.type === "view-mode") return state.viewMode === action.mode ? state : { ...state, viewMode: action.mode };
  if (action.type === "hydrate") {
    let next: AnalysisState = { ...state, started: action.started, ...(action.model ? { model: action.model } : {}), entries: [], tools: [], busy: false, phase: "idle", error: null };
    for (const row of action.entries) next = analysisReducer(next, { type: "event", event: row.event, now: row.at });
    // 마지막 질문에 답이 아직 없으면 턴이 도는 중이다 — 스트림이 이어 그린다.
    const last = next.entries[next.entries.length - 1];
    if (last?.role === "user") next = { ...next, busy: true, phase: "starting", latestActivity: { kind: "starting", connected: true }, runStartedAt: last.at ?? action.now, runEndedAt: null };
    return next;
  }
  if (action.type !== "event") return state;

  const event = action.event;
  if (event.type === "connected") {
    return state.phase === "starting" ? { ...state, latestActivity: { kind: "starting", connected: true } } : state;
  }
  if (event.type === "user") {
    // 사람의 질문은 보낼 때 이미 로컬로 섰다 — 같은 글이 에코로 오면 겹치지 않게 한다. 에이전트의 질문은 여기서만 선다.
    const last = state.entries[state.entries.length - 1];
    if (!event.by && last?.role === "user" && last.text === event.text && !last.by) return state;
    return { ...state, entries: [...state.entries, { role: "user", text: event.text, at: event.at, ...(event.by ? { by: event.by } : {}) }], busy: true, phase: state.phase === "idle" || state.phase === "complete" ? "starting" : state.phase, runStartedAt: event.at, runEndedAt: null, error: null };
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
      entries: attachAnalystToolStep(state.entries, event.title, event.status, action.now),
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
  if (event.type === "complete") return { ...state, busy: false, phase: "complete", runEndedAt: action.now, artifactAuthoring: null, error: null, entries: sealLastAnalystEntry(state, "complete", action.now) };
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

/** 서버가 정한 좌표를 그대로 싣는다 — 응답에 좌표가 없으면(구버전 호스트) 카탈로그 기본으로 내려간다. */
function resolveCatalogSelection(catalog: AnalysisCatalog): Pick<AnalysisState, "cliId" | "model" | "effort" | "modelFallback"> {
  const selection = catalog.selection;
  if (selection) return { cliId: selection.cliId, model: selection.model, effort: selection.effort, modelFallback: selection.fallback };
  return { ...resolveInitialSelection(catalog), modelFallback: false };
}

function endWithError(state: AnalysisState, message: string, now: number): AnalysisState {
  return { ...state, queue: [], busy: false, phase: "error", runEndedAt: now, artifactAuthoring: null, error: message, entries: sealLastAnalystEntry(state, "error", now, message) };
}

function upgradeStoppedReceipt(entries: readonly AnalysisEntry[], error: string): readonly AnalysisEntry[] {
  const last = entries.at(-1);
  if (last?.role !== "analyst" || last.receipt?.outcome !== "stopped") return entries;
  return [...entries.slice(0, -1), { ...last, receipt: { ...last.receipt, outcome: "error", error } }];
}

function sealLastAnalystEntry(state: AnalysisState, outcome: AnalysisTurnReceipt["outcome"], now: number, error?: string): readonly AnalysisEntry[] {
  const last = state.entries.at(-1);
  if (last?.role === "analyst" && last.receipt) return state.entries;
  const durationMs = state.runStartedAt === null ? 0 : Math.max(0, now - state.runStartedAt);
  const receipt: AnalysisTurnReceipt = { outcome, durationMs, tools: state.tools, ...(error !== undefined ? { error } : {}) };
  // chunk 없이 끝난 턴(시작 실패·조기 중단·도구 전용 런)도 빈 분석가 엔트리로 봉인한다 —
  // 봉인하지 않으면 다음 send가 전역 상태를 초기화한 뒤 그 턴 전체가 역사에서 사라진다.
  if (last?.role !== "analyst") {
    if (last?.role !== "user") return state.entries;
    return [...state.entries, { role: "analyst", segments: [], at: now, receipt }];
  }
  return [...state.entries.slice(0, -1), { ...last, receipt }];
}

function appendAnalystChunk(entries: readonly AnalysisEntry[], text: string, now: number): readonly AnalysisEntry[] {
  const last = entries.at(-1);
  if (last?.role !== "analyst") return [...entries, { role: "analyst", segments: [{ text, steps: [] }], at: now }];
  const segment = last.segments.at(-1);
  // 도구가 낀 구간 뒤의 텍스트는 새 구간이다 — 과정 문장과 답이 다시는 병합되지 않는다.
  const segments = !segment
    ? [{ text, steps: [] as readonly AnalysisToolStep[] }]
    : segment.steps.length > 0
      ? [...last.segments, { text, steps: [] as readonly AnalysisToolStep[] }]
      : [...last.segments.slice(0, -1), { ...segment, text: segment.text + text }];
  return [...entries.slice(0, -1), { ...last, segments }];
}

/* 도구 스텝은 지금 열려 있는 구간에 붙는다 — 문장 없이 도구부터 시작한 턴은 빈 문장의
   구간을 연다(채팅뷰의 문장 없는 스텝 줄과 동형). 같은 구간 안의 같은 제목은 상태 갱신이다. */
function attachAnalystToolStep(entries: readonly AnalysisEntry[], title: string, status: string, now: number): readonly AnalysisEntry[] {
  const last = entries.at(-1);
  if (last?.role !== "analyst") {
    if (last?.role !== "user") return entries;
    return [...entries, { role: "analyst", segments: [{ text: "", steps: [{ title, status }] }], at: now }];
  }
  const segment = last.segments.at(-1) ?? { text: "", steps: [] as readonly AnalysisToolStep[] };
  const steps = [...segment.steps.filter((step) => step.title !== title), { title, status }];
  const segments = last.segments.length === 0
    ? [{ ...segment, steps }]
    : [...last.segments.slice(0, -1), { ...segment, steps }];
  return [...entries.slice(0, -1), { ...last, segments }];
}
