import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ATTACHMENT_TYPES, MAX_ATTACHMENTS } from "./attachments.js";
import {
  DEFAULT_STEP_ASSIGN,
  MAX_CRITERIA,
  MAX_RECORDS,
  MAX_STEPS,
  hasCycle,
  lineupOrder,
  type CreateItemInput,
  type CriterionEvidence,
  type ObjectiveCriterion,
  type PatchItemInput,
  type PlanInput,
  type Slot,
  type SlotBy,
  type StepAddInput,
  type StepRecord,
  type ObjectiveAttachment,
  type StepPatchInput,
  type ObjectiveEditKind,
  type ObjectiveHistoryEntry,
  type ObjectiveItem,
  type ObjectiveItemEvent,
  type ObjectiveStep,
  type ObjectiveTheaterFile,
} from "./types.js";

/**
 * Theater 별 JSON 파일 하나 — `<pluginDataDir>/<theaterId>.json`.
 *
 * Operation 스키마는 건드리지 않는다. 연결은 이쪽이 operationId 를 들고 가리킬 뿐이고, Operation 이 사라져도
 * 슬롯은 남아 「닫힘」으로 보인다(되살아나면 다시 산다). 모든 변경은 한 곳(`commit`)을 지나 파일에 쓰이고
 * 사건으로 방송된다 — 자기 변경도 재조회가 아니라 이 사건으로 화면에 닿는다.
 */

export class ObjectiveStoreError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "ObjectiveStoreError";
  }
}

export interface ObjectiveStoreOptions {
  readonly dir: string;
  /** 메모 첨부의 뿌리 — `<attachmentsDir>/<theaterId>/<itemId>/<attachmentId>.<ext>`. 없으면 `<dir>/../attachments`. */
  readonly attachmentsDir?: string;
  readonly emit: (event: ObjectiveItemEvent) => void;
  readonly now?: () => number;
}

