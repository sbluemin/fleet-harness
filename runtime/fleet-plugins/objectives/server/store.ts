import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readOperationLaunch, type OperationNode } from "@fleet-console/sdk/operations";

import { ATTACHMENT_TYPES, MAX_ATTACHMENTS } from "./attachments.js";
import {
  MAX_CRITERIA,
  MAX_RECORDS,
  MAX_STEPS,
  awaitingReview,
  graphOf,
  hasCycle,
  lineupOrder,
  withoutMet,
  type ObjectiveAttachment,
  type ObjectiveEditKind,
  type ObjectiveItem,
  type ObjectiveItemEvent,
  type ObjectivesFile,
  type PlanInput,
  type StepAddInput,
  type StepPatchInput,
  type StoredEdge,
  type StoredObjective,
  type StoredRecord,
  type StoredStep,
} from "./types.js";

/**
 * 목표 저장소 — Theater 마다 `workspaces/<프로젝트>/objectives/state.json` 하나.
 *
 * 레코드의 키는 지휘관 Operation id 다. 제목·그룹·Theater·만든 시각·세션 이름·모델은 Operation 이 들고 있으므로
 * 여기에 두지 않고, 화면 모양(`ObjectiveItem`)은 읽을 때마다 Operation 과 합쳐 만든다. Operation 이 없으면(삭제 유예 중)
 * 목표도 보이지 않는다 — 레코드는 Operation 이 복원 불가로 확정될 때(`forget`) 지워진다.
 * 모든 변경은 한 곳(`commit`)을 지나 파일에 쓰이고 사건으로 방송된다.
 */

export class ObjectiveStoreError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "ObjectiveStoreError";
  }
}

export interface ObjectiveStoreOptions {
  /** Theater 의 목표 디렉터리 — `workspaces/<프로젝트>/objectives`. Theater 경로를 모르면 null. */
  readonly dirOf: (theaterId: string) => string | null;
  readonly operations: { get(id: string): OperationNode | null; list(): readonly OperationNode[] };
  readonly emit: (event: ObjectiveItemEvent) => void;
  readonly now?: () => number;
}

/** 새 목표의 목표 고유값 — Operation 은 부르는 쪽이 먼저 만든다. */
export interface ObjectiveInit {
  readonly note?: string;
  readonly important?: boolean;
  readonly dueDate?: string | null;
  readonly today?: boolean;
  readonly steps?: readonly { readonly text: string; readonly after?: readonly number[] }[];
  readonly addedBy?: string;
}

export interface ObjectivePatch {
  readonly note?: string;
  readonly cook?: string;
  readonly important?: boolean;
  readonly dueDate?: string | null;
  readonly today?: boolean;
}

