import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_STEP_ASSIGN,
  MAX_STEPS,
  hasCycle,
  type CreateItemInput,
  type PatchItemInput,
  type PlanInput,
  type Slot,
  type SlotBy,
  type StepAddInput,
  type StepPatchInput,
  type TodoHistoryEntry,
  type TodoItem,
  type TodoItemEvent,
  type TodoStep,
  type TodoTheaterFile,
} from "./types.js";

/**
 * Theater 별 JSON 파일 하나 — `<pluginDataDir>/<theaterId>.json`.
 *
 * Operation 스키마는 건드리지 않는다. 연결은 이쪽이 operationId 를 들고 가리킬 뿐이고, Operation 이 사라져도
 * 슬롯은 남아 「닫힘」으로 보인다(되살아나면 다시 산다). 모든 변경은 한 곳(`commit`)을 지나 파일에 쓰이고
 * 사건으로 방송된다 — 자기 변경도 재조회가 아니라 이 사건으로 화면에 닿는다.
 */

export class TodoStoreError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "TodoStoreError";
  }
}

export interface TodoStoreOptions {
  readonly dir: string;
  readonly emit: (event: TodoItemEvent) => void;
  readonly now?: () => number;
}

export interface TodoStore {
  list(theaterId: string): readonly TodoItem[];
  /** 디스크에 있는 모든 Theater 의 항목 — 감시자(담당 활동)가 훑는다. */
  all(): readonly TodoItem[];
  get(theaterId: string, itemId: string): TodoItem | null;
  find(itemId: string): TodoItem | null;
  create(input: CreateItemInput): TodoItem;
  patch(itemId: string, input: PatchItemInput): TodoItem;
  remove(itemId: string): TodoItem;
  complete(itemId: string, by: SlotBy): TodoItem;
  reopen(itemId: string): TodoItem;
  stepAdd(itemId: string, input: StepAddInput): TodoItem;
  stepPatch(itemId: string, stepId: string, input: StepPatchInput, by?: SlotBy): TodoItem;
  stepRemove(itemId: string, stepId: string): TodoItem;
  /** 간선 토글 — `from` 이 `to` 의 선행. 있으면 끊고 없으면 잇는다. */
  edgeToggle(itemId: string, from: string, to: string, why?: string): { readonly item: TodoItem; readonly linked: boolean };
  edgesLinear(itemId: string): TodoItem;
  edgesClear(itemId: string): TodoItem;
  plan(itemId: string, input: PlanInput, by: SlotBy): TodoItem;
  setSlot(itemId: string, stepId: string | null, slot: Slot | null): TodoItem;
  setCooking(itemId: string, cooking: boolean): TodoItem;
  setReview(itemId: string, review: { readonly summary: string } | null): TodoItem;
  /** 사라진 Operation 을 모든 슬롯(완료 항목의 released 포함)에서 지운다 — 바뀐 항목을 돌려준다. */
  forgetOperation(operationId: string): readonly TodoItem[];
}

function fileFor(dir: string, theaterId: string): string {
  // theaterId 는 경로 해시라 안전하지만, 그래도 파일명에 쓸 문자만 남긴다.
  const safe = theaterId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(dir, `${safe}.json`);
}

function readFile(file: string): TodoTheaterFile {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<TodoTheaterFile>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) return { version: 1, items: parsed.items as TodoItem[] };
  } catch {
    // 없거나 깨진 파일은 빈 목록으로 시작한다 — 깨진 파일은 덮어쓰지 않고 .broken 으로 비켜 둔다.
    try { if (fs.existsSync(file)) fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
  }
  return { version: 1, items: [] };
}