export interface ObjectiveStore {
  list(theaterId: string): readonly ObjectiveItem[];
  /** 디스크에 있는 모든 Theater 의 항목 — 감시자(담당 활동)가 훑는다. */
  all(): readonly ObjectiveItem[];
  get(theaterId: string, itemId: string): ObjectiveItem | null;
  find(itemId: string): ObjectiveItem | null;
  create(input: CreateItemInput): ObjectiveItem;
  patch(itemId: string, input: PatchItemInput): ObjectiveItem;
  remove(itemId: string): ObjectiveItem;
  /** 순서만 바꾼다 — 같은 Theater 의 다른 항목 앞(before) 또는 뒤(after)로. 내용은 그대로라 updatedAt 도 그대로다. */
  move(itemId: string, anchor: { readonly beforeId: string } | { readonly afterId: string }): ObjectiveItem;
  complete(itemId: string, by: SlotBy): ObjectiveItem;
  reopen(itemId: string): ObjectiveItem;
  /** `unplaced` — 사람이 선행 없이 더한 단계는 미분류로 들어간다(지휘관이 자리를 잡는다). */
  stepAdd(itemId: string, input: StepAddInput, options?: { readonly unplaced?: boolean }): ObjectiveItem;
  stepPatch(itemId: string, stepId: string, input: StepPatchInput, by?: SlotBy): ObjectiveItem;
  /** 지휘관의 완료 — 완료로 두고 기록 한 건을 더한다. 기록이 이미 있는 단계(다시 작업)면 「다시 완료」다. */
  stepDone(itemId: string, stepId: string, lines: readonly string[], by: SlotBy): ObjectiveItem;
  /** 사람이 이 단계의 기록을 모두 읽었다. 이미 읽었으면 쓰지 않는다. */
  stepSeen(itemId: string, stepId: string): ObjectiveItem;
  stepRemove(itemId: string, stepId: string): ObjectiveItem;
  /** 간선 토글 — `from` 이 `to` 의 선행. 있으면 끊고 없으면 잇는다. */
  edgeToggle(itemId: string, from: string, to: string, why?: string): { readonly item: ObjectiveItem; readonly linked: boolean };
  edgesLinear(itemId: string): ObjectiveItem;
  edgesClear(itemId: string): ObjectiveItem;
  plan(itemId: string, input: PlanInput, by: SlotBy): ObjectiveItem;
  setSlot(itemId: string, stepId: string | null, slot: Slot | null): ObjectiveItem;
  setCooking(itemId: string, cooking: boolean): ObjectiveItem;
  setReview(itemId: string, review: { readonly summary: string; readonly criteria?: readonly CriterionEvidence[] } | null): ObjectiveItem;
  /** 달성 기준 — 사람이 쓰고, 비어 있을 때 구상 중인 지휘관이 제안한다(by). 고치거나 지워도 기준 id 는 다른 기준에 이어지지 않는다. */
  criterionAdd(itemId: string, text: string, by: ObjectiveCriterion["by"]): ObjectiveItem;
  criterionPatch(itemId: string, criterionId: string, text: string): ObjectiveItem;
  criterionRemove(itemId: string, criterionId: string): ObjectiveItem;
  /** 사람의 편집을 쌓는다(지휘관이 있을 때만) · null 이면 지운다. 바뀐 것이 없으면 쓰지 않는다. */
  setEdited(itemId: string, kinds: readonly ObjectiveEditKind[] | null): ObjectiveItem;
  /** 사라진 Operation 을 모든 슬롯(완료 항목의 released 포함)에서 지운다 — 바뀐 항목을 돌려준다. */
  forgetOperation(operationId: string): readonly ObjectiveItem[];
  /** 지휘관 Operation 이 그룹을 옮겼다 — 그 지휘관의 항목(완료 항목 포함)을 같은 그룹으로. 이미 같으면 쓰지 않는다. 바뀐 항목을 돌려준다. */
  followCommanderGroup(theaterId: string, operationId: string, groupId: string | null): readonly ObjectiveItem[];
  /** 메모에 이미지를 붙인다 — 파일을 먼저 쓰고 항목에 싣는다. 형식·크기 판정은 부르는 쪽이 끝낸 뒤다. */
  attachmentAdd(itemId: string, input: { readonly name: string; readonly type: ObjectiveAttachment["type"]; readonly data: Buffer; readonly width?: number; readonly height?: number }): { readonly item: ObjectiveItem; readonly attachment: ObjectiveAttachment };
  attachmentRemove(itemId: string, attachmentId: string): ObjectiveItem;
  /** 첨부 파일의 절대 경로 — 서버 안(파일 서빙·지휘관의 도구 응답)에서만 쓴다. */
  attachmentPath(item: ObjectiveItem, attachment: ObjectiveAttachment): string;
}

function fileFor(dir: string, theaterId: string): string {
  // theaterId 는 경로 해시라 안전하지만, 그래도 파일명에 쓸 문자만 남긴다.
  const safe = theaterId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(dir, `${safe}.json`);
}

/**
 * 옛 결과 — 단계마다 덮어쓰던 문자열 하나(`result`)를 시각 없는 첫 기록으로 옮긴다. 이미 본 것으로 둔다.
 * 파일은 다음 쓰기 때 새 모양으로 저장된다; id 가 단계에서 정해지므로 다시 읽어도 같은 기록이다.
 */
function migrateStep(step: ObjectiveStep & { readonly result?: unknown }): ObjectiveStep {
  if (!("result" in step)) return step;
  const { result, ...rest } = step;
  if (typeof result !== "string" || !result.trim() || rest.records?.length) return rest;
  const record: StepRecord = { id: `result-${step.id}`, at: null, kind: "done", lines: result.split("\n").map((line) => line.trim()).filter(Boolean) };
  return { ...rest, records: [record], seen: 1 };
}

function readFile(file: string): ObjectiveTheaterFile {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<ObjectiveTheaterFile>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) return { version: 1, items: (parsed.items as ObjectiveItem[]).map((item) => ({ ...item, steps: item.steps.map(migrateStep) })) };
  } catch {
    // 없거나 깨진 파일은 빈 목록으로 시작한다 — 깨진 파일은 덮어쓰지 않고 .broken 으로 비켜 둔다.
    try { if (fs.existsSync(file)) fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
  }
  return { version: 1, items: [] };
}

