import { z } from "zod";

/**
 * 목표 도메인 — 저장 모양과 화면 모양을 가른다.
 *
 * 목표는 곧 그 지휘관 Operation 이다. 목표의 식별자·제목·그룹·Theater·만든 시각·모델 프리셋·세션 이름은 Operation 이
 * 이미 들고 있으므로 저장하지 않는다 — `state.json` 에는 목표에만 있는 값(브리핑·임무·기준·일정)만 남고, 화면과 지휘관
 * 도구가 보는 `ObjectiveItem` 은 서버가 Operation 과 합쳐 만든다. 검토 대기도 저장하지 않는다 — 모든 임무와 기준이
 * 끝났는지에서 매번 계산한다.
 */

export const MAX_TITLE = 120;
export const MAX_NOTE = 20_000;
export const MAX_STEPS = 40;
export const MAX_STEP_TEXT = 200;
/** 달성 기준 — 목표가 이루어졌다고 말할 조건. 개수와 길이, 충족 근거 한 줄의 길이. */
export const MAX_CRITERIA = 20;
export const MAX_CRITERION_TEXT = 300;
export const MAX_EVIDENCE = 300;
/** 단계 기록 한 건의 줄 — 첫 줄이 결론, 나머지는 근거·남은 것. 산문을 한 줄에 몰아넣지 못하게 줄마다 길이를 묶는다. */
export const MAX_RECORD_LINES = 3;
export const MAX_RECORD_LINE = 160;
/** 한 단계에 남기는 기록 수 — 오래된 것부터 밀려난다. */
export const MAX_RECORDS = 20;

export type SlotBy = "human" | { readonly operationId: string };

export interface StepAssign {
  readonly mode: "self" | "route" | "model";
  readonly model?: string;
  readonly effort?: string;
}

/** 단계의 위임 — 배정이 없는 단계는 「지휘관 직접」으로 읽는다. 새 단계의 기본값도 같다. */
export const assignModeOf = (step: { readonly assign?: StepAssign }): StepAssign["mode"] => step.assign?.mode ?? "self";

/**
 * 메모에 붙인 이미지 — 파일은 목표 저장소의 `attachments/<operationId>/` 에 id 이름으로 있다. 브라우저에 가는 항목에는 경로를
 * 싣지 않는다(파일은 id 로 받아 온다). 절대 경로는 지휘관의 도구 응답에만 실린다.
 */
export interface ObjectiveAttachment {
  readonly id: string;
  /** 「이미지 n」의 n — 붙인 순서로 늘고, 지워도 다른 번호가 밀리지 않는다(메모가 번호로 가리킨다). */
  readonly n: number;
  readonly name: string;
  readonly type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly at: number;
}

/** 지휘관에게 알릴 만한 사람의 편집 — 일정·중요 표시·모델 같은 지휘관의 일과 무관한 값은 넣지 않는다. */
export type ObjectiveEditKind = "title" | "note" | "steps" | "recipe" | "assign" | "criteria";

// ═══ 저장 모양 (state.json) ══════════════════════════════════════════════════

/** 선행 하나 — 선행 단계 id 와, 있으면 그 선행을 둔 이유 한 줄. 사람이 이은 간선은 "human". */
export interface StoredEdge {
  readonly id: string;
  readonly why?: string;
}

/** 단계 기록 — 지휘관이 이 단계를 완료로 표시할 때마다 한 건. 남기는 것은 늘 그 목표의 지휘관이고, 종류(처음·다시)는 위치로 안다. */
export interface StoredRecord {
  readonly id: string;
  readonly at: number;
  /** 1–3줄. 첫 줄이 결론. */
  readonly lines: readonly string[];
}

export interface StoredStep {
  readonly id: string;
  readonly text: string;
  readonly done?: true;
  readonly after: readonly StoredEdge[];
  /** 사전 배정 — 없으면 지휘관 직접(self). */
  readonly assign?: StepAssign;
  /**
   * 미분류 — 사람이 더했고 아직 아무도 선행을 정하지 않은 단계. 준비되지 않으며, 지휘관이 선행을 정하거나
   * 사람이 편성에서 간선·「순서대로」·「병렬」로 직접 정하면 풀린다.
   */
  readonly unplaced?: true;
  /** 담당 Operation — 지휘관이 위임했을 때만. 모델·세션 이름은 그 Operation 이 들고 있다. */
  readonly operationId?: string;
  readonly records?: readonly StoredRecord[];
  /** 사람이 읽은 기록 수 — 이보다 많으면 안 읽은 기록이 있다. */
  readonly seen?: number;
}

