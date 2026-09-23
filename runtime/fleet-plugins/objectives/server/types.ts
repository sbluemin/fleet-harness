import { z } from "zod";

/**
 * 목표 도메인 — 서버·클라이언트가 같은 모양을 본다.
 *
 * 목표는 사람의 의도 단위, Operation은 실행 단위다. 목표 하나에 조율자 슬롯 하나, 단계마다 담당 슬롯
 * 하나만 있다(1:1). 목록은 따로 두지 않는다 — Operation 그룹이 곧 목록이며 항목은 groupId 만 참조한다.
 */

export const MAX_TITLE = 200;
export const MAX_NOTE = 20_000;
export const MAX_STEPS = 40;
export const MAX_STEP_TEXT = 200;
/** 달성 기준 — 목표가 이루어졌다고 말할 조건. 개수와 길이, 검토 때 기준마다 대는 근거 한 줄의 길이. */
export const MAX_CRITERIA = 20;
export const MAX_CRITERION_TEXT = 300;
export const MAX_EVIDENCE = 300;
/** 단계 기록 한 건의 줄 — 첫 줄이 결론, 나머지는 근거·남은 것. 산문을 한 줄에 몰아넣지 못하게 줄마다 길이를 묶는다. */
export const MAX_RECORD_LINES = 3;
export const MAX_RECORD_LINE = 160;
/** 한 단계에 남기는 기록 수 — 오래된 것부터 밀려난다. */
export const MAX_RECORDS = 20;

export type SlotBy = "human" | { readonly operationId: string };

export interface Slot {
  readonly operationId: string;
  readonly since: number;
  readonly launchedBy: SlotBy;
  readonly model?: string;
  readonly effort?: string;
  /** CLI 세션 이름 — 조율자와 담당이 서로를 부르는 주소(세션 간 메시지). 연결(link)한 Operation 에는 없다. */
  readonly sessionName?: string;
}

export interface ObjectiveStep {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly doneBy?: SlotBy;
  /** 선행 단계 id. 전부 완료돼야 이 단계가 준비된다. */
  readonly after: readonly string[];
  /** 선행마다 붙는 이유 한 줄(선행 id → why). 사람이 이은 간선은 "human". */
  readonly why?: Readonly<Record<string, string>>;
  readonly slot: Slot | null;
  /**
   * 기록 — 지휘관이 이 단계를 완료로 표시할 때마다 한 건씩 쌓인다(다시 작업해 다시 완료해도 한 건). 오래된 것부터.
   * 가장 최근 기록이 다음 단계에 넘길 내용이다.
   */
  readonly records?: readonly StepRecord[];
  /** 사람이 읽은 기록 수 — 이보다 많으면 안 읽은 기록이 있다. */
  readonly seen?: number;
  /** 사전 배정 — self: 지휘관이 직접 · route: 시작할 때 AI Gateway 라우팅이 난이도로 모델을 고름 · model: 이 모델·강도. 없으면 지휘관 프리셋. */
  readonly assign?: StepAssign;
  /**
   * 미분류 — 사람이 더했고 아직 아무도 선행을 정하지 않은 단계. 준비되지 않으며, 지휘관이 선행을 정하거나(도구의 step after·plan)
   * 사람이 편성에서 간선·「순서대로」·「병렬」로 직접 정하면 풀린다. 사람은 단계를 더하기만 하고 자리는 지휘관이 잡는다.
   */
  readonly unplaced?: true;
}

export interface StepRecord {
  readonly id: string;
  /** 남긴 시각 — 옛 결과(`result`)에서 옮긴 기록은 시각이 없다. */
  readonly at: number | null;
  /** 처음 완료인지, 기록이 이미 있는 단계를 다시 완료한 것인지. */
  readonly kind: "done" | "redone";
  /** 1–3줄. 첫 줄이 결론. */
  readonly lines: readonly string[];
  readonly by?: SlotBy;
}

export const latestRecord = (step: { readonly records?: readonly StepRecord[] }): StepRecord | null => step.records?.at(-1) ?? null;
export const unseenRecords = (step: { readonly records?: readonly StepRecord[]; readonly seen?: number }): number => Math.max(0, (step.records?.length ?? 0) - (step.seen ?? 0));

/**
 * 지휘관의 요약을 기록의 줄로 — 빈 줄은 버리고, 1–3줄이며 줄마다 160자 이하여야 한다. 맞지 않으면 null(도구가 거절한다).
 * 문자열은 줄바꿈으로 나눈다(옛 `result` 인자).
 */