export interface ObjectiveStore {
  list(theaterId: string): readonly ObjectiveItem[];
  /** 알려진 모든 Theater 의 목표. */
  all(): readonly ObjectiveItem[];
  find(itemId: string): ObjectiveItem | null;
  /** 지휘관의 담당 Operation 들 — 지휘관 Operation 이 이미 사라진 뒤에도 레코드에서 찾는다. */
  assigneesOf(commanderId: string): readonly string[];
  /** 이 Operation 이 담당인 목표와 단계. */
  findAssignee(operationId: string): { readonly item: ObjectiveItem; readonly stepId: string } | null;
  /** 지휘관 Operation 을 이미 만든 뒤 — 그 Operation 의 목표 고유값을 채운다(보드 맨 위). */
  adopt(operationId: string, init: ObjectiveInit): ObjectiveItem;
  patch(itemId: string, input: ObjectivePatch): ObjectiveItem;
  /** Operation 쪽 값(제목·그룹·모델)이 바뀌었다 — 저장은 그대로, 합친 화면 모양만 다시 방송한다. */
  refresh(operationId: string): void;
  /** 지휘관 Operation 이 복원 불가로 사라졌다 — 레코드와 첨부를 지운다. 담당이었다면 그 단계의 연결을 푼다. */
  forget(operationId: string): void;
  /** 순서만 바꾼다 — 같은 Theater 의 다른 항목 앞(before) 또는 뒤(after)로. */
  move(itemId: string, anchor: { readonly beforeId: string } | { readonly afterId: string }): ObjectiveItem;
  complete(itemId: string): ObjectiveItem;
  reopen(itemId: string): ObjectiveItem;
  /** `unplaced` — 사람이 선행 없이 더한 단계는 미분류로 들어간다(지휘관이 자리를 잡는다). */
  stepAdd(itemId: string, input: StepAddInput, options?: { readonly unplaced?: boolean }): ObjectiveItem;
  stepPatch(itemId: string, stepId: string, input: StepPatchInput): ObjectiveItem;
  /** 지휘관의 완료 — 완료로 두고 기록 한 건을 더한다. */
  stepDone(itemId: string, stepId: string, lines: readonly string[]): ObjectiveItem;
  /** 사람이 이 단계의 기록을 모두 읽었다. 이미 읽었으면 쓰지 않는다. */
  stepSeen(itemId: string, stepId: string): ObjectiveItem;
  stepRemove(itemId: string, stepId: string): ObjectiveItem;
  /** 담당 Operation 을 단계에 잇거나(위임) 푼다. */
  setStepOperation(itemId: string, stepId: string, operationId: string | null): ObjectiveItem;
  /** 간선 토글 — `from` 이 `to` 의 선행. 있으면 끊고 없으면 잇는다. */
  edgeToggle(itemId: string, from: string, to: string, why?: string): { readonly item: ObjectiveItem; readonly linked: boolean };
  edgesLinear(itemId: string): ObjectiveItem;
  edgesClear(itemId: string): ObjectiveItem;
  plan(itemId: string, input: PlanInput): ObjectiveItem;
  setCooking(itemId: string, cooking: boolean): ObjectiveItem;
  /** 새 작업(스티어링)이 생겼다 — 앞선 충족 판단을 모두 거둔다. */
  clearMet(itemId: string): ObjectiveItem;
  criterionAdd(itemId: string, text: string, by: "human" | "commander"): ObjectiveItem;
  criterionPatch(itemId: string, criterionId: string, text: string): ObjectiveItem;
  criterionRemove(itemId: string, criterionId: string): ObjectiveItem;
  /** 지휘관이 기준 하나를 충족(근거와 함께) 또는 미충족으로 표시한다. */
  criterionMet(itemId: string, criterionId: string, evidence: string | null): ObjectiveItem;
  /** 사람의 편집을 쌓는다 · null 이면 지운다. 바뀐 것이 없으면 쓰지 않는다. */
  setEdited(itemId: string, kinds: readonly ObjectiveEditKind[] | null): ObjectiveItem;
  attachmentAdd(itemId: string, input: { readonly name: string; readonly type: ObjectiveAttachment["type"]; readonly data: Buffer; readonly width?: number; readonly height?: number }): { readonly item: ObjectiveItem; readonly attachment: ObjectiveAttachment };
  attachmentRemove(itemId: string, attachmentId: string): ObjectiveItem;
  /** 첨부 파일의 절대 경로 — 서버 안(파일 서빙·지휘관의 도구 응답)에서만 쓴다. */
  attachmentPath(item: ObjectiveItem, attachment: ObjectiveAttachment): string;
}

const STATE_FILE = "state.json";
const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

/** 따로 만든 Operation 처럼 아직 목표 고유값이 없는 목표 — 저장하지 않고, 첫 편집 때 레코드가 된다. */
const bareRecord = (operationId: string): StoredObjective => ({ operationId, note: "", steps: [] });
/** 목표가 되는 Operation — Console 이 띄우는 에이전트 세션(플러그인 소유 Operation 은 아니다). */
export const isObjectiveOperation = (node: Pick<OperationNode, "type" | "pluginId">): boolean => node.type === "agent" && node.pluginId === null;

function readState(file: string): StoredObjective[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ObjectivesFile>;
    // 빈 브리핑·빈 임무는 쓰지 않으므로 읽을 때 채운다.
    if (parsed && parsed.version === 2 && Array.isArray(parsed.objectives)) return parsed.objectives.map((entry) => ({ ...bareRecord(entry.operationId), ...entry }));
  } catch (error) {
    // 없는 파일은 빈 보드다. 깨진 파일은 덮어쓰지 않고 .broken 으로 비켜 둔다.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
  }
  try { if (fs.existsSync(file)) fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
  return [];
}