/**
 * 달성 기준 — 사람이 쓰고, 비어 있으면 구상 때 지휘관이 제안한다(by). `met` 은 지휘관이 스스로 따져 충족이라고 판단한
 * 근거 한 줄이다 — 문구가 바뀌거나 새 작업이 생기면 지워진다.
 */
export interface StoredCriterion {
  readonly id: string;
  readonly text: string;
  readonly by: "human" | "commander";
  readonly met?: string;
}

export interface StoredObjective {
  /** 지휘관 Operation id — 목표의 유일한 식별자. */
  readonly operationId: string;
  readonly note: string;
  /** 구상에 함께 주는 맥락 — 조율자가 단계를 짤 때 읽는 사람의 프롬프트. */
  readonly cook?: string;
  /** 구상 중 — 지휘관이 단계·메모만 짜는 국면. 시작·중지·완료가 끝낸다. */
  readonly cooking?: true;
  readonly attachments?: readonly ObjectiveAttachment[];
  readonly important?: true;
  readonly dueDate?: string;
  readonly today?: true;
  /** 에이전트가 도구로 더한 목표 — 더한 Operation. 사람이 만든 목표에는 없다. */
  readonly addedBy?: string;
  /**
   * 지휘관이 마지막으로 읽은 뒤 사람이 바꾼 것 — 「시작」·「스티어링」이 지휘관에게 한 줄로 알리고 다시 읽게 한다.
   * 지휘관이 이 항목을 읽거나 알림이 나가면 지워진다.
   */
  readonly edited?: { readonly at: number; readonly kinds: readonly ObjectiveEditKind[] };
  /** 목표 완료 — 완료는 늘 사람이 누른다. */
  readonly done?: { readonly at: number };
  readonly criteria?: readonly StoredCriterion[];
  readonly steps: readonly StoredStep[];
}

export interface ObjectivesFile {
  readonly version: 2;
  /** 배열 순서가 보드 순서다. */
  readonly objectives: readonly StoredObjective[];
}

// ═══ 화면 모양 (서버가 Operation 과 합쳐 만든다) ═══════════════════════════

export interface StepRecord {
  readonly id: string;
  readonly at: number;
  /** 처음 완료인지, 기록이 이미 있는 단계를 다시 완료한 것인지 — 위치에서 나온다. */
  readonly kind: "done" | "redone";
  readonly lines: readonly string[];
}

export interface ObjectiveStep {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  /** 선행 단계 id. 전부 완료돼야 이 단계가 준비된다. */
  readonly after: readonly string[];
  /** 선행마다 붙는 이유 한 줄(선행 id → why). */
  readonly why: Readonly<Record<string, string>>;
  readonly assign?: StepAssign;
  readonly unplaced?: true;
  /** 담당 Operation — 위임했을 때만. */
  readonly operationId: string | null;
  /** 담당 세션 이름·모델·강도 — 담당 Operation 에서 읽는다. */
  readonly sessionName: string | null;
  readonly model?: string;
  readonly effort?: string;
  readonly records: readonly StepRecord[];
  readonly seen: number;
}

export interface ObjectiveCriterion {
  readonly id: string;
  readonly text: string;
  readonly by: "human" | "commander";
  /** 충족 근거 — 지휘관이 충족으로 표시했을 때만. */
  readonly met?: string;
}

export interface ObjectiveItem {
  /** 지휘관 Operation id. */
  readonly id: string;
  readonly theaterId: string;
  readonly groupId: string | null;
  readonly title: string;
  readonly createdAt: number;
  /** 지휘관 세션 — 이름·모델·강도·한 번이라도 깨었는지는 지휘관 Operation 에서 읽는다. */
  readonly commander: { readonly sessionName: string | null; readonly model?: string; readonly effort?: string; readonly started: boolean };
  readonly note: string;
  readonly attachments: readonly ObjectiveAttachment[];
  readonly cook?: string;
  readonly cooking: boolean;
  readonly edited?: { readonly at: number; readonly kinds: readonly ObjectiveEditKind[] };
  readonly important: boolean;
  readonly dueDate: string | null;
  readonly today: boolean;
  readonly addedBy: { readonly operationId: string; readonly title: string | null } | null;
  readonly done: { readonly at: number } | null;
  /** 검토 대기 — 끝나지 않은 목표의 모든 임무와 모든 달성 기준이 끝났다. 저장하지 않고 계산한다. 완료는 사람이 누른다. */
  readonly awaitingReview: boolean;
  readonly criteria: readonly ObjectiveCriterion[];
  readonly steps: readonly ObjectiveStep[];
}

