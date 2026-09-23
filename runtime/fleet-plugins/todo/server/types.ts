import { z } from "zod";

/**
 * 할 일 도메인 — 서버·클라이언트가 같은 모양을 본다.
 *
 * 할 일은 사람의 의도 단위, Operation은 실행 단위다. 할 일 하나에 조율자 슬롯 하나, 단계마다 담당 슬롯
 * 하나만 있다(1:1). 목록은 따로 두지 않는다 — Operation 그룹이 곧 목록이며 항목은 groupId 만 참조한다.
 */

export const MAX_TITLE = 200;
export const MAX_NOTE = 20_000;
export const MAX_STEPS = 40;
export const MAX_STEP_TEXT = 200;

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

export interface TodoStep {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly doneBy?: SlotBy;
  /** 선행 단계 id. 전부 완료돼야 이 단계가 준비된다. */
  readonly after: readonly string[];
  /** 선행마다 붙는 이유 한 줄(선행 id → why). 사람이 이은 간선은 "human". */
  readonly why?: Readonly<Record<string, string>>;
  readonly slot: Slot | null;
  /** 완료 때 조율자가 남긴 산출 요약 — 다음 단계에 넘길 내용의 기록. */
  readonly result?: string;
  /** 사전 배정 — self: 셰프가 직접 · route: 시작할 때 AI Gateway 라우팅이 난이도로 모델을 고름 · model: 이 모델·강도. 없으면 셰프 프리셋. */
  readonly assign?: StepAssign;
}

export interface StepAssign {
  readonly mode: "self" | "route" | "model";
  readonly model?: string;
  readonly effort?: string;
}

/** 단계의 위임 — 배정이 없는(옛) 단계는 「셰프 직접」으로 읽는다. 새 단계의 기본값도 같다. */
export const DEFAULT_STEP_ASSIGN: StepAssign = { mode: "self" };
export const assignModeOf = (step: { readonly assign?: StepAssign }): StepAssign["mode"] => step.assign?.mode ?? "self";

export interface TodoAuthor {
  readonly kind: "human" | "operation";
  readonly operationId?: string;
  readonly title?: string;
}

export interface TodoHistoryEntry {
  readonly at: number;
  readonly kind: "assign" | "release" | "replace" | "plan";
  readonly stepId?: string;
  readonly operationId?: string;
}

export interface TodoDone {
  readonly at: number;
  readonly by: SlotBy;
  /** 완료하며 비운 슬롯 — 되돌리기용. `stepId` 가 없으면 조율자 슬롯. */
  readonly released: readonly { readonly stepId?: string; readonly slot: Slot }[];
}

export type LaunchView = "chat" | "terminal";

/** 셰프에게 알릴 만한 사람의 편집 — 일정·중요 표시·모델 같은 셰프의 일과 무관한 값은 넣지 않는다. */
export type TodoEditKind = "title" | "note" | "steps" | "recipe" | "assign";