function writeFileAtomic(file: string, data: ObjectiveTheaterFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 항목의 지휘관 — 지금 슬롯, 완료 뒤에는 되돌리기용으로 남긴 조율자 슬롯(stepId 없음). 담당 슬롯은 지휘관이 아니다. */
export function commanderOperationOf(item: ObjectiveItem): string | null {
  return item.slot?.operationId ?? item.done?.released.find((entry) => !entry.stepId)?.slot.operationId ?? null;
}

const inLineupOrder = (item: ObjectiveItem): ObjectiveItem => {
  const steps = lineupOrder(item.steps);
  return steps === item.steps ? item : { ...item, steps: [...steps] };
};

const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

export function createObjectiveStore(options: ObjectiveStoreOptions): ObjectiveStore {
  const now = options.now ?? (() => Date.now());
  const attachmentsRoot = options.attachmentsDir ?? path.join(path.dirname(options.dir), "attachments");
  const itemFolder = (item: Pick<ObjectiveItem, "id" | "theaterId">) => path.join(attachmentsRoot, safeSegment(item.theaterId), safeSegment(item.id));
  const fileOf = (item: Pick<ObjectiveItem, "id" | "theaterId">, attachment: Pick<ObjectiveAttachment, "id" | "type">) => path.join(itemFolder(item), `${safeSegment(attachment.id)}.${ATTACHMENT_TYPES[attachment.type]}`);
  const cache = new Map<string, ObjectiveItem[]>();
  const index = new Map<string, string>(); // itemId → theaterId

  const load = (theaterId: string): ObjectiveItem[] => {
    let items = cache.get(theaterId);
    if (!items) {
      // 편성 순이 아니던 옛 항목도 읽는 순간 편성 순으로 본다 — 다음 쓰기에 그대로 저장된다.
      items = readFile(fileFor(options.dir, theaterId)).items.map(inLineupOrder);
      cache.set(theaterId, items);
      for (const item of items) index.set(item.id, theaterId);
    }
    return items;
  };

  const locate = (itemId: string): { theaterId: string; items: ObjectiveItem[]; at: number; item: ObjectiveItem } => {
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
    if (!theaterId) throw new ObjectiveStoreError("unknown_item");
    const items = load(theaterId);
    const at = items.findIndex((item) => item.id === itemId);
    if (at < 0) throw new ObjectiveStoreError("unknown_item");
    return { theaterId, items, at, item: items[at]! };
  };

  const commit = (theaterId: string, items: ObjectiveItem[], next: ObjectiveItem | null, removedId?: string, reordered = false): void => {
    writeFileAtomic(fileFor(options.dir, theaterId), { version: 1, items });
    if (next) {
      index.set(next.id, theaterId);
      options.emit({ op: "upsert", theaterId, itemId: next.id, item: next, ...(reordered ? { order: items.map((item) => item.id) } : {}) });
    } else if (removedId) {
      index.delete(removedId);
      options.emit({ op: "remove", theaterId, itemId: removedId });
    }
  };

  const update = (itemId: string, mutate: (item: ObjectiveItem) => ObjectiveItem): ObjectiveItem => {
    const { theaterId, items, at, item } = locate(itemId);
    const mutated = { ...mutate(item), updatedAt: now() };
    if (mutated.steps.length > MAX_STEPS) throw new ObjectiveStoreError("too_many_steps");
    if (hasCycle(mutated.steps)) throw new ObjectiveStoreError("dependency_cycle");
    // 선행이 바뀌면 단계도 편성 순으로 다시 선다 — 목록·번호·지휘관 도구의 index 가 편성과 같은 순서를 말한다.
    const next = inLineupOrder(mutated);
    items[at] = next;
    commit(theaterId, items, next);
    return next;
  };

  const withHistory = (item: ObjectiveItem, entry: Omit<ObjectiveHistoryEntry, "at">): ObjectiveItem => ({ ...item, history: [...item.history.slice(-199), { at: now(), ...entry }] });

  const stepOf = (item: ObjectiveItem, stepId: string): { at: number; step: ObjectiveStep } => {
    const at = item.steps.findIndex((step) => step.id === stepId);
    if (at < 0) throw new ObjectiveStoreError("unknown_step");
    return { at, step: item.steps[at]! };
  };

  /** 자리가 정해졌다 — 미분류 표시를 뗀다. */
  const placed = (step: ObjectiveStep): ObjectiveStep => (step.unplaced ? (({ unplaced: _unplaced, ...rest }) => rest)(step) : step);

  const replaceStep = (item: ObjectiveItem, at: number, step: ObjectiveStep): ObjectiveItem => {
    const steps = [...item.steps];
    steps[at] = step;
    return { ...item, steps };
  };

  return {
    list: (theaterId) => [...load(theaterId)],
    forgetOperation(operationId) {
      const touched: ObjectiveItem[] = [];
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
    followCommanderGroup(theaterId, operationId, groupId) {
      const touched: ObjectiveItem[] = [];
      for (const item of load(theaterId)) {
        if (item.groupId === groupId || commanderOperationOf(item) !== operationId) continue;
        touched.push(update(item.id, (current) => ({ ...current, groupId })));
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
      const steps: ObjectiveStep[] = (input.steps ?? []).map((step, ix) => ({
        id: stepIds[ix]!,
        text: step.text,
        done: false,
        after: (step.after ?? []).filter((index) => index >= 0 && index < ix).map((index) => stepIds[index]!),
        slot: null,
        assign: DEFAULT_STEP_ASSIGN,
      }));
      const item: ObjectiveItem = {
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
        steps: [...lineupOrder(steps)],
        history: [],
        author: input.author ?? { kind: "human" },
        createdAt: at,
        updatedAt: at,
      };
      if (hasCycle(item.steps)) throw new ObjectiveStoreError("dependency_cycle");
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
      // 항목이 사라지면 붙인 이미지도 함께 — 남은 파일은 가리킬 곳이 없다.
      try { fs.rmSync(itemFolder(item), { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ }
      return item;
    },

    move(itemId, anchor) {
      const { theaterId, items, at, item } = locate(itemId);
      const anchorId = "beforeId" in anchor ? anchor.beforeId : anchor.afterId;
      if (anchorId === itemId) return item;
      if (!items.some((candidate) => candidate.id === anchorId)) throw new ObjectiveStoreError("unknown_item");
      items.splice(at, 1);
      const target = items.findIndex((candidate) => candidate.id === anchorId);
      items.splice("beforeId" in anchor ? target : target + 1, 0, item);
      commit(theaterId, items, item, undefined, true);
      return item;
    },

    attachmentAdd(itemId, input) {
      const current = locate(itemId).item;
      if (current.done) throw new ObjectiveStoreError("item_done");
      const existing = current.attachments ?? [];
      if (existing.length >= MAX_ATTACHMENTS) throw new ObjectiveStoreError("too_many_attachments");
      const attachment: ObjectiveAttachment = {
        id: randomUUID(),
        n: existing.reduce((top, entry) => Math.max(top, entry.n), 0) + 1,
        name: input.name,
        type: input.type,
        bytes: input.data.length,
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        at: now(),
      };
      const file = fileOf(current, attachment);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, input.data);
      fs.renameSync(tmp, file);
      try {
        const item = update(itemId, (item) => ({ ...item, attachments: [...(item.attachments ?? []), attachment] }));
        return { item, attachment };
      } catch (error) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        throw error;
      }
    },

    attachmentRemove(itemId, attachmentId) {
      const current = locate(itemId).item;
      const target = (current.attachments ?? []).find((entry) => entry.id === attachmentId);
      if (!target) throw new ObjectiveStoreError("unknown_attachment");
      const item = update(itemId, (item) => ({ ...item, attachments: (item.attachments ?? []).filter((entry) => entry.id !== attachmentId) }));
      try { fs.rmSync(fileOf(current, target), { force: true }); } catch { /* 이미 없으면 그만 */ }
      return item;
    },

    attachmentPath: (item, attachment) => fileOf(item, attachment),

    setCooking: (itemId, cooking) => update(itemId, (item) => (item.cooking === cooking ? item : cooking ? { ...item, cooking: true } : (({ cooking: _cooking, ...rest }) => rest)(item))),

    setEdited(itemId, kinds) {
      const current = locate(itemId).item;
      if (kinds === null) return current.edited ? update(itemId, (item) => (({ edited: _edited, ...rest }) => rest)(item)) : current;
      if (!current.slot || kinds.length === 0) return current;
      const merged = [...new Set([...(current.edited?.kinds ?? []), ...kinds])];
      if (current.edited && merged.length === current.edited.kinds.length) return current;
      return update(itemId, (item) => ({ ...item, edited: { at: now(), kinds: merged } }));
    },

    setReview: (itemId, review) => update(itemId, (item) => (review ? { ...item, review: { at: now(), summary: review.summary, ...(review.criteria?.length ? { criteria: review.criteria } : {}) } } : item.review ? (({ review: _review, ...rest }) => rest)(item) : item)),
    criterionAdd: (itemId, text, by) => update(itemId, (item) => {
      const criteria = item.criteria ?? [];
      if (criteria.length >= MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
      return { ...item, criteria: [...criteria, { id: randomUUID(), text: text.trim(), by, at: now() }] };
    }),
    criterionPatch: (itemId, criterionId, text) => update(itemId, (item) => {
      const criteria = item.criteria ?? [];
      if (!criteria.some((entry) => entry.id === criterionId)) throw new ObjectiveStoreError("unknown_criterion");
      return { ...item, criteria: criteria.map((entry) => (entry.id === criterionId ? { ...entry, text: text.trim() } : entry)) };
    }),
    criterionRemove: (itemId, criterionId) => update(itemId, (item) => {
      const criteria = item.criteria ?? [];
      if (!criteria.some((entry) => entry.id === criterionId)) throw new ObjectiveStoreError("unknown_criterion");
      return { ...item, criteria: criteria.filter((entry) => entry.id !== criterionId) };
    }),

    complete: (itemId, by) => update(itemId, (item) => {
      if (item.done) return item;
      const released: ObjectiveDoneReleased[] = [];
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

    stepAdd: (itemId, input, options) => update(itemId, (item) => {
      const known = new Set(item.steps.map((step) => step.id));
      const after = (input.after ?? []).filter((id) => known.has(id));
      // 선행을 함께 준 추가는 이미 자리가 있다 — 미분류는 선행 없이 더한 사람의 단계뿐이다.
      const unplaced = options?.unplaced === true && input.after === undefined;
      const step: ObjectiveStep = { id: randomUUID(), text: input.text, done: false, after, slot: null, assign: input.assign ?? DEFAULT_STEP_ASSIGN, ...(unplaced ? { unplaced: true as const } : {}) };
      return { ...item, steps: [...item.steps, step] };
    }),

    stepPatch: (itemId, stepId, input, by) => update(itemId, (item) => {
      const { at, step } = stepOf(item, stepId);
      const known = new Set(item.steps.map((candidate) => candidate.id));
      // 선행을 정하면(빈 배열도) 자리가 정해진 것이다.
      const next: ObjectiveStep = {
        ...(input.after !== undefined ? placed(step) : step),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.done !== undefined ? { done: input.done, ...(input.done ? { doneBy: by ?? "human" } : {}) } : {}),
        ...(input.after !== undefined ? { after: input.after.filter((id) => known.has(id) && id !== stepId) } : {}),
        ...(input.assign !== undefined ? { assign: input.assign ?? undefined } : {}),
        ...(input.why !== undefined ? { why: { ...step.why, ...input.why } } : {}),
      };
      return replaceStep(item, at, next);
    }),

    stepDone: (itemId, stepId, lines, by) => update(itemId, (item) => {
      const { at, step } = stepOf(item, stepId);
      const records = step.records ?? [];
      const record: StepRecord = { id: randomUUID(), at: now(), kind: records.length > 0 ? "redone" : "done", lines: [...lines], by };
      const kept = [...records, record].slice(-MAX_RECORDS);
      // 밀려난 기록만큼 읽은 수도 줄인다 — 남은 기록 중 안 읽은 것이 그대로 안 읽은 것으로 남는다.
      const seen = Math.max(0, Math.min(step.seen ?? 0, records.length) - (records.length + 1 - kept.length));
      return replaceStep(item, at, { ...step, done: true, doneBy: by, records: kept, seen });
    }),

    stepSeen(itemId, stepId) {
      const current = locate(itemId).item;
      const { step } = stepOf(current, stepId);
      const count = step.records?.length ?? 0;
      if ((step.seen ?? 0) === count) return current;
      return update(itemId, (item) => { const found = stepOf(item, stepId); return replaceStep(item, found.at, { ...found.step, seen: count }); });
    },

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
        // 사람이 간선을 직접 이으면 양 끝 모두 자리가 정해진 것으로 본다 — 끊는 것은 자리를 되돌리지 않는다.
        if (step.after.includes(from)) {
          linked = false;
          const nextWhy = step.why ? Object.fromEntries(Object.entries(step.why).filter(([id]) => id !== from)) : undefined;
          return replaceStep(current, at, { ...step, after: step.after.filter((id) => id !== from), ...(nextWhy ? { why: nextWhy } : {}) });
        }
        linked = true;
        const fromAt = current.steps.findIndex((candidate) => candidate.id === from);
        const withFrom = replaceStep(current, fromAt, placed(current.steps[fromAt]!));
        return replaceStep(withFrom, at, { ...placed(step), after: [...step.after, from], why: { ...step.why, [from]: why ?? "human" } });
      });
      return { item, linked };
    },

    edgesLinear: (itemId) => update(itemId, (item) => ({
      ...item,
      steps: item.steps.map((step, ix) => (ix === 0 ? { ...placed(step), after: [] } : { ...placed(step), after: [item.steps[ix - 1]!.id], why: { [item.steps[ix - 1]!.id]: "human" } })),
    })),

    edgesClear: (itemId) => update(itemId, (item) => ({ ...item, steps: item.steps.map((step) => ({ ...placed(step), after: [], why: {} })) })),

    plan: (itemId, input, by) => update(itemId, (item) => {
      // 완료·배정·예약된 단계와 사람이 이은 간선은 보존한다. 나머지는 조율자의 계획으로 바꾼다.
      // 사람이 더한 미분류 단계도 보존한다 — 지휘관이 그 단계를 보기 전의 보드로 짠 계획이 사람의 요청을 지우면 안 된다(자리는 지휘관이 step after 로 정한다).
      const kept = item.steps.filter((step) => step.done || step.slot || step.unplaced);
      const keptIds = new Set(kept.map((step) => step.id));
      const fresh: ObjectiveStep[] = input.steps.map((step) => ({ id: randomUUID(), text: step.text, done: false, after: [], slot: null, assign: { mode: step.assign ?? "self" } }));
      const resolved: ObjectiveStep[] = fresh.map((step, ix) => {
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
        const entry: Omit<ObjectiveHistoryEntry, "at"> = slot ? { kind: previous ? "replace" : "assign", operationId: slot.operationId } : { kind: "release", ...(previous ? { operationId: previous.operationId } : {}) };
        return withHistory({ ...item, slot }, entry);
      }
      const { at, step } = stepOf(item, stepId);
      const previous = step.slot;
      const entry: Omit<ObjectiveHistoryEntry, "at"> = slot ? { kind: previous ? "replace" : "assign", stepId, operationId: slot.operationId } : { kind: "release", stepId, ...(previous ? { operationId: previous.operationId } : {}) };
      return withHistory(replaceStep(item, at, { ...step, slot }), entry);
    }),

  };
}

type ObjectiveDoneReleased = { readonly stepId?: string; readonly slot: Slot };

/** 이름을 바꾸기 전 이 플러그인의 id — 그때 쌓인 목표·첨부가 이 자리에 남아 있다. */
export const LEGACY_PLUGIN_ID = "todo";

/**
 * 옛 데이터 디렉터리를 새 자리로 한 번 옮긴다. 새 자리가 이미 있으면 옛 자리는 건드리지 않는다 — 두 곳을 합치면
 * 어느 쪽이 최신인지 알 수 없다. 옮기지 못하면 빈 보드로 시작하되 옛 데이터는 그대로 남긴다.
 */
export function adoptLegacyData(legacyRoot: string, root: string): void {
  if (fs.existsSync(root) || !fs.existsSync(legacyRoot)) return;
  try {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.renameSync(legacyRoot, root);
  } catch (error) {
    console.warn(`[objectives] could not move legacy data from ${legacyRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