export const latestRecord = (step: { readonly records: readonly StepRecord[] }): StepRecord | null => step.records.at(-1) ?? null;
export const unseenRecords = (step: { readonly records: readonly StepRecord[]; readonly seen: number }): number => Math.max(0, step.records.length - step.seen);

/**
 * 지휘관의 요약을 기록의 줄로 — 빈 줄은 버리고, 1–3줄이며 줄마다 160자 이하여야 한다. 맞지 않으면 null(도구가 거절한다).
 */
export function recordLines(summary: readonly string[]): readonly string[] | null {
  const lines = summary.map((line) => line.trim().replace(/^[·•*-]\s+/, "")).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_RECORD_LINES) return null;
  return lines.every((line) => line.length <= MAX_RECORD_LINE) ? lines : null;
}

/** 검토 대기 — 임무가 하나 이상 있고 모두 끝났으며, 달성 기준이 모두 충족으로 표시됐다. */
export function awaitingReview(objective: Pick<StoredObjective, "done" | "steps" | "criteria">): boolean {
  if (objective.done || objective.steps.length === 0) return false;
  return objective.steps.every((step) => step.done) && (objective.criteria ?? []).every((criterion) => !!criterion.met);
}

/** 기준의 충족 표시를 모두 거둔다 — 새 작업이 생기면 앞선 판단은 옛 보드에 대한 것이다. */
export function withoutMet<T extends Pick<StoredObjective, "criteria">>(objective: T): T {
  if (!objective.criteria?.some((criterion) => criterion.met)) return objective;
  return { ...objective, criteria: objective.criteria.map(({ met: _met, ...rest }) => rest) };
}

// ═══ 편성(의존 그래프) ═══════════════════════════════════════════════════════

/** 그래프 계산이 보는 단계의 최소 모양 — 저장 단계와 화면 단계 모두 이 모양으로 읽힌다. */
export interface GraphStep {
  readonly id: string;
  readonly done?: boolean;
  readonly after: readonly string[];
  readonly unplaced?: true;
}

export const graphOf = (steps: readonly StoredStep[]): readonly GraphStep[] => steps.map((step) => ({ id: step.id, done: !!step.done, after: step.after.map((edge) => edge.id), ...(step.unplaced ? { unplaced: true as const } : {}) }));

/** 준비 — 미분류 단계는 자리가 정해질 때까지 준비되지 않는다. 선행 없는 단계가 곧 「병렬」로 읽히는 것을 막는다. */
export function stepReady(steps: readonly GraphStep[], step: GraphStep): boolean {
  if (step.unplaced) return false;
  return step.after.every((id) => steps.find((candidate) => candidate.id === id)?.done ?? true);
}

/** 조율자의 모드 — 라벨이 아니라 매번 그래프에서 계산한다. */
export type CoordinatorMode = "direct" | "coordinate" | "mixed";

export function coordinatorMode(steps: readonly { readonly done?: boolean; readonly operationId?: string | null }[]): CoordinatorMode {
  const open = steps.filter((step) => !step.done);
  if (open.length === 0) return "direct";
  const assigned = open.filter((step) => step.operationId).length;
  if (assigned === 0) return "direct";
  return assigned === open.length ? "coordinate" : "mixed";
}

/** 간선 추가가 순환을 만드는지 — `from` 이 `to` 의 후손이면 순환. */
export function wouldCycle(steps: readonly GraphStep[], from: string, to: string): boolean {
  if (from === to) return true;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of byId.get(current)?.after ?? []) stack.push(parent);
  }
  return false;
}

/** 편성에 아직 자리가 없는 단계 — 사람이 선행 없이 더했고 끝나지 않았다. 그래프의 「미분류」 칸과 목록 맨 아래에 선다. */
export const isLoose = (step: GraphStep): boolean => !!step.unplaced && !step.done;

/**
 * 편성 열 — 가장 긴 선행 사슬의 길이(선행 없음 = 0). 그래프의 열 배치와 단계 순서가 같은 값을 쓴다.
 */
export function stepDepths(steps: readonly GraphStep[]): Map<string, number> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const step = byId.get(id);
    const value = step && step.after.length ? Math.max(...step.after.map((parent) => (byId.has(parent) ? depthOf(parent, seen) + 1 : 0))) : 0;
    depth.set(id, value);
    return value;
  };
  for (const step of steps) if (!isLoose(step)) depthOf(step.id, new Set());
  return depth;
}

/**
 * 편성 순 — 목록·번호·지휘관 도구의 index·담당 세션 이름이 모두 이 순서를 쓴다.
 * 열(깊이)이 앞선 단계가 먼저, 같은 열이면 지금 순서를 지킨다. 미분류 단계는 지금 순서대로 맨 아래.
 * 이미 편성 순이면 같은 배열을 돌려준다.
 */