function writeStateAtomic(file: string, objectives: readonly StoredObjective[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 2, objectives: objectives.map(compact) } satisfies ObjectivesFile, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** 기본값·빈 값은 쓰지 않는다 — 저장 모양에는 뜻이 있는 값만 남는다. */
function compact(objective: StoredObjective): StoredObjective {
  const out: Record<string, unknown> = { ...objective };
  for (const key of ["note", "cook", "dueDate", "addedBy"] as const) if (!out[key]) delete out[key];
  for (const key of ["cooking", "important", "today"] as const) if (out[key] !== true) delete out[key];
  if (!(objective.attachments?.length)) delete out.attachments;
  if (!(objective.criteria?.length)) delete out.criteria;
  if (!objective.edited) delete out.edited;
  if (!objective.done) delete out.done;
  out.steps = objective.steps.map((step) => {
    const next: Record<string, unknown> = { ...step };
    if (step.done !== true) delete next.done;
    if (!step.assign || step.assign.mode === "self") delete next.assign;
    if (!step.operationId) delete next.operationId;
    if (!step.records?.length) { delete next.records; delete next.seen; }
    else if (!step.seen) delete next.seen;
    next.after = step.after.map((edge) => (edge.why ? edge : { id: edge.id }));
    return next;
  });
  if (objective.steps.length === 0) delete out.steps;
  return out as unknown as StoredObjective;
}

export function createObjectiveStore(options: ObjectiveStoreOptions): ObjectiveStore {
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, StoredObjective[]>();

  const dirFor = (theaterId: string): string => {
    const dir = options.dirOf(theaterId);
    if (!dir) throw new ObjectiveStoreError("unknown_theater");
    return dir;
  };
  const load = (theaterId: string): StoredObjective[] => {
    let objectives = cache.get(theaterId);
    if (!objectives) {
      const dir = options.dirOf(theaterId);
      objectives = dir ? readState(path.join(dir, STATE_FILE)) : [];
      cache.set(theaterId, objectives);
    }
    return objectives;
  };
  const theaterIds = (): readonly string[] => [...new Set([...options.operations.list().map((node) => node.theaterId), ...cache.keys()])];
  const attachmentFolder = (theaterId: string, operationId: string) => path.join(dirFor(theaterId), "attachments", safeSegment(operationId));
  const fileOf = (theaterId: string, operationId: string, attachment: Pick<ObjectiveAttachment, "id" | "type">) => path.join(attachmentFolder(theaterId, operationId), `${safeSegment(attachment.id)}.${ATTACHMENT_TYPES[attachment.type]}`);

  /** 화면 모양 — 저장 레코드와 지휘관 Operation 을 합친다. 담당 세션 이름은 담당 Operation 에서. */
  const project = (stored: StoredObjective, node: OperationNode): ObjectiveItem => {
    const launch = readOperationLaunch(node.payload);
    const addedBy = stored.addedBy ? { operationId: stored.addedBy, title: options.operations.get(stored.addedBy)?.title ?? null } : null;
    return {
      id: stored.operationId,
      theaterId: node.theaterId,
      groupId: node.groupId ?? null,
      title: node.title,
      createdAt: node.ts.createdAt,
      commander: { sessionName: launch.sessionName, ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}), started: launch.started },
      note: stored.note,
      attachments: stored.attachments ?? [],
      ...(stored.cook ? { cook: stored.cook } : {}),
      cooking: stored.cooking === true,
      ...(stored.edited ? { edited: stored.edited } : {}),
      important: stored.important === true,
      dueDate: stored.dueDate ?? null,
      today: stored.today === true,
      addedBy,
      done: stored.done ?? null,
      awaitingReview: awaitingReview(stored),
      criteria: (stored.criteria ?? []).map((criterion) => ({ ...criterion })),
      steps: stored.steps.map((step) => {
        const assignee = step.operationId ? options.operations.get(step.operationId) : null;
        const assigneeLaunch = assignee ? readOperationLaunch(assignee.payload) : null;
        return {
          id: step.id,
          text: step.text,
          done: step.done === true,
          after: step.after.map((edge) => edge.id),
          why: Object.fromEntries(step.after.flatMap((edge) => (edge.why ? [[edge.id, edge.why]] : []))),
          ...(step.assign && step.assign.mode !== "self" ? { assign: step.assign } : {}),
          ...(step.unplaced ? { unplaced: true as const } : {}),
          operationId: step.operationId ?? null,
          sessionName: assigneeLaunch?.sessionName ?? null,
          ...(assigneeLaunch?.model ? { model: assigneeLaunch.model } : {}),
          ...(assigneeLaunch?.effort ? { effort: assigneeLaunch.effort } : {}),
          records: (step.records ?? []).map((record, index) => ({ ...record, kind: index === 0 ? "done" as const : "redone" as const })),
          seen: step.seen ?? 0,
        };
      }),
    };
  };
  /** 담당 Operation — 목표가 아니라 목표의 임무를 맡은 세션이다. */
  const assigneeIds = (objectives: readonly StoredObjective[]): ReadonlySet<string> => new Set(objectives.flatMap((entry) => entry.steps.flatMap((step) => (step.operationId ? [step.operationId] : []))));
  /** 목표가 되는 Operation 인가 — 이 Theater 의 에이전트 Operation 이고 다른 목표의 담당이 아니다. */
  const objectiveNode = (theaterId: string, operationId: string): OperationNode | null => {
    const node = options.operations.get(operationId);
    if (!node || node.theaterId !== theaterId || !isObjectiveOperation(node)) return null;
    return assigneeIds(load(theaterId)).has(operationId) ? null : node;
  };
  /** 지휘관 Operation 이 이 Theater 에 살아 있을 때만 화면에 선다. */
  const view = (theaterId: string, stored: StoredObjective): ObjectiveItem | null => {
    const node = objectiveNode(theaterId, stored.operationId);
    return node ? project(stored, node) : null;
  };
  /** 보드 순서 — 아직 레코드가 없는(따로 만든) Operation 이 새것부터 위에, 그 아래 레코드 순서. */
  const visible = (theaterId: string): readonly { readonly stored: StoredObjective; readonly node: OperationNode }[] => {
    const objectives = load(theaterId);
    const assignees = assigneeIds(objectives);
    const recorded = new Set(objectives.map((entry) => entry.operationId));
    const nodes = options.operations.list().filter((node) => node.theaterId === theaterId && isObjectiveOperation(node) && !assignees.has(node.id));
    const bare = nodes.filter((node) => !recorded.has(node.id)).sort((a, b) => b.ts.createdAt - a.ts.createdAt).map((node) => ({ stored: bareRecord(node.id), node }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return [...bare, ...objectives.flatMap((stored) => { const node = byId.get(stored.operationId); return node ? [{ stored, node }] : []; })];
  };

  /** 목표 하나 — 레코드가 없으면(따로 만든 Operation) 빈 목표이고 `at` 은 -1 이다. */
  const locate = (itemId: string): { theaterId: string; objectives: StoredObjective[]; at: number; stored: StoredObjective; node: OperationNode } => {
    const found = options.operations.get(itemId);
    const node = found ? objectiveNode(found.theaterId, itemId) : null;
    if (!node) throw new ObjectiveStoreError("unknown_item");
    const objectives = load(node.theaterId);
    const at = objectives.findIndex((entry) => entry.operationId === itemId);
    return { theaterId: node.theaterId, objectives, at, stored: at >= 0 ? objectives[at]! : bareRecord(itemId), node };
  };

  const commit = (theaterId: string, objectives: StoredObjective[], changed: StoredObjective | null, removedId?: string, reordered = false): ObjectiveItem | null => {
    writeStateAtomic(path.join(dirFor(theaterId), STATE_FILE), objectives);
    if (changed) {
      const item = view(theaterId, changed);
      if (item) options.emit({ op: "upsert", theaterId, itemId: item.id, item, ...(reordered ? { order: objectives.map((entry) => entry.operationId) } : {}) });
      return item;
    }
    if (removedId) options.emit({ op: "remove", theaterId, itemId: removedId });
    return null;
  };

  const update = (itemId: string, mutate: (stored: StoredObjective) => StoredObjective): ObjectiveItem => {
    const { theaterId, objectives, at, stored, node } = locate(itemId);
    const mutated = mutate(stored);
    if (mutated === stored) return project(stored, node);
    if (mutated.steps.length > MAX_STEPS) throw new ObjectiveStoreError("too_many_steps");
    if (hasCycle(graphOf(mutated.steps))) throw new ObjectiveStoreError("dependency_cycle");
    // 선행이 바뀌면 단계도 편성 순으로 다시 선다 — 목록·번호·지휘관 도구의 index 가 편성과 같은 순서를 말한다.
    const steps = lineupOrder(mutated.steps);
    const next = steps === mutated.steps ? mutated : { ...mutated, steps: [...steps] };
    // 따로 만든 Operation 의 첫 편집 — 여기서 레코드가 된다(보드에서 이미 맨 위 무리에 있으므로 레코드도 맨 위에).
    if (at >= 0) objectives[at] = next; else objectives.unshift(next);
    return commit(theaterId, objectives, next) ?? project(next, node);
  };

  const stepOf = (stored: StoredObjective, stepId: string): { at: number; step: StoredStep } => {
    const at = stored.steps.findIndex((step) => step.id === stepId);
    if (at < 0) throw new ObjectiveStoreError("unknown_step");
    return { at, step: stored.steps[at]! };
  };
  const replaceStep = (stored: StoredObjective, at: number, step: StoredStep): StoredObjective => {
    const steps = [...stored.steps];
    steps[at] = step;
    return { ...stored, steps };
  };
  /** 자리가 정해졌다 — 미분류 표시를 뗀다. */
  const placed = (step: StoredStep): StoredStep => (step.unplaced ? (({ unplaced: _unplaced, ...rest }) => rest)(step) : step);
  const withoutEdge = (step: StoredStep, id: string): StoredStep => ({ ...step, after: step.after.filter((edge) => edge.id !== id) });

  const store: ObjectiveStore = {
    list: (theaterId) => visible(theaterId).map(({ stored, node }) => project(stored, node)),
    all: () => theaterIds().flatMap((theaterId) => store.list(theaterId)),
    find: (itemId) => { try { const { stored, node } = locate(itemId); return project(stored, node); } catch { return null; } },
    assigneesOf(commanderId) {
      for (const theaterId of theaterIds()) {
        const stored = load(theaterId).find((entry) => entry.operationId === commanderId);
        if (stored) return stored.steps.flatMap((step) => (step.operationId ? [step.operationId] : []));
      }
      return [];
    },
    findAssignee(operationId) {
      for (const item of store.all()) {
        const step = item.steps.find((candidate) => candidate.operationId === operationId);
        if (step) return { item, stepId: step.id };
      }
      return null;
    },

    adopt(operationId, init) {
      const node = options.operations.get(operationId);
      if (!node || !isObjectiveOperation(node)) throw new ObjectiveStoreError("unknown_operation");
      const objectives = load(node.theaterId);
      if (objectives.some((entry) => entry.operationId === operationId)) throw new ObjectiveStoreError("already_objective");
      const stepIds = (init.steps ?? []).map(() => randomUUID());
      const steps: StoredStep[] = (init.steps ?? []).map((step, ix) => ({
        id: stepIds[ix]!,
        text: step.text,
        after: (step.after ?? []).filter((index) => index >= 0 && index < ix).map((index) => ({ id: stepIds[index]! })),
      }));
      const stored: StoredObjective = {
        operationId,
        note: init.note ?? "",
        ...(init.important ? { important: true as const } : {}),
        ...(init.dueDate ? { dueDate: init.dueDate } : {}),
        ...(init.today ? { today: true as const } : {}),
        ...(init.addedBy ? { addedBy: init.addedBy } : {}),
        steps: [...lineupOrder(steps)],
      };
      objectives.unshift(stored);
      return commit(node.theaterId, objectives, stored, undefined, true) ?? project(stored, node);
    },

    patch: (itemId, input) => update(itemId, (stored) => ({
      ...stored,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.cook !== undefined ? { cook: input.cook } : {}),
      ...(input.important !== undefined ? { important: input.important ? true as const : undefined } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? undefined } : {}),
      ...(input.today !== undefined ? { today: input.today ? true as const : undefined } : {}),
    })),

    refresh(operationId) {
      const node = options.operations.get(operationId);
      if (!node) return;
      if (objectiveNode(node.theaterId, operationId)) {
        const stored = load(node.theaterId).find((entry) => entry.operationId === operationId) ?? bareRecord(operationId);
        options.emit({ op: "upsert", theaterId: node.theaterId, itemId: operationId, item: project(stored, node) });
        return;
      }
      // 담당 Operation 이 바뀌었다(세션 이름 등) — 그 단계가 있는 목표를 다시 방송한다.
      for (const owner of load(node.theaterId)) {
        if (!owner.steps.some((step) => step.operationId === operationId)) continue;
        const item = view(node.theaterId, owner);
        if (item) options.emit({ op: "upsert", theaterId: node.theaterId, itemId: item.id, item });
      }
    },

    forget(operationId) {
      for (const theaterId of theaterIds()) {
        const objectives = load(theaterId);
        const at = objectives.findIndex((entry) => entry.operationId === operationId);
        if (at >= 0) {
          objectives.splice(at, 1);
          commit(theaterId, objectives, null, operationId);
          // 목표가 사라지면 붙인 이미지도 함께 — 남은 파일은 가리킬 곳이 없다.
          try { fs.rmSync(attachmentFolder(theaterId, operationId), { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ }
        }
        for (let ix = 0; ix < objectives.length; ix += 1) {
          const owner = objectives[ix]!;
          if (!owner.steps.some((step) => step.operationId === operationId)) continue;
          const next = { ...owner, steps: owner.steps.map((step) => (step.operationId === operationId ? { ...step, operationId: undefined } : step)) };
          objectives[ix] = next;
          commit(theaterId, objectives, next);
        }
      }
    },

    move(itemId, anchor) {
      const { theaterId, objectives, stored, node } = locate(itemId);
      const anchorId = "beforeId" in anchor ? anchor.beforeId : anchor.afterId;
      if (anchorId === itemId) return project(stored, node);
      // 순서는 보이는 그대로 레코드가 된다 — 따로 만든 Operation 도 옮기는 순간 자리를 얻는다.
      const order = visible(theaterId).map((entry) => entry.stored).filter((entry) => entry.operationId !== itemId);
      const target = order.findIndex((entry) => entry.operationId === anchorId);
      if (target < 0) throw new ObjectiveStoreError("unknown_item");
      order.splice("beforeId" in anchor ? target : target + 1, 0, stored);
      // 보이지 않는 레코드(삭제 유예 중인 Operation)는 뒤에 그대로 둔다.
      const shown = new Set(order.map((entry) => entry.operationId));
      objectives.splice(0, objectives.length, ...order, ...objectives.filter((entry) => !shown.has(entry.operationId)));
      return commit(theaterId, objectives, stored, undefined, true) ?? project(stored, node);
    },

    // 완료는 상태이지 연결 해제가 아니다 — 담당 연결은 그대로 남아 묶음·이동이 살아 있다.
    complete: (itemId) => update(itemId, (stored) => (stored.done ? stored : { ...stored, done: { at: now() }, cooking: undefined })),
    reopen: (itemId) => update(itemId, (stored) => (stored.done ? { ...stored, done: undefined } : stored)),

    stepAdd: (itemId, input, addOptions) => update(itemId, (stored) => {
      const known = new Set(stored.steps.map((step) => step.id));
      const after = (input.after ?? []).filter((id) => known.has(id)).map((id): StoredEdge => ({ id }));
      // 선행을 함께 준 추가는 이미 자리가 있다 — 미분류는 선행 없이 더한 사람의 단계뿐이다.
      const unplaced = addOptions?.unplaced === true && input.after === undefined;
      const step: StoredStep = { id: randomUUID(), text: input.text, after, ...(input.assign ? { assign: input.assign } : {}), ...(unplaced ? { unplaced: true as const } : {}) };
      // 새 일이 생겼다 — 앞선 충족 판단은 옛 보드에 대한 것이다.
      return withoutMet({ ...stored, steps: [...stored.steps, step] });
    }),

    stepPatch: (itemId, stepId, input) => update(itemId, (stored) => {
      const { at, step } = stepOf(stored, stepId);
      const known = new Set(stored.steps.map((candidate) => candidate.id));
      const why = (id: string) => input.why?.[id] ?? step.after.find((edge) => edge.id === id)?.why;
      // 선행을 정하면(빈 배열도) 자리가 정해진 것이다.
      const base = input.after !== undefined ? placed(step) : step;
      const after = input.after !== undefined
        ? input.after.filter((id) => known.has(id) && id !== stepId).map((id) => ({ id, ...(why(id) ? { why: why(id)! } : {}) }))
        : input.why ? step.after.map((edge) => ({ id: edge.id, ...(why(edge.id) ? { why: why(edge.id)! } : {}) })) : step.after;
      const next: StoredStep = {
        ...base,
        after,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.done !== undefined ? { done: input.done ? true as const : undefined } : {}),
        ...(input.assign !== undefined ? { assign: input.assign ?? undefined } : {}),
      };
      const replaced = replaceStep(stored, at, next);
      // 끝난 단계를 되돌리면 새 일이다 — 충족 판단을 거둔다.
      return input.done === false && step.done ? withoutMet(replaced) : replaced;
    }),

    stepDone: (itemId, stepId, lines) => update(itemId, (stored) => {
      const { at, step } = stepOf(stored, stepId);
      const records = step.records ?? [];
      const record: StoredRecord = { id: randomUUID(), at: now(), lines: [...lines] };
      const kept = [...records, record].slice(-MAX_RECORDS);
      // 밀려난 기록만큼 읽은 수도 줄인다 — 남은 기록 중 안 읽은 것이 그대로 안 읽은 것으로 남는다.
      const seen = Math.max(0, Math.min(step.seen ?? 0, records.length) - (records.length + 1 - kept.length));
      return replaceStep(stored, at, { ...step, done: true, records: kept, seen });
    }),

    stepSeen: (itemId, stepId) => update(itemId, (stored) => {
      const { at, step } = stepOf(stored, stepId);
      const count = step.records?.length ?? 0;
      return (step.seen ?? 0) === count ? stored : replaceStep(stored, at, { ...step, seen: count });
    }),

    stepRemove: (itemId, stepId) => update(itemId, (stored) => {
      stepOf(stored, stepId);
      return { ...stored, steps: stored.steps.filter((step) => step.id !== stepId).map((step) => withoutEdge(step, stepId)) };
    }),

    setStepOperation: (itemId, stepId, operationId) => update(itemId, (stored) => {
      const { at, step } = stepOf(stored, stepId);
      return (step.operationId ?? null) === operationId ? stored : replaceStep(stored, at, { ...step, operationId: operationId ?? undefined });
    }),

    edgeToggle(itemId, from, to, why) {
      let linked = false;
      const item = update(itemId, (stored) => {
        stepOf(stored, from);
        const { at, step } = stepOf(stored, to);
        // 사람이 간선을 직접 이으면 양 끝 모두 자리가 정해진 것으로 본다 — 끊는 것은 자리를 되돌리지 않는다.
        if (step.after.some((edge) => edge.id === from)) { linked = false; return replaceStep(stored, at, withoutEdge(step, from)); }
        linked = true;
        const fromAt = stored.steps.findIndex((candidate) => candidate.id === from);
        const withFrom = replaceStep(stored, fromAt, placed(stored.steps[fromAt]!));
        return replaceStep(withFrom, at, { ...placed(step), after: [...step.after, { id: from, why: why ?? "human" }] });
      });
      return { item, linked };
    },

    edgesLinear: (itemId) => update(itemId, (stored) => ({
      ...stored,
      steps: stored.steps.map((step, ix) => ({ ...placed(step), after: ix === 0 ? [] : [{ id: stored.steps[ix - 1]!.id, why: "human" }] })),
    })),

    edgesClear: (itemId) => update(itemId, (stored) => ({ ...stored, steps: stored.steps.map((step) => ({ ...placed(step), after: [] })) })),

    plan: (itemId, input) => update(itemId, (stored) => {
      // 완료·위임된 단계와 사람이 더한 미분류 단계는 보존한다. 나머지는 지휘관의 계획으로 바꾼다.
      const kept = stored.steps.filter((step) => step.done || step.operationId || step.unplaced);
      const keptIds = new Set(kept.map((step) => step.id));
      const freshIds = input.steps.map(() => randomUUID());
      const fresh: StoredStep[] = input.steps.map((step, ix) => {
        const after: StoredEdge[] = [];
        for (const edge of step.after ?? []) {
          // stepId 는 유지되는 기존 단계, index 는 이 계획 안의 순서.
          const targetId = edge.stepId && keptIds.has(edge.stepId) ? edge.stepId : edge.index !== undefined && edge.index !== ix ? freshIds[edge.index] : undefined;
          if (!targetId || after.some((entry) => entry.id === targetId)) continue;
          after.push({ id: targetId, ...(edge.why ? { why: edge.why } : {}) });
        }
        return { id: freshIds[ix]!, text: step.text, after, ...(step.assign === "route" ? { assign: { mode: "route" as const } } : {}) };
      });
      return withoutMet({ ...stored, steps: [...kept.map((step) => ({ ...step, after: step.after.filter((edge) => keptIds.has(edge.id)) })), ...fresh] });
    }),

    setCooking: (itemId, cooking) => update(itemId, (stored) => (!!stored.cooking === cooking ? stored : { ...stored, cooking: cooking ? true as const : undefined })),
    clearMet: (itemId) => update(itemId, (stored) => withoutMet(stored)),

    setEdited(itemId, kinds) {
      return update(itemId, (stored) => {
        if (kinds === null) return stored.edited ? { ...stored, edited: undefined } : stored;
        if (kinds.length === 0) return stored;
        const merged = [...new Set([...(stored.edited?.kinds ?? []), ...kinds])];
        if (stored.edited && merged.length === stored.edited.kinds.length) return stored;
        return { ...stored, edited: { at: now(), kinds: merged } };
      });
    },

    criterionAdd: (itemId, text, by) => update(itemId, (stored) => {
      const criteria = stored.criteria ?? [];
      if (criteria.length >= MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
      return { ...stored, criteria: [...criteria, { id: randomUUID(), text: text.trim(), by }] };
    }),
    criterionPatch: (itemId, criterionId, text) => update(itemId, (stored) => {
      const criteria = stored.criteria ?? [];
      const target = criteria.find((entry) => entry.id === criterionId);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      if (target.text === text.trim()) return stored;
      // 문구가 바뀐 기준의 충족 근거는 옛 문구에 대한 것이다 — 그 기준만 미충족으로 돌린다.
      return { ...stored, criteria: criteria.map((entry) => (entry.id === criterionId ? { id: entry.id, text: text.trim(), by: entry.by } : entry)) };
    }),
    criterionRemove: (itemId, criterionId) => update(itemId, (stored) => {
      const criteria = stored.criteria ?? [];
      if (!criteria.some((entry) => entry.id === criterionId)) throw new ObjectiveStoreError("unknown_criterion");
      return { ...stored, criteria: criteria.filter((entry) => entry.id !== criterionId) };
    }),
    criterionMet: (itemId, criterionId, evidence) => update(itemId, (stored) => {
      const criteria = stored.criteria ?? [];
      const target = criteria.find((entry) => entry.id === criterionId);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      const met = evidence?.trim() || undefined;
      if (target.met === met) return stored;
      return { ...stored, criteria: criteria.map((entry) => (entry.id === criterionId ? { id: entry.id, text: entry.text, by: entry.by, ...(met ? { met } : {}) } : entry)) };
    }),

    attachmentAdd(itemId, input) {
      const { theaterId, stored } = locate(itemId);
      if (stored.done) throw new ObjectiveStoreError("item_done");
      const existing = stored.attachments ?? [];
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
      const file = fileOf(theaterId, itemId, attachment);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, input.data);
      fs.renameSync(tmp, file);
      try {
        const item = update(itemId, (current) => ({ ...current, attachments: [...(current.attachments ?? []), attachment] }));
        return { item, attachment };
      } catch (error) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        throw error;
      }
    },

    attachmentRemove(itemId, attachmentId) {
      const { theaterId, stored } = locate(itemId);
      const target = (stored.attachments ?? []).find((entry) => entry.id === attachmentId);
      if (!target) throw new ObjectiveStoreError("unknown_attachment");
      const item = update(itemId, (current) => ({ ...current, attachments: (current.attachments ?? []).filter((entry) => entry.id !== attachmentId) }));
      try { fs.rmSync(fileOf(theaterId, itemId, target), { force: true }); } catch { /* 이미 없으면 그만 */ }
      return item;
    },

    attachmentPath: (item, attachment) => fileOf(item.theaterId, item.id, attachment),
  };
  return store;
}