function writeFileAtomic(file: string, data: TodoTheaterFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function createTodoStore(options: TodoStoreOptions): TodoStore {
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, TodoItem[]>();
  const index = new Map<string, string>(); // itemId → theaterId

  const load = (theaterId: string): TodoItem[] => {
    let items = cache.get(theaterId);
    if (!items) {
      items = [...readFile(fileFor(options.dir, theaterId)).items];
      cache.set(theaterId, items);
      for (const item of items) index.set(item.id, theaterId);
    }
    return items;
  };

  const locate = (itemId: string): { theaterId: string; items: TodoItem[]; at: number; item: TodoItem } => {
    let theaterId = index.get(itemId);
    if (!theaterId) {
      // 캐시에 없는 Theater 파일을 아직 안 읽었을 수 있다 — 디렉터리를 한 번 훑는다.
      try {
        for (const entry of fs.readdirSync(options.dir)) {
          if (!entry.endsWith(".json")) continue;
          load(entry.slice(0, -5));
        }
      } catch { /* dir may not exist yet */ }
      theaterId = index.get(itemId);
    }
    if (!theaterId) throw new TodoStoreError("unknown_item");
    const items = load(theaterId);
    const at = items.findIndex((item) => item.id === itemId);
    if (at < 0) throw new TodoStoreError("unknown_item");
    return { theaterId, items, at, item: items[at]! };
  };

  const commit = (theaterId: string, items: TodoItem[], next: TodoItem | null, removedId?: string): void => {
    writeFileAtomic(fileFor(options.dir, theaterId), { version: 1, items });
    if (next) {
      index.set(next.id, theaterId);
      options.emit({ op: "upsert", theaterId, itemId: next.id, item: next });
    } else if (removedId) {
      index.delete(removedId);
      options.emit({ op: "remove", theaterId, itemId: removedId });
    }
  };

  const update = (itemId: string, mutate: (item: TodoItem) => TodoItem): TodoItem => {
    const { theaterId, items, at, item } = locate(itemId);
    const next = { ...mutate(item), updatedAt: now() };
    if (next.steps.length > MAX_STEPS) throw new TodoStoreError("too_many_steps");
    if (hasCycle(next.steps)) throw new TodoStoreError("dependency_cycle");
    items[at] = next;
    commit(theaterId, items, next);
    return next;
  };

  const withHistory = (item: TodoItem, entry: Omit<TodoHistoryEntry, "at">): TodoItem => ({ ...item, history: [...item.history.slice(-199), { at: now(), ...entry }] });

  const stepOf = (item: TodoItem, stepId: string): { at: number; step: TodoStep } => {
    const at = item.steps.findIndex((step) => step.id === stepId);
    if (at < 0) throw new TodoStoreError("unknown_step");
    return { at, step: item.steps[at]! };
  };

  const replaceStep = (item: TodoItem, at: number, step: TodoStep): TodoItem => {
    const steps = [...item.steps];
    steps[at] = step;
    return { ...item, steps };
  };

  return {
    list: (theaterId) => [...load(theaterId)],
    forgetOperation(operationId) {
      const touched: TodoItem[] = [];
      for (const item of this.all()) {
        const inSlot = item.slot?.operationId === operationId;
        const inStep = item.steps.some((step) => step.slot?.operationId === operationId);
        const inReleased = !!item.done && item.done.released.some((entry) => entry.slot.operationId === operationId);
        if (!inSlot && !inStep && !inReleased) continue;
        touched.push(update(item.id, (current) => ({
          ...current,
          slot: current.slot?.operationId === operationId ? null : current.slot,
          steps: current.steps.map((step) => (step.slot?.operationId === operationId ? { ...step, slot: null } : step)),
          done: current.done ? { ...current.done, released: current.done.released.filter((entry) => entry.slot.operationId !== operationId) } : null,
        })));
      }
      return touched;
    },
    all() {
      try { for (const entry of fs.readdirSync(options.dir)) if (entry.endsWith(".json")) load(entry.slice(0, -5)); } catch { /* dir may not exist yet */ }
      return [...cache.values()].flat();
    },
    get: (theaterId, itemId) => load(theaterId).find((item) => item.id === itemId) ?? null,
    find: (itemId) => { try { return locate(itemId).item; } catch { return null; } },

    create(input) {
      const items = load(input.theaterId);
      const at = now();
      const stepIds = (input.steps ?? []).map(() => randomUUID());
      const steps: TodoStep[] = (input.steps ?? []).map((step, ix) => ({
        id: stepIds[ix]!,
        text: step.text,
        done: false,
        after: (step.after ?? []).filter((index) => index >= 0 && index < ix).map((index) => stepIds[index]!),
        slot: null,
        assign: DEFAULT_STEP_ASSIGN,
      }));
      const item: TodoItem = {
        id: randomUUID(),
        theaterId: input.theaterId,
        groupId: input.groupId ?? null,
        title: input.title,
        note: input.note ?? "",
        important: input.important ?? false,
        dueDate: input.dueDate ?? null,
        today: input.today ?? false,
        done: null,
        slot: null,
        // 조율자 기본은 Opus · high — 사람이 바꾸기 전까지의 값이고, 카탈로그가 다르면 시작 시 호스트가 거절한다.
        launch: { model: "opus[1m]", effort: "high", view: "terminal" },
        steps,
        history: [],
        author: input.author ?? { kind: "human" },
        createdAt: at,
        updatedAt: at,
      };
      if (hasCycle(item.steps)) throw new TodoStoreError("dependency_cycle");
      items.unshift(item);
      commit(input.theaterId, items, item);
      return item;
    },

    patch: (itemId, input) => update(itemId, (item) => ({
      ...item,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.cook !== undefined ? { cook: input.cook } : {}),
      ...(input.important !== undefined ? { important: input.important } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.today !== undefined ? { today: input.today } : {}),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.launch ? { launch: { ...item.launch, ...input.launch } } : {}),
    })),

    remove(itemId) {
      const { theaterId, items, at, item } = locate(itemId);
      items.splice(at, 1);
      commit(theaterId, items, null, item.id);
      return item;
    },

    setCooking: (itemId, cooking) => update(itemId, (item) => (item.cooking === cooking ? item : cooking ? { ...item, cooking: true } : (({ cooking: _cooking, ...rest }) => rest)(item))),

    setReview: (itemId, review) => update(itemId, (item) => (review ? { ...item, review: { at: now(), summary: review.summary } } : item.review ? (({ review: _review, ...rest }) => rest)(item) : item)),

    complete: (itemId, by) => update(itemId, (item) => {
      if (item.done) return item;
      const released: TodoDoneReleased[] = [];
      if (item.slot) released.push({ slot: item.slot });
      for (const step of item.steps) if (step.slot) released.push({ stepId: step.id, slot: step.slot });
      // 완료돼도 매핑은 남는다 — 카드의 Operation 이동·묶음이 그대로 살아 있어야 한다. released 는 기록이다.
      return withHistory({ ...item, done: { at: now(), by, released }, cooking: undefined, review: undefined }, { kind: "release" });
    }),

    reopen: (itemId) => update(itemId, (item) => {
      if (!item.done) return item;
      const released = item.done.released;
      const coordinator = released.find((entry) => !entry.stepId)?.slot ?? null;
      return {
        ...item,
        done: null,
        slot: item.slot ?? coordinator,
        steps: item.steps.map((step) => {
          const restored = released.find((entry) => entry.stepId === step.id)?.slot;
          return !step.slot && restored ? { ...step, slot: restored } : step;
        }),
      };
    }),

    stepAdd: (itemId, input) => update(itemId, (item) => {
      const known = new Set(item.steps.map((step) => step.id));
      const step: TodoStep = { id: randomUUID(), text: input.text, done: false, after: (input.after ?? []).filter((id) => known.has(id)), slot: null, assign: input.assign ?? DEFAULT_STEP_ASSIGN };
      return { ...item, steps: [...item.steps, step] };
    }),

    stepPatch: (itemId, stepId, input, by) => update(itemId, (item) => {
      const { at, step } = stepOf(item, stepId);
      const known = new Set(item.steps.map((candidate) => candidate.id));
      const next: TodoStep = {
        ...step,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.done !== undefined ? { done: input.done, ...(input.done ? { doneBy: by ?? "human" } : {}) } : {}),
        ...(input.after !== undefined ? { after: input.after.filter((id) => known.has(id) && id !== stepId) } : {}),
        ...(input.assign !== undefined ? { assign: input.assign ?? undefined } : {}),
        ...(input.why !== undefined ? { why: { ...step.why, ...input.why } } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
      };
      return replaceStep(item, at, next);
    }),

    stepRemove: (itemId, stepId) => update(itemId, (item) => {
      stepOf(item, stepId);
      return {
        ...item,
        steps: item.steps.filter((step) => step.id !== stepId).map((step) => ({
          ...step,
          after: step.after.filter((id) => id !== stepId),
          ...(step.why ? { why: Object.fromEntries(Object.entries(step.why).filter(([id]) => id !== stepId)) } : {}),
        })),
      };
    }),

    edgeToggle(itemId, from, to, why) {
      let linked = false;
      const item = update(itemId, (current) => {
        stepOf(current, from);
        const { at, step } = stepOf(current, to);
        if (step.after.includes(from)) {
          linked = false;
          const nextWhy = step.why ? Object.fromEntries(Object.entries(step.why).filter(([id]) => id !== from)) : undefined;
          return replaceStep(current, at, { ...step, after: step.after.filter((id) => id !== from), ...(nextWhy ? { why: nextWhy } : {}) });
        }
        linked = true;
        return replaceStep(current, at, { ...step, after: [...step.after, from], why: { ...step.why, [from]: why ?? "human" } });
      });
      return { item, linked };
    },

    edgesLinear: (itemId) => update(itemId, (item) => ({
      ...item,
      steps: item.steps.map((step, ix) => (ix === 0 ? { ...step, after: [] } : { ...step, after: [item.steps[ix - 1]!.id], why: { [item.steps[ix - 1]!.id]: "human" } })),
    })),

    edgesClear: (itemId) => update(itemId, (item) => ({ ...item, steps: item.steps.map((step) => ({ ...step, after: [], why: {} })) })),

    plan: (itemId, input, by) => update(itemId, (item) => {
      // 완료·배정·예약된 단계와 사람이 이은 간선은 보존한다. 나머지는 조율자의 계획으로 바꾼다.
      const kept = item.steps.filter((step) => step.done || step.slot);
      const keptIds = new Set(kept.map((step) => step.id));
      const fresh: TodoStep[] = input.steps.map((step) => ({ id: randomUUID(), text: step.text, done: false, after: [], slot: null, assign: { mode: step.assign ?? "self" } }));
      const resolved: TodoStep[] = fresh.map((step, ix) => {
        const after: string[] = [];
        const why: Record<string, string> = {};
        for (const edge of input.steps[ix]!.after ?? []) {
          // stepId 는 유지되는 기존 단계(완료·배정·예약), index 는 이 계획 안의 순서.
          const targetId = edge.stepId && keptIds.has(edge.stepId) ? edge.stepId : edge.index !== undefined && edge.index !== ix ? fresh[edge.index]?.id : undefined;
          if (!targetId || after.includes(targetId)) continue;
          after.push(targetId);
          if (edge.why) why[targetId] = edge.why;
        }
        return { ...step, after, ...(Object.keys(why).length ? { why } : {}) };
      });
      const steps = [
        ...kept.map((step) => ({ ...step, after: step.after.filter((id) => keptIds.has(id)) })),
        ...resolved,
      ];
      return withHistory({ ...item, steps }, { kind: "plan", ...(typeof by === "object" ? { operationId: by.operationId } : {}) });
    }),

    setSlot: (itemId, stepId, slot) => update(itemId, (item) => {
      if (stepId === null) {
        const previous = item.slot;
        const entry: Omit<TodoHistoryEntry, "at"> = slot ? { kind: previous ? "replace" : "assign", operationId: slot.operationId } : { kind: "release", ...(previous ? { operationId: previous.operationId } : {}) };
        return withHistory({ ...item, slot }, entry);
      }
      const { at, step } = stepOf(item, stepId);
      const previous = step.slot;
      const entry: Omit<TodoHistoryEntry, "at"> = slot ? { kind: previous ? "replace" : "assign", stepId, operationId: slot.operationId } : { kind: "release", stepId, ...(previous ? { operationId: previous.operationId } : {}) };
      return withHistory(replaceStep(item, at, { ...step, slot }), entry);
    }),

  };
}

type TodoDoneReleased = { readonly stepId?: string; readonly slot: Slot };