export function lineupOrder<S extends StoredStep>(steps: readonly S[]): readonly S[] {
  const graph = graphOf(steps);
  const depth = stepDepths(graph);
  const at = new Map(steps.map((step, index) => [step.id, index]));
  const rank = (step: S, index: number) => (isLoose(graph[index]!) ? Number.MAX_SAFE_INTEGER : depth.get(step.id) ?? 0);
  const ranked = steps.map((step, index) => ({ step, rank: rank(step, index) }));
  const sorted = [...ranked].sort((a, b) => a.rank - b.rank || at.get(a.step.id)! - at.get(b.step.id)!).map((entry) => entry.step);
  return sorted.every((step, index) => step === steps[index]) ? steps : sorted;
}

export function hasCycle(steps: readonly GraphStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(id, 1);
    for (const parent of byId.get(id)?.after ?? []) if (byId.has(parent) && visit(parent)) return true;
    state.set(id, 2);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

// ═══ wire schemas ═════════════════════════════════════════════════════════════

const ids = z.string().min(1).max(128);
const title = z.string().trim().min(1).max(MAX_TITLE);
const note = z.string().max(MAX_NOTE);
const stepText = z.string().trim().min(1).max(MAX_STEP_TEXT);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const createItemSchema = z.object({
  theaterId: ids,
  language: z.enum(["en", "ko"]).optional(),
  groupId: ids.nullable().optional(),
  title,
  note: note.optional(),
  important: z.boolean().optional(),
  dueDate: dueDate.optional(),
  today: z.boolean().optional(),
  steps: z.array(z.object({ text: stepText, after: z.array(z.number().int().min(0)).optional() })).max(MAX_STEPS).optional(),
}).strict();

export const patchItemSchema = z.object({
  title: title.optional(),
  note: note.optional(),
  cook: z.string().max(4000).optional(),
  important: z.boolean().optional(),
  dueDate: dueDate.optional(),
  today: z.boolean().optional(),
  groupId: ids.nullable().optional(),
  /** 지휘관 모델·강도 — 지휘관 Operation 에 쓴다. */
  launch: z.object({ model: z.string().max(128).optional(), effort: z.string().max(32).optional() }).strict().optional(),
}).strict();

export const stepAssignSchema = z.object({ mode: z.enum(["self", "route", "model"]), model: z.string().max(128).optional(), effort: z.string().max(32).optional() }).strict();
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
export const criterionAddSchema = z.object({ text: criterionText }).strict();
export const criterionPatchSchema = z.object({ text: criterionText }).strict();

export const stepAddSchema = z.object({ text: stepText, after: z.array(ids).max(MAX_STEPS).optional(), assign: stepAssignSchema.nullable().optional() }).strict();
export const stepPatchSchema = z.object({
  text: stepText.optional(),
  done: z.boolean().optional(),
  after: z.array(ids).max(MAX_STEPS).optional(),
  why: z.record(ids, z.string().max(300)).optional(),
  /** null 이면 배정을 지운다(지휘관 직접). */
  assign: stepAssignSchema.nullable().optional(),
}).strict();

export const planSchema = z.object({
  steps: z.array(z.object({
    text: stepText,
    // index 는 이 plan 의 steps 순서, stepId 는 이미 있는(완료·배정된) 단계 — 새 단계가 기존 단계 뒤에 설 수 있다.
    after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).max(MAX_STEPS).optional(),
    /** 지휘관의 위임 판단 — self 는 직접, route 는 라우팅으로 담당을 띄움. 없으면 self. */
    assign: z.enum(["self", "route"]).optional(),
  })).min(1).max(MAX_STEPS),
}).strict();

export type CreateItemInput = z.output<typeof createItemSchema>;
export type PatchItemInput = z.output<typeof patchItemSchema>;
export type StepAddInput = z.output<typeof stepAddSchema>;
export type StepPatchInput = z.output<typeof stepPatchSchema>;
export type PlanInput = z.output<typeof planSchema>;

/** 브라우저·Console Use 양쪽으로 나가는 사건 프레임. */
export const OBJECTIVE_ITEM_CHANNEL = "objectives:item";
export interface ObjectiveItemEvent {
  readonly op: "upsert" | "remove";
  readonly theaterId: string;
  readonly itemId: string;
  readonly item?: ObjectiveItem;
  /** 순서가 바뀌었을 때만 — 그 Theater 항목 id 의 새 순서 전체. 받는 쪽은 이 순서로 다시 줄 세운다. */
  readonly order?: readonly string[];
}