export function recordLines(summary: readonly string[] | string): readonly string[] | null {
  const lines = (typeof summary === "string" ? summary.split("\n") : summary).map((line) => line.trim().replace(/^[·•*-]\s+/, "")).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_RECORD_LINES) return null;
  return lines.every((line) => line.length <= MAX_RECORD_LINE) ? lines : null;
}

export interface StepAssign {
  readonly mode: "self" | "route" | "model";
  readonly model?: string;
  readonly effort?: string;
}

/** 단계의 위임 — 배정이 없는(옛) 단계는 「지휘관 직접」으로 읽는다. 새 단계의 기본값도 같다. */
export const DEFAULT_STEP_ASSIGN: StepAssign = { mode: "self" };
export const assignModeOf = (step: { readonly assign?: StepAssign }): StepAssign["mode"] => step.assign?.mode ?? "self";

/**
 * 메모에 붙인 이미지 — 파일은 플러그인 데이터 디렉터리의 항목별 폴더에 id 이름으로 있다. 브라우저에 가는 항목에는 경로를 싣지 않는다
 * (파일은 id 로 받아 온다). 절대 경로는 지휘관의 도구 응답에만 실린다.
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

export interface ObjectiveAuthor {
  readonly kind: "human" | "operation";
  readonly operationId?: string;
  readonly title?: string;
}

export interface ObjectiveHistoryEntry {
  readonly at: number;
  readonly kind: "assign" | "release" | "replace" | "plan";
  readonly stepId?: string;
  readonly operationId?: string;
}

export interface ObjectiveDone {
  readonly at: number;
  readonly by: SlotBy;
  /** 완료하며 비운 슬롯 — 되돌리기용. `stepId` 가 없으면 조율자 슬롯. */
  readonly released: readonly { readonly stepId?: string; readonly slot: Slot }[];
}

export type LaunchView = "chat" | "terminal";

/** 지휘관에게 알릴 만한 사람의 편집 — 일정·중요 표시·모델 같은 지휘관의 일과 무관한 값은 넣지 않는다. */
export type ObjectiveEditKind = "title" | "note" | "steps" | "recipe" | "assign" | "criteria";

/**
 * 달성 기준 — 임무 목록 아래 섹션. 목표가 이루어졌다고 말할 조건 하나. 사람이 쓰고, 비어 있으면 구상 때 지휘관이 제안한다(by).
 * 충족 여부는 기준에 저장하지 않는다 — 지휘관의 달성 보고(review.criteria)에만 근거와 함께 남아, 새 작업이 검토를 거두면 함께 사라진다.
 */
export interface ObjectiveCriterion {
  readonly id: string;
  readonly text: string;
  readonly by: "human" | "commander";
  readonly at: number;
}

/** 달성 보고에 실린 기준 하나의 근거 — 지휘관이 스스로 다시 따져 충족이라고 판단한 증거 한 줄. */
export interface CriterionEvidence {
  readonly id: string;
  readonly evidence: string;
}

export interface ObjectiveItem {
  readonly id: string;
  readonly theaterId: string;
  readonly groupId: string | null;
  readonly title: string;
  readonly note: string;
  /** 메모에 붙인 이미지 — 메모 아래 띠에 붙인 순서로 선다. */
  readonly attachments?: readonly ObjectiveAttachment[];
  /** 구상에 함께 주는 맥락 — 조율자가 단계를 짤 때 읽는 사람의 프롬프트. */
  readonly cook?: string;
  /** 구상 중 — 지휘관이 단계·메모만 짜는 국면. 시작·중지·완료가 끝낸다. 이 동안은 계획을 써도 담당이 뜨지 않는다. */
  readonly cooking?: boolean;
  /** 검토 대기 — 지휘관이 모든 단계를 마쳤다고 사람에게 넘긴 상태(가승인). 완료는 사람이 검토해 누른다. 새 작업(구상·시작·단계 되돌림)이 지운다. */
  readonly review?: { readonly at: number; readonly summary: string; readonly criteria?: readonly CriterionEvidence[] };
  /** 달성 기준 — 없으면 섹션은 추가 줄만 보이고, 달성 보고는 지금처럼 모든 임무 완료만 본다. */
  readonly criteria?: readonly ObjectiveCriterion[];
  /**
   * 지휘관이 마지막으로 읽은 뒤 사람이 바꾼 것 — 지휘관이 있는 동안의 화면 편집만 쌓인다. 「시작」이 지휘관에게 한 줄로 알리고
   * 다시 읽게 한다. 지휘관이 일하는 동안 쌓이면 하단 「중단」 자리가 「스티어링」이 되어, 누르면 같은 한 줄이 간다. 지휘관이 이 항목을 읽거나(view item/mine), 새 지휘관이 뜨거나, 알림이 나가면 지워진다.
   */
  readonly edited?: { readonly at: number; readonly kinds: readonly ObjectiveEditKind[] };
  readonly important: boolean;
  readonly dueDate: string | null;
  readonly today: boolean;
  readonly done: ObjectiveDone | null;
  readonly slot: Slot | null;
  /** 조율자와 담당의 시작 옵션. view 는 담당이 없는 시작에만 효력이 있다 — 담당과 대화하는 조율자는 늘 CLI 다. */
  readonly launch: { readonly model?: string; readonly effort?: string; readonly view?: LaunchView };
  readonly steps: readonly ObjectiveStep[];
  readonly history: readonly ObjectiveHistoryEntry[];
  readonly author: ObjectiveAuthor;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ObjectiveTheaterFile {
  readonly version: 1;
  readonly items: readonly ObjectiveItem[];
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
  author: z.object({ kind: z.enum(["human", "operation"]), operationId: ids.optional(), title: z.string().max(MAX_TITLE).optional() }).optional(),
}).strict();