export interface TodoItem {
  readonly id: string;
  readonly theaterId: string;
  readonly groupId: string | null;
  readonly title: string;
  readonly note: string;
  /** 쿠킹에 함께 주는 맥락 — 조율자가 단계를 짤 때 읽는 사람의 프롬프트. */
  readonly cook?: string;
  /** 쿠킹 중 — 셰프가 단계·메모만 짜는 국면. 시작·중지·완료가 끝낸다. 이 동안은 계획을 써도 담당이 뜨지 않는다. */
  readonly cooking?: boolean;
  /** 검토 대기 — 셰프가 모든 단계를 마쳤다고 사람에게 넘긴 상태(가승인). 완료는 사람이 검토해 누른다. 새 작업(쿠킹·시작·단계 되돌림)이 지운다. */
  readonly review?: { readonly at: number; readonly summary: string };
  /**
   * 셰프가 마지막으로 읽은 뒤 사람이 바꾼 것 — 셰프가 있는 동안의 화면 편집만 쌓인다. 「시작」이 셰프에게 한 줄로 알리고
   * 다시 읽게 한다. 셰프가 이 항목을 읽거나(view item/mine), 새 셰프가 뜨거나, 알림이 나가면 지워진다.
   */
  readonly edited?: { readonly at: number; readonly kinds: readonly TodoEditKind[] };
  readonly important: boolean;
  readonly dueDate: string | null;
  readonly today: boolean;
  readonly done: TodoDone | null;
  readonly slot: Slot | null;
  /** 조율자와 담당의 시작 옵션. view 는 담당이 없는 시작에만 효력이 있다 — 담당과 대화하는 조율자는 늘 CLI 다. */
  readonly launch: { readonly model?: string; readonly effort?: string; readonly view?: LaunchView };
  readonly steps: readonly TodoStep[];
  readonly history: readonly TodoHistoryEntry[];
  readonly author: TodoAuthor;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TodoTheaterFile {
  readonly version: 1;
  readonly items: readonly TodoItem[];
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
export const stepAddSchema = z.object({ text: stepText, after: z.array(ids).max(MAX_STEPS).optional(), assign: stepAssignSchema.nullable().optional() }).strict();
export const stepPatchSchema = z.object({
  text: stepText.optional(),
  done: z.boolean().optional(),
  after: z.array(ids).max(MAX_STEPS).optional(),
  why: z.record(ids, z.string().max(300)).optional(),
  result: z.string().max(4000).optional(),
  /** null 이면 배정을 지운다(셰프 프리셋 상속). */
  assign: stepAssignSchema.nullable().optional(),
}).strict();

export const planSchema = z.object({
  steps: z.array(z.object({
    text: stepText,
    // index 는 이 plan 의 steps 순서, stepId 는 이미 있는(완료·배정된) 단계 — 새 단계가 기존 단계 뒤에 설 수 있다.
    after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).max(MAX_STEPS).optional(),
    /** 셰프의 위임 판단 — self 는 직접, route 는 라우팅으로 담당을 띄움. 없으면 self. */
    assign: z.enum(["self", "route"]).optional(),
  })).min(1).max(MAX_STEPS),
}).strict();

export type CreateItemInput = z.output<typeof createItemSchema>;
export type PatchItemInput = z.output<typeof patchItemSchema>;
export type StepAddInput = z.output<typeof stepAddSchema>;
export type StepPatchInput = z.output<typeof stepPatchSchema>;
export type PlanInput = z.output<typeof planSchema>;

/** 브라우저·Console Use 양쪽으로 나가는 사건 프레임. */
export const TODO_ITEM_CHANNEL = "todo:item";
export interface TodoItemEvent {
  readonly op: "upsert" | "remove";
  readonly theaterId: string;
  readonly itemId: string;
  readonly item?: TodoItem;
  /** 순서가 바뀌었을 때만 — 그 Theater 항목 id 의 새 순서 전체. 받는 쪽은 이 순서로 다시 줄 세운다. */
  readonly order?: readonly string[];
}

/** 조율자의 모드 — 라벨이 아니라 매번 그래프에서 계산한다. */
export type CoordinatorMode = "direct" | "coordinate" | "mixed";

export function stepReady(item: TodoItem, step: TodoStep): boolean {
  return step.after.every((id) => item.steps.find((candidate) => candidate.id === id)?.done ?? true);
}

export function coordinatorMode(item: TodoItem): CoordinatorMode {
  const open = item.steps.filter((step) => !step.done);
  if (open.length === 0) return "direct";
  const assigned = open.filter((step) => step.slot).length;
  if (assigned === 0) return "direct";
  return assigned === open.length ? "coordinate" : "mixed";
}

/** 간선 추가가 순환을 만드는지 — `from` 이 `to` 의 후손이면 순환. */
export function wouldCycle(steps: readonly TodoStep[], from: string, to: string): boolean {
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

export function hasCycle(steps: readonly TodoStep[]): boolean {
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