export const patchItemSchema = z.object({
  title: title.optional(),
  note: note.optional(),
  cook: z.string().max(4000).optional(),
  important: z.boolean().optional(),
  dueDate: dueDate.optional(),
  today: z.boolean().optional(),
  groupId: ids.nullable().optional(),
  launch: z.object({ model: z.string().max(128).optional(), effort: z.string().max(32).optional(), view: z.enum(["chat", "terminal"]).optional() }).strict().optional(),
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
  /** null 이면 배정을 지운다(지휘관 프리셋 상속). */
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

/** 조율자의 모드 — 라벨이 아니라 매번 그래프에서 계산한다. */
export type CoordinatorMode = "direct" | "coordinate" | "mixed";

/** 준비 — 미분류 단계는 자리가 정해질 때까지 준비되지 않는다. 선행 없는 단계가 곧 「병렬」로 읽히는 것을 막는다. */
export function stepReady(item: ObjectiveItem, step: ObjectiveStep): boolean {
  if (step.unplaced) return false;
  return step.after.every((id) => item.steps.find((candidate) => candidate.id === id)?.done ?? true);
}

export function coordinatorMode(item: ObjectiveItem): CoordinatorMode {
  const open = item.steps.filter((step) => !step.done);
  if (open.length === 0) return "direct";
  const assigned = open.filter((step) => step.slot).length;
  if (assigned === 0) return "direct";
  return assigned === open.length ? "coordinate" : "mixed";
}

/** 간선 추가가 순환을 만드는지 — `from` 이 `to` 의 후손이면 순환. */
export function wouldCycle(steps: readonly ObjectiveStep[], from: string, to: string): boolean {
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
export const isLoose = (step: ObjectiveStep): boolean => !!step.unplaced && !step.done;

/**
 * 편성 열 — 가장 긴 선행 사슬의 길이(선행 없음 = 0). 그래프의 열 배치와 단계 순서가 같은 값을 쓴다.
 * 순환이 남아 있어도(옛 데이터) 끝난다.
 */
export function stepDepths(steps: readonly ObjectiveStep[]): Map<string, number> {
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
 * 열(깊이)이 앞선 단계가 먼저, 같은 열이면 지금 순서를 지킨다. 그래서 선행은 늘 뒤따르는 단계보다 앞에 서고,
 * 그래프 번호는 왼쪽에서 오른쪽으로 커진다. 미분류 단계는 지금 순서대로 맨 아래.
 * 이미 편성 순이면 같은 배열을 돌려준다.
 */
export function lineupOrder(steps: readonly ObjectiveStep[]): readonly ObjectiveStep[] {
  const depth = stepDepths(steps);
  const at = new Map(steps.map((step, index) => [step.id, index]));
  const rank = (step: ObjectiveStep) => (isLoose(step) ? Number.MAX_SAFE_INTEGER : depth.get(step.id) ?? 0);
  const sorted = [...steps].sort((a, b) => rank(a) - rank(b) || at.get(a.id)! - at.get(b.id)!);
  return sorted.every((step, index) => step === steps[index]) ? steps : sorted;
}

export function hasCycle(steps: readonly ObjectiveStep[]): boolean {
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
