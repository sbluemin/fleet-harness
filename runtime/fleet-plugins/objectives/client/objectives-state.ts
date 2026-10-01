import { useEffect, useSyncExternalStore } from "react";

import { OPERATION_PURGED_EVENT, accessOperation, describeOperation, readOperationLaunch } from "@fleet-console/sdk/operations/browser";
import type { ClientApiCapability, ConsoleOperationSummary, PluginInstallContext } from "@fleet-console/sdk/plugin";

import type { Objective, ObjectiveEvent } from "../server/types.js";

/**
 * 표면·캡션·팔레트가 함께 구독하는 모듈 스토어.
 *
 * 화면은 응답이 아니라 사건으로 갱신된다 — 자기 변경도 `objectives:objective` 프레임으로 들어온다. 그룹은 코어의
 * `group:changed`/`group:removed` 를 같은 스트림에서 듣는다. Operation 의 활동은 호스트 consoleState 가 진실이다.
 * 따로 만든 에이전트 Operation 도 가상 목표로 받아 온다. Operation 이 없는 새 목표는 보드 사건에서 받는다.
 */

export interface ObjectiveGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
}

interface TheaterState {
  readonly objectives: readonly Objective[];
  readonly groups: readonly ObjectiveGroup[];
  readonly loaded: boolean;
  readonly launchAvailable: boolean;
}

export interface RevealTarget {
  readonly objectiveId: string;
  readonly missionId?: string;
  /** 사이드바 검토 대기 글리프에서 왔다 — 표면이 후속 후보 선택을 연다. */
  readonly followups?: boolean;
  /** 사이드바 「+ 목표」로 막 만들었다 — 표면이 제목 칸에 포커스를 두고 전체 선택한다. */
  readonly focusTitle?: boolean;
  readonly at: number;
}

const EMPTY: TheaterState = { objectives: [], groups: [], loaded: false, launchAvailable: false };
const theaters = new Map<string, TheaterState>();
const listeners = new Set<() => void>();
let installed: PluginInstallContext | null = null;
let reveal: RevealTarget | null = null;
// useSyncExternalStore 는 스냅샷의 참조가 같아야 멈춘다 — 호스트의 getOperations 가 매번 새 배열을 줄 수 있으므로 여기서 한 번만 받아 둔다.
let operationsSnapshot: readonly ConsoleOperationSummary[] = [];
const inflight = new Map<string, Promise<void>>();
/** 받으러 간 목표 — 같은 Operation 을 두 번 묻지 않는다. */
const fetching = new Set<string>();
/**
 * 서버가 unknown_objective(404)로 목표가 아니라고 답한 id. 401·네트워크·5xx 같은 일시 거절은 넣지 않고 세션 게이트(`degraded`)가 내려간 뒤 다시 묻는다.
 * 그 id 의 목표 사건이나 영구 삭제가 오기 전에는 지우지 않는다.
 */
const unknownToServer = new Set<string>();

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const retryDelay = (failures: number) => Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);

interface LoadRetry {
  readonly permanent: boolean;
  readonly failures: number;
  readonly failedAt: number;
  readonly nextAt: number;
}
/**
 * `/state` 실패 장부 — 화면 상태가 아니라 재시도 일정이다. 성공하면 지운다. 일시 실패는 `loaded` 를 올리지 않고 기한
 * (2s→×2→30s)까지 기다리고, 확정 실패는 `loaded` 로 정착시켜 그 Theater 가 다시 등록되기 전에는 묻지 않는다.
 */
const loadRetries = new Map<string, LoadRetry>();
/**
 * 세션 일시 거절 게이트 — `/state`·`/objective/get` 이 일시 거절을 받으면 서고, 성공 증거(objectives 요청 성공·스트림 프레임)가
 * 오면 내려간다. 서 있는 동안 스냅숏 경로는 기한이 지난 뒤 탐침 하나만 보내고, `/objective/get` 은 기한까지 보류한다.
 */
let degraded: { readonly failures: number; readonly until: number } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAt = Number.POSITIVE_INFINITY;

/** 일시 거절 — 네트워크(상태 없음)·401·408·429·5xx. 나머지 4xx 는 다시 물어도 같은 답이 오는 확정 거절이다. */
function isTransient(error: unknown): boolean {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status !== "number" || status === 401 || status === 408 || status === 429 || status >= 500;
}

/** 미룬 조회를 마지막 실패에서 첫 간격만 지나면 다시 묻게 당긴다 — 증거·사람의 동작이 잦아도 2초에 한 번을 넘지 않는다. */
function rearm(theaterId: string): void {
  const retry = loadRetries.get(theaterId);
  if (retry && !retry.permanent) loadRetries.set(theaterId, { ...retry, nextAt: Math.min(retry.nextAt, retry.failedAt + RETRY_BASE_MS) });
}

function noteTransient(): void {
  const failures = (degraded?.failures ?? 0) + 1;
  degraded = { failures, until: Date.now() + retryDelay(failures) };
  scheduleRetry();
}

/**
 * 세션이 살아 있다는 증거 — 게이트를 내리고 곧바로 한 번 스윕한다. 게이트가 서 있던 동안 탐침에 밀려 한 번도 묻지 않은
 * Theater 는 장부에 없으므로, 장부 기한만 겨냥하는 타이머로는 깨어나지 않는다. 미룬 엔트리는 마지막 실패에서 첫 간격까지 당긴다.
 */
function noteAlive(): void {
  if (!degraded) return;
  degraded = null;
  for (const theaterId of loadRetries.keys()) rearm(theaterId);
  scheduleRetry(true);
}

function clearRetryTimer(): void {
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  retryAt = Number.POSITIVE_INFINITY;
}

/**
 * 타이머는 하나다 — `sweep` 이면 곧바로, 게이트가 서 있으면 그 기한, 아니면 아직 오지 않은 가장 이른 Theater 기한에 스냅숏 경로를
 * 한 번 돌리고 다음 기한을 다시 건다. 스냅숏이 없는 한가한 Console 도 회복된다. 더 이른 예약은 덮지 않는다. 지난 기한은 겨냥하지 않는다
 * — 그 엔트리는 방금 물었거나 묻는 중이고, 끝나면 그 요청의 finally 가 다시 건다. 그래서 0ms 타이머가 되풀이되지 않는다.
 */
function scheduleRetry(sweep = false): void {
  const now = Date.now();
  let next = sweep ? now : Number.POSITIVE_INFINITY;
  if (degraded) { if (degraded.until > now) next = Math.min(next, degraded.until); }
  else for (const retry of loadRetries.values()) if (!retry.permanent && retry.nextAt > now) next = Math.min(next, retry.nextAt);
  if (next === Number.POSITIVE_INFINITY || (retryTimer !== null && retryAt <= next)) return;
  clearRetryTimer();
  retryAt = next;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAt = Number.POSITIVE_INFINITY;
    if (!installed) return;
    operationsSnapshot = installed.consoleState.getOperations({ nested: true });
    loadAgentTheaters(installed.api, installed.consoleState.getActiveTheaterId());
    reconcileOperations(installed.api);
    scheduleRetry();
  }, next - now);
}

/** 확정 실패로 정착시킨 Theater 를 처음부터 다시 묻게 한다 — 다시 등록됐거나 플러그인이 새로 설치됐다. */
function unsettle(theaterId: string): void {
  loadRetries.delete(theaterId);
  setTheater(theaterId, { loaded: false });
}

/**
 * 보관된 Operation 의 요약 — 완료한 목표의 지휘관·구성원은 Core 보관함으로 옮겨져 일반 목록에 없다. 세션 줄이 이름을
 * 잃지 않고 지금의 휴면처럼 서도록, 목표가 가리키는데 목록에 없는 id 만 부작용 없는 describe 로 한 번 읽어 둔다.
 * null 은 삭제·영구 삭제로 더는 없다는 뜻이고, 그 줄은 지금처럼 닫힘으로 선다. 새 문구나 보관 표기는 붙이지 않는다.
 */
const described = new Map<string, ConsoleOperationSummary | null>();
const describing = new Set<string>();
let combinedSnapshot: readonly ConsoleOperationSummary[] = [];
let combinedSource: { readonly active: readonly ConsoleOperationSummary[]; readonly revision: number } | null = null;
let describedRevision = 0;

function referencedOperationIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const state of theaters.values()) {
    for (const objective of state.objectives) {
      ids.add(objective.id);
    }
  }
  return ids;
}

/** 목록에 없는데 목표가 가리키는 Operation 을 describe 로 채운다. 목록에 돌아온 id 는 캐시에서 걷는다. */
function describeMissingOperations(): void {
  const active = new Set(operationsSnapshot.map((operation) => operation.id));
  let changed = false;
  for (const id of [...described.keys()]) {
    if (active.has(id)) { described.delete(id); changed = true; }
  }
  if (changed) { describedRevision += 1; }
  for (const id of referencedOperationIds()) {
    if (active.has(id) || described.has(id) || describing.has(id)) continue;
    describing.add(id);
    void describeOperation(id)
      .then((description) => {
        described.set(id, description === null ? null : {
          id: description.operation.id,
          theaterId: description.operation.theaterId,
          type: description.operation.type,
          title: description.operation.title,
          // 보관된 Operation 은 실행이 멈춘 상태다 — 지금의 휴면 줄과 같은 모양으로 선다.
          activity: "ended",
          ownActivity: "ended",
        });
        if (description) for (const child of description.operation.childSessions ?? []) {
          described.set(child.id, { id: child.id, theaterId: description.operation.theaterId, type: "agent",
            title: readOperationLaunch(child.payload).sessionName ?? child.id.slice(0, 8),
            parentOperationId: description.operation.id, activity: "ended", ownActivity: "ended" });
        }
      })
      .catch(() => { /* 읽지 못하면 이번에는 닫힘으로 두고 다음 변화 때 다시 묻는다 */ })
      .finally(() => {
        describing.delete(id);
        describedRevision += 1;
        notify();
      });
  }
  if (changed) notify();
}

/** 구성원 Operation — 임무가 아직 없어도 목표가 아니며 명단에서 제외되어야 한다. */
function memberIds(objectives: readonly Objective[]): ReadonlySet<string> {
  return new Set(objectives.flatMap((objective) => objective.members.filter((member) => member.sessionName !== null).map((member) => member.id)));
}

/**
 * Operation 목록과 목표를 맞춘다 — 읽어 둔 Theater 에 처음 보는 에이전트 Operation 이 있으면 그 목표를 받아 온다.
 * 기록이 있는 목표는 목록에서 빠졌다는 것만으로 빼지 않는다: 완료한 목표의 Operation 은 보관되어 일반 목록에서
 * 사라지지만 목표는 완료 목록에 그대로 있어야 한다. 그런 목표가 실제로 사라지는 때는 영구 삭제(operation:purged)와
 * 서버의 remove 사건뿐이다(removeObjectiveLocally·installObjectiveState).
 * 기록이 없는 항목(`recorded === false`, 따로 만든 에이전트 Operation 이 「미분류」에 선 것)은 Operation 그 자체라
 * 목록에서 빠지면(보관·삭제) 곧바로 거둔다 — 서버의 목록도 같은 규칙으로 그 항목을 뺀다. 복원되면 처음 보는
 * Operation 으로 다시 받아 온다.
 */
function reconcileOperations(api: ClientApiCapability): void {
  const listed = new Set(operationsSnapshot.map((operation) => operation.id));
  // 세션이 일시 거절 중이면 목표를 묻지 않는다 — 게이트가 내려가거나 기한이 지난 뒤의 스냅숏·타이머가 다시 맞춘다.
  const holding = degraded !== null && Date.now() < degraded.until;
  for (const [theaterId, state] of theaters) {
    if (!state.loaded) continue;
    if (state.objectives.some((objective) => objective.recorded === false && !listed.has(objective.id))) {
      setTheater(theaterId, { objectives: state.objectives.filter((objective) => objective.recorded !== false || listed.has(objective.id)) });
    }
    // 제목은 Operation 의 것이다 — 자동 작명처럼 사건 없이 바뀐 제목도 Operation 목록에서 따라간다.
    const titles = new Map(operationsSnapshot.map((operation) => [operation.id, operation.title]));
    const stale = (theaters.get(theaterId) ?? state).objectives;
    if (stale.some((objective) => titles.has(objective.id) && titles.get(objective.id) !== objective.title)) {
      setTheater(theaterId, { objectives: stale.map((objective) => (titles.has(objective.id) && titles.get(objective.id) !== objective.title ? { ...objective, title: titles.get(objective.id)! } : objective)) });
    }
    const known = new Set((theaters.get(theaterId) ?? state).objectives.map((objective) => objective.id));
    const members = memberIds(state.objectives);
    for (const operation of operationsSnapshot) {
      // 부모 아래 선 Operation(구성원)은 목표가 아니다 — 코어가 구성원으로 기록한 것은 묻지도 않는다.
      if (operation.theaterId !== theaterId || operation.type !== "agent" || operation.parentOperationId || known.has(operation.id) || members.has(operation.id) || fetching.has(operation.id) || unknownToServer.has(operation.id)) continue;
      if (holding) continue;
      fetching.add(operation.id);
      void post<{ objective: Objective }>(api, "/objective/get", { objectiveId: operation.id })
        .then(({ objective }) => {
          const latest = theaters.get(objective.theaterId) ?? EMPTY;
          // 응답을 기다리는 사이 담당으로 연결됐으면 목표가 아니다.
          if (!latest.objectives.some((candidate) => candidate.id === objective.id) && !memberIds(latest.objectives).has(objective.id)) setTheater(objective.theaterId, { objectives: [objective, ...latest.objectives] });
        })
        .catch((error: unknown) => {
          // 목표가 없다는 확정 답(404 unknown_objective)만 기억한다 — 401 같은 일시 거절은 세션이 돌아오면 다시 묻는다.
          if (error instanceof Error && error.message === "unknown_objective") unknownToServer.add(operation.id);
          else if (isTransient(error)) noteTransient();
        })
        .finally(() => { fetching.delete(operation.id); });
    }
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function setTheater(theaterId: string, next: Partial<TheaterState>): void {
  theaters.set(theaterId, { ...(theaters.get(theaterId) ?? EMPTY), ...next });
  notify();
  describeMissingOperations();
}

/**
 * 활성 Theater 를 먼저 읽고, 그 요청이 끝난 뒤에만 나머지를 읽는다.
 * 나머지는 등록된 모든 Theater(비활성 Theater 의 사이드바에도 목표 줄이 선다)와, 스냅숏의 최상위 에이전트
 * Operation(`type==="agent" && !parentOperationId`)이 속한 Theater 다. 한 번 읽은 뒤에는 사건으로만 갱신한다.
 */
function loadAgentTheaters(api: ClientApiCapability, activeId: string | null): void {
  const rest: string[] = [];
  const seen = new Set<string>(activeId ? [activeId] : []);
  const candidates = [
    ...(installed?.consoleState.getTheaters() ?? []).map((theater) => theater.id),
    ...operationsSnapshot.filter((operation) => operation.type === "agent" && !operation.parentOperationId).map((operation) => operation.theaterId),
  ];
  for (const theaterId of candidates) {
    if (!theaterId || seen.has(theaterId)) continue;
    seen.add(theaterId);
    rest.push(theaterId);
  }
  // 세션이 일시 거절 중이면 기한이 지난 뒤 아직 못 읽은 첫 Theater 하나만 탐침으로 묻는다 — 성공하면 게이트가 내려가 나머지가 따라간다.
  if (degraded) {
    if (Date.now() < degraded.until || inflight.size > 0) return;
    const probe = [...(activeId ? [activeId] : []), ...rest].find((theaterId) => !theaters.get(theaterId)?.loaded);
    if (probe) void loadTheater(api, probe, true);
    return;
  }
  const lead = activeId ? loadTheater(api, activeId) : Promise.resolve();
  void lead.then(() => {
    // 활성 Theater 가 일시 거절을 받았으면 나머지를 한꺼번에 두드리지 않는다.
    if (installed?.api !== api || degraded) return;
    for (const theaterId of rest) void loadTheater(api, theaterId);
  });
}

export function installObjectiveState(ctx: PluginInstallContext): () => void {
  installed = ctx;
  // 실패 장부는 새 설치에서 처음부터다 — 확정 실패로 정착시킨 Theater 도 다시 묻는다.
  for (const [theaterId, retry] of [...loadRetries]) if (retry.permanent) unsettle(theaterId);
  loadRetries.clear();
  degraded = null;
  clearRetryTimer();
  const offItem = ctx.consoleEvents.subscribe("objectives:objective", (payload) => {
    // 스트림 프레임은 살아 있는 세션에서만 온다.
    noteAlive();
    const event = payload as ObjectiveEvent | null;
    if (!event || typeof event.objectiveId !== "string" || typeof event.theaterId !== "string") return;
    unknownToServer.delete(event.objectiveId);
    const current = theaters.get(event.theaterId) ?? EMPTY;
    if (event.op === "remove") { setTheater(event.theaterId, { objectives: current.objectives.filter((objective) => objective.id !== event.objectiveId) }); return; }
    if (!event.objective) return;
    const exists = current.objectives.some((objective) => objective.id === event.objectiveId);
    const merged = exists ? current.objectives.map((objective) => (objective.id === event.objectiveId ? event.objective! : objective)) : [event.objective, ...current.objectives];
    // 위임 직후 담당 Operation 을 목표로 먼저 받아 왔을 수 있다 — 어느 목표의 담당이 된 Operation 은 목록에서 뺀다.
    const members = memberIds(merged);
    const objectives = members.size ? merged.filter((objective) => !members.has(objective.id)) : merged;
    // 순서가 함께 오면 서버의 줄을 따른다 — 목록에 없는 id 는 건너뛰고, 순서에 없는 항목은 뒤에 그대로 둔다.
    if (event.order) {
      const rank = new Map(event.order.map((id, index) => [id, index]));
      setTheater(event.theaterId, { objectives: [...objectives].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)) });
      return;
    }
    setTheater(event.theaterId, { objectives });
  });
  const offGroup = ctx.consoleEvents.subscribe("group:changed", (payload) => {
    noteAlive();
    const group = (payload as { group?: ObjectiveGroup } | null)?.group;
    if (!group || typeof group.id !== "string" || typeof group.theaterId !== "string") return;
    const current = theaters.get(group.theaterId) ?? EMPTY;
    const exists = current.groups.some((candidate) => candidate.id === group.id);
    setTheater(group.theaterId, { groups: (exists ? current.groups.map((candidate) => (candidate.id === group.id ? group : candidate)) : [...current.groups, group]).slice().sort((a, b) => a.order - b.order) });
  });
  // 영구 삭제된 Operation 의 목표는 되살아날 수 없다 — 서버도 같은 때 remove 를 보내지만, 받는 순서와 무관하게 거둔다.
  const offPurged = ctx.consoleEvents.subscribe(OPERATION_PURGED_EVENT, (payload) => {
    const operationId = (payload as { operationId?: unknown } | null)?.operationId;
    if (typeof operationId !== "string") return;
    unknownToServer.delete(operationId);
    described.set(operationId, null);
    describedRevision += 1;
    removeObjectiveLocally(operationId);
  });
  const offRemoved = ctx.consoleEvents.subscribe("group:removed", (payload) => {
    noteAlive();
    const data = payload as { groupId?: string; theaterId?: string } | null;
    if (!data || typeof data.groupId !== "string") return;
    for (const [theaterId, state] of theaters) if (state.groups.some((group) => group.id === data.groupId)) setTheater(theaterId, { groups: state.groups.filter((group) => group.id !== data.groupId) });
  });
  // 활성 Theater 를 먼저 읽고, 그 요청이 끝난 뒤 등록된 나머지 Theater 와 최상위 에이전트 Operation 이 속한 Theater 를 읽는다.
  // 캡션 칩은 표면이 닫혀 있어도, 그리고 그 Theater 가 활성이 아니어도 서야 한다. loadTheater 는 멱등이다.
  let lastTheater = ctx.consoleState.getActiveTheaterId();
  let lastActiveOperation = ctx.consoleState.getActiveOperationId();
  let listedTheaters = new Set(ctx.consoleState.getTheaters().map((theater) => theater.id));
  operationsSnapshot = ctx.consoleState.getOperations({ nested: true });
  loadAgentTheaters(ctx.api, lastTheater);
  const offConsole = ctx.consoleState.subscribe(() => {
    const current = ctx.consoleState.getActiveTheaterId();
    if (current !== lastTheater) {
      lastTheater = current;
      clearSelectionTheater();
      // 사람이 그 Theater 를 보러 왔다 — 일시 실패로 미룬 조회를 게이트와 무관하게, 마지막 실패에서 첫 간격이 지났으면 지금 묻는다.
      if (current && !theaters.get(current)?.loaded) { rearm(current); void loadTheater(ctx.api, current); }
    }
    // 등록·복원으로 다시 나타난 Theater 는 확정 실패를 풀고 처음부터 묻는다.
    const theaterIds = new Set(ctx.consoleState.getTheaters().map((theater) => theater.id));
    for (const [theaterId, retry] of [...loadRetries]) if (retry.permanent && theaterIds.has(theaterId) && !listedTheaters.has(theaterId)) unsettle(theaterId);
    listedTheaters = theaterIds;
    // 가장 마지막 선택이 이긴다 — 어느 경로로든 Operation 이 활성이 되면 그 전에 줄·팔레트가 남긴 reveal 은 버리고,
    // 표면이 열려 있으면 활성 Operation 의 목표로 옮긴다. 닫혀 있으면 다음에 열릴 때 따라간다.
    const activeOperation = ctx.consoleState.getActiveOperationId();
    if (activeOperation !== lastActiveOperation) {
      lastActiveOperation = activeOperation;
      if (activeOperation) {
        reveal = null;
        followActiveOperation();
      }
    }
    operationsSnapshot = ctx.consoleState.getOperations({ nested: true });
    loadAgentTheaters(ctx.api, current);
    reconcileOperations(ctx.api);
    notify();
    describeMissingOperations();
  });
  let focusOutTimer: ReturnType<typeof setTimeout> | null = null;
  const onFocusOut = (event: FocusEvent) => {
    if (focusOutTimer !== null) { clearTimeout(focusOutTimer); focusOutTimer = null; }
    if (!pendingSelectionOperationId || isObjectiveEditing(event.relatedTarget)) return;
    // 실제 포인터 이동은 focusout과 다음 focus 사이에 microtask를 실행할 수 있다.
    // 이동 대상을 먼저 확인하고, 전체 포커스 전이가 끝난 다음 task에서 한 번 더 판정한다.
    focusOutTimer = setTimeout(() => {
      focusOutTimer = null;
      if (installed !== ctx || isObjectiveEditing()) return;
      const operationId = pendingSelectionOperationId;
      pendingSelectionOperationId = null;
      if (operationId) handleMapOperationSelected(operationId);
    }, 0);
  };
  if (typeof document !== "undefined") document.addEventListener("focusout", onFocusOut);
  return () => {
    offItem(); offGroup(); offPurged(); offRemoved(); offConsole();
    if (typeof document !== "undefined") document.removeEventListener("focusout", onFocusOut);
    if (focusOutTimer !== null) clearTimeout(focusOutTimer);
    if (installed === ctx) { installed = null; clearSelectionTheater(); }
    clearRetryTimer();
  };
}

/** 목표 하나를 이 화면에서 거둔다 — 영구 삭제 사건과, 휴지통처럼 사람이 지운 직후에 쓴다(서버의 remove 는 유예가 끝난 뒤에 온다). */
export function removeObjectiveLocally(objectiveId: string): void {
  for (const [theaterId, state] of theaters) {
    if (state.objectives.some((objective) => objective.id === objectiveId)) setTheater(theaterId, { objectives: state.objectives.filter((objective) => objective.id !== objectiveId) });
  }
}

/** 사람의 답을 기다리는 결정 요청 — 요청이 섰고 끝나지 않은 목표. 목록 요약·구획·레일 배지가 같은 셈을 쓴다. */
export const hasDecisionRequest = (objective: Objective): boolean => !!objective.decisionRequest && !objective.done;

/** 레일 아이콘 배지의 수 — 표면이 닫혀 있어도 활성 Theater 는 미리 읽혀 있다(installObjectiveState). */
export function pendingDecisionCount(theaterId: string | null): number {
  return readTheater(theaterId).objectives.filter(hasDecisionRequest).length;
}

export function objectivesApi(): ClientApiCapability | null {
  return installed?.api ?? null;
}

export async function post<T>(api: ClientApiCapability, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await api.fetch("objectives", path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    // 호스트가 !ok 응답을 먼저 ApiError 로 끊어 post 의 코드 추출에 닿지 않는다 —
    // body 의 구조화 코드만 살려 띠·토스트가 사람의 말을 고르게 한다. 코드가 아니면 원본을 그대로 던진다.
    // 상태는 함께 싣는다 — 부르는 쪽이 일시 거절(401·5xx)과 확정 거절을 가른다. 코드 비교(message)는 그대로다.
    const code = apiErrorCode(error);
    const failure = code === null ? error : Object.assign(new Error(code), { status: (error as { status: number }).status });
    // 확정 거절도 서버가 인가한 뒤의 답이다 — 세션은 살아 있다. 게이트가 확정 실패한 탐침 뒤에 서 있지 않게 한다.
    if (!isTransient(failure)) noteAlive();
    throw failure;
  }
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw Object.assign(new Error(payload?.error ?? `http_${response.status}`), { status: response.status });
  noteAlive();
  return payload as T;
}

/**
 * ApiError 의 구조화 코드 판독 — 호스트와 플러그인 번들이 모듈을 따로 들고 있어도 되게
 * instanceof 가 아니라 모양으로 본다. 원시 본문·내부 메시지는 꺼내지 않고 안전 코드 패턴만 받는다.
 */
function apiErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (record.name !== "ApiError" || typeof record.status !== "number") return null;
  const body = record.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null;
}

/** `force` 는 읽은 여부와 일시 실패 기한을 무시하고 지금 묻는다 — 게이트의 탐침이 쓴다. */
export function loadTheater(api: ClientApiCapability, theaterId: string, force = false): Promise<void> {
  const current = theaters.get(theaterId);
  if (current?.loaded && !force) return Promise.resolve();
  const pending = inflight.get(theaterId);
  if (pending) return pending;
  // 일시 실패로 미룬 Theater 는 기한 전에 다시 묻지 않는다 — 스냅숏마다 부르는 길이 /state 를 두드리지 않게.
  const retry = loadRetries.get(theaterId);
  if (retry && !force && Date.now() < retry.nextAt) return Promise.resolve();
  const fail = (permanent: boolean) => {
    if (!permanent) noteTransient();
    // 이미 읽은 Theater 의 재조회 실패는 기존 목록을 그대로 둔다.
    if (theaters.get(theaterId)?.loaded) return;
    const now = Date.now();
    if (permanent) {
      loadRetries.set(theaterId, { permanent: true, failures: 0, failedAt: now, nextAt: Number.POSITIVE_INFINITY });
      setTheater(theaterId, { loaded: true });
      return;
    }
    const previous = loadRetries.get(theaterId);
    const failures = (previous?.failures ?? 0) + 1;
    loadRetries.set(theaterId, { permanent: false, failures, failedAt: now, nextAt: now + retryDelay(failures) });
  };
  const task = post<{ objectives: Objective[]; groups: ObjectiveGroup[]; launch: { available: boolean } }>(api, "/state", { theaterId })
    .then((state) => {
      // 200 인데 모양이 다르면 확정 실패다 — 다시 물어도 같은 답이 온다.
      if (!Array.isArray(state?.objectives) || !Array.isArray(state.groups) || typeof state.launch !== "object" || state.launch === null) { fail(true); return; }
      loadRetries.delete(theaterId);
      setTheater(theaterId, { objectives: state.objectives, groups: [...state.groups].sort((a, b) => a.order - b.order), loaded: true, launchAvailable: state.launch.available });
      // 읽는 사이 생긴 Operation 도 목표로 — 스냅숏 기준으로 한 번 맞춘다.
      if (installed) { operationsSnapshot = installed.consoleState.getOperations({ nested: true }); reconcileOperations(installed.api); }
    }, (error: unknown) => { fail(!isTransient(error)); })
    // 응답을 적용하다 던진 것은 요청 실패가 아니다 — 같은 답이 다시 올 테니 확정으로 정착시킨다.
    .catch(() => { fail(true); })
    .finally(() => {
      inflight.delete(theaterId);
      // 아직 미룬 Theater 가 남았으면 그 기한에 다시 깨운다 — 더 이른 예약(게이트가 내려간 스윕 등)은 그대로 둔다.
      if (installed) scheduleRetry();
    });
  inflight.set(theaterId, task);
  return task;
}

export function subscribeObjective(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readAllTheaters(): readonly TheaterState[] {
  return [...theaters.values()];
}

export function readTheater(theaterId: string | null): TheaterState {
  return theaterId ? theaters.get(theaterId) ?? EMPTY : EMPTY;
}

export function useObjectiveTheater(theaterId: string | null): TheaterState {
  return useSyncExternalStore(subscribeObjective, () => readTheater(theaterId), () => readTheater(theaterId));
}

/** 일반 목록의 Operation 과, 목표가 가리키는 보관 Operation 의 describe 요약. 참조는 바뀔 때만 새로 만든다. */
export function operationSummaries(): readonly ConsoleOperationSummary[] {
  if (combinedSource?.active === operationsSnapshot && combinedSource.revision === describedRevision) return combinedSnapshot;
  const archived = [...described.values()].filter((summary): summary is ConsoleOperationSummary => summary !== null);
  combinedSnapshot = archived.length === 0 ? operationsSnapshot : [...operationsSnapshot, ...archived];
  combinedSource = { active: operationsSnapshot, revision: describedRevision };
  return combinedSnapshot;
}

export function useOperationSummaries(): readonly ConsoleOperationSummary[] {
  return useSyncExternalStore(subscribeObjective, operationSummaries, operationSummaries);
}

export function activeTheaterId(): string | null {
  return installed?.consoleState.getActiveTheaterId() ?? null;
}

export function activeOperationId(): string | null {
  return installed?.consoleState.getActiveOperationId() ?? null;
}

/** 팔레트·캡션에서 "이 항목으로" — 표면이 마운트되어 있으면 즉시, 아니면 열릴 때 집는다. */
export function revealObjective(target: { objectiveId: string; missionId?: string; followups?: boolean; focusTitle?: boolean }): void {
  reveal = { ...target, at: Date.now() };
  notify();
}
export function takeReveal(): RevealTarget | null {
  const current = reveal;
  reveal = null;
  return current;
}
export function useReveal(): RevealTarget | null {
  return useSyncExternalStore(subscribeObjective, () => reveal, () => reveal);
}

/**
 * 표면의 보기 상태 — 고른 목록 · 펼친 항목 · 구획 접힘 · 기한 필터. 표면을 닫으면 컴포넌트는 내려가지만 보던 자리는
 * 여기 Theater 별로 남아, 다시 열면 그대로 선다. 보는 사람의 편의라 메모리에만 둔다(새로고침이면 처음부터).
 */
export interface ObjectiveViewState {
  readonly list: string;
  readonly selected: string | null;
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly dueFilter: string;
  readonly externalSelectionId?: string | null;
}
const VIEW_DEFAULT: ObjectiveViewState = { list: "all", selected: null, collapsed: { done: true }, dueFilter: "all", externalSelectionId: null };
const views = new Map<string, ObjectiveViewState>();
const viewListeners = new Set<() => void>();
export function readObjectiveView(theaterId: string | null): ObjectiveViewState {
  return (theaterId ? views.get(theaterId) : undefined) ?? VIEW_DEFAULT;
}
export function patchObjectiveView(theaterId: string | null, patch: (current: ObjectiveViewState) => Partial<ObjectiveViewState>): void {
  if (!theaterId) return;
  const current = readObjectiveView(theaterId);
  const next = { ...current, ...patch(current) };
  if (
    next.list === current.list &&
    next.selected === current.selected &&
    next.collapsed === current.collapsed &&
    next.dueFilter === current.dueFilter &&
    next.externalSelectionId === current.externalSelectionId
  ) return;
  views.set(theaterId, next);
  for (const listener of viewListeners) listener();
}
/** 표면이 열리고 닫힌 것을 보기 구독자에게 알린다 — 사이드바 줄의 선택 표시는 표면이 열려 있을 때만 선다. */
export function notifyObjectiveSurface(): void {
  for (const listener of viewListeners) listener();
}
export function subscribeObjectiveView(listener: () => void): () => void {
  viewListeners.add(listener);
  return () => { viewListeners.delete(listener); };
}
export function useObjectiveView(theaterId: string | null): ObjectiveViewState {
  return useSyncExternalStore(
    subscribeObjectiveView,
    () => readObjectiveView(theaterId),
    () => readObjectiveView(theaterId),
  );
}

let latestSelectionToken = 0;
let pendingSelectionOperationId: string | null = null;

function isObjectiveEditing(element: EventTarget | null = typeof document === "undefined" ? null : document.activeElement): boolean {
  return typeof HTMLElement !== "undefined" && element instanceof HTMLElement
    && !!element.closest(".objectives-root")
    && (element.isContentEditable || !!element.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'));
}

let selectionTheater: { readonly contextTheaterId: string | null; readonly theaterId: string } | null = null;

function clearSelectionTheater(): void {
  pendingSelectionOperationId = null;
  selectionTheater = null;
  latestSelectionToken += 1;
  notify();
}

/** 전역 Theater와 다른 무대도 목표 표면만 따라간다. 다른 레일 도구의 문맥은 바꾸지 않는다. */
export function useObjectiveDisplayTheater(contextTheaterId: string | null): string | null {
  const read = () => selectionTheater?.contextTheaterId === contextTheaterId ? selectionTheater.theaterId : contextTheaterId;
  const theaterId = useSyncExternalStore(subscribeObjective, read, read);
  useEffect(() => {
    if (selectionTheater && selectionTheater.contextTheaterId !== contextTheaterId) clearSelectionTheater();
  }, [contextTheaterId]);
  return theaterId;
}

/**
 * Cruise의 frame·Fleet Map 선택, 사이드바 목표 줄 선택과 War Room의 수동·자동 등단을 열린 목표 레일에 반영한다.
 * 레일이 닫혀 있거나 확장 전용 표면일 때는 자동 열기/전환 없이 조용히 무시하고, 미연결 Operation 은 기존 선택을 보존한다.
 */
export function handleMapOperationSelected(operationId: string): void {
  selectOperationObjective(operationId, () => !!installed?.rail.isOpen(OBJECTIVE_PANEL_ID));
}

function selectOperationObjective(operationId: string, shown: () => boolean): void {
  if (!installed || !shown()) return;
  const token = ++latestSelectionToken;
  pendingSelectionOperationId = null;
  // 자동 등단으로 현재 목표의 편집 DOM을 교체하지 않는다. 입력을 떠나면 가장 최근 등단만 적용한다.
  if (isObjectiveEditing()) {
    pendingSelectionOperationId = operationId;
    return;
  }

  const allOps = operationsSnapshot;
  const op = allOps.find((candidate) => candidate.id === operationId)
    ?? installed.consoleState.getOperations({ nested: true }).find((candidate) => candidate.id === operationId);

  let targetTheaterId: string | null = op?.theaterId ?? null;
  if (!targetTheaterId) {
    for (const [tId, tState] of theaters) {
      if (tState.objectives.some((objective) => objective.id === operationId || objective.members.some((m) => m.id === operationId && m.sessionName !== null))) {
        targetTheaterId = tId;
        break;
      }
    }
  }
  if (!targetTheaterId) {
    targetTheaterId = activeTheaterId();
  }
  if (!targetTheaterId) return;

  const theaterId = targetTheaterId;
  selectionTheater = { contextTheaterId: activeTheaterId(), theaterId };
  const select = () => {
    if (token !== latestSelectionToken || !shown()) return;
    if (selectionTheater?.theaterId !== theaterId) return;
    // 조회를 기다리는 사이 시작한 편집도 같은 보류 규칙을 따른다.
    if (isObjectiveEditing()) { pendingSelectionOperationId = operationId; return; }
    const matchingObjective = theaters.get(theaterId)?.objectives.find(
      (objective) => objective.id === operationId || objective.members.some((member) => member.id === operationId && member.sessionName !== null),
    );
    if (!matchingObjective) return;
    patchObjectiveView(theaterId, () => ({ selected: matchingObjective.id, externalSelectionId: matchingObjective.id }));
  };
  if (theaters.get(theaterId)?.loaded) select();
  else { rearm(theaterId); void loadTheater(installed.api, theaterId).then(select); }
  // 연결된 목표가 없어도 목록은 무대 소속 Theater만 보여 준다.
  notify();
}

/**
 * 표면이 열릴 때 — 사람이 줄·팔레트로 가리킨 목표(reveal)가 없으면 캔버스의 활성 Operation 을 따라간다. 사이드바가 그 줄을
 * 활성으로 보이는 동안 표면이 빈 채 서지 않게 한다. 선택 규칙(편집 중 보류, 연결 목표가 없으면 보던 자리 유지)은 위와 같고,
 * 활성 Operation 이 없으면 보던 자리 그대로다.
 */
export function followActiveOperation(): void {
  if (reveal) return;
  const operationId = installed?.consoleState.getActiveOperationId() ?? null;
  // 레일이든 확장 표면이든 — 열린 자리가 활성 Operation 을 보인다.
  if (operationId) selectOperationObjective(operationId, isObjectiveSurfaceOpen);
}

const ACCESS_ARRIVAL_TIMEOUT_MS = 5_000;

export function focusOperation(operationId: string): void {
  // 착지는 Snap 전체다 — 스냅할 수 없는 모드·화면에서는 호스트가 같은 일반 이동으로 폴백한다.
  // 확장 표면은 코어 이동이 그때 정리한다. 여기서 자기 표면만 닫으면 옆 페인이 무대를 덮은 채 남는다.
  // 보관 세션은 복원이 끝난 뒤의 focus 가 그 정리를 하므로, 기다리는 동안 표면이 열려 있는 것은 그대로 둔다.
  const host = installed;
  if (!host) return;
  const present = () => host.consoleState.getOperations({ nested: true }).some((operation) => operation.id === operationId);
  if (present() || described.get(operationId) === null) {
    host.operations.focus(operationId, { snap: "full" });
    return;
  }
  // 보관된 세션이다 — 여는 것 자체가 다시 쓰겠다는 뜻이므로 Core 가 그 Cluster 를 조용히 휴면으로 되돌린 뒤 연다.
  // 표시는 없다. 복원된 노드는 사건으로 일반 목록에 도착하므로, 도착을 기다렸다가 옮겨 간다.
  void accessOperation(operationId, "open")
    .then(() => new Promise<void>((resolve) => {
      if (present()) { resolve(); return; }
      const timer = setTimeout(() => { off(); resolve(); }, ACCESS_ARRIVAL_TIMEOUT_MS);
      const off = host.consoleState.subscribe(() => {
        if (!present()) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    }))
    .then(() => { if (present()) host.operations.focus(operationId, { snap: "full" }); })
    .catch(() => { /* 복원하지 못하면 그 자리에 머문다 — 줄은 그대로 휴면으로 남는다 */ });
}

const OBJECTIVE_PANEL_ID = "objectives";
const OBJECTIVE_PLACE_KEY = "objectives.lastPlace";
type ObjectivePlace = "rail" | "expanded";

function rememberObjectivePlace(place: ObjectivePlace): void {
  installed?.preferences.write(OBJECTIVE_PLACE_KEY, place);
}

/** 아이콘·단축키는 현재 자리를 닫고, 닫혀 있으면 마지막 자리에 연다. */
export function toggleObjectivePlace(rail = installed?.rail, surfaces = installed?.surfaces): void {
  if (!rail || !surfaces) return;
  if (rail.isOpen(OBJECTIVE_PANEL_ID)) { rememberObjectivePlace("rail"); rail.close(OBJECTIVE_PANEL_ID); return; }
  if (surfaces.isOpen(OBJECTIVE_PANEL_ID)) { rememberObjectivePlace("expanded"); surfaces.closeSurface(OBJECTIVE_PANEL_ID); return; }
  const remembered = installed?.preferences.read<unknown>(OBJECTIVE_PLACE_KEY, "rail");
  const place = remembered === "expanded" ? "expanded" : "rail";
  if (place === "expanded") surfaces.open({ surfaceId: OBJECTIVE_PANEL_ID });
  else rail.open(OBJECTIVE_PANEL_ID);
  rememberObjectivePlace(place);
}

export function expandObjective(): void {
  if (!installed?.rail.isOpen(OBJECTIVE_PANEL_ID)) return;
  installed.surfaces.open({ surfaceId: OBJECTIVE_PANEL_ID });
  installed.rail.close(OBJECTIVE_PANEL_ID);
  rememberObjectivePlace("expanded");
}

export function dockObjective(): void {
  if (!installed?.surfaces.isOpen(OBJECTIVE_PANEL_ID)) return;
  installed.rail.open(OBJECTIVE_PANEL_ID);
  installed.surfaces.closeSurface(OBJECTIVE_PANEL_ID);
  rememberObjectivePlace("rail");
}

export function onObjectiveSurfaceClose(): void {
  // Esc나 다른 표면에 밀려 닫힌 경우에도 마지막 자리는 확장 표면이다.
  // 도킹 전환의 close 통보는 dockObjective가 이어서 rail로 다시 쓴다.
  rememberObjectivePlace("expanded");
}

export function isObjectiveSurfaceOpen(): boolean {
  return !!installed && (installed.rail.isOpen(OBJECTIVE_PANEL_ID) || installed.surfaces.isOpen(OBJECTIVE_PANEL_ID));
}

/** 목표가 하나도 없는 Theater 의 입구 — 목표는 새 Operation 에서 시작하니 호스트 컴포저를 연다. 어느 모양으로 서는지는 호스트 몫이다. */
export function openNewOperation(): void {
  installed?.composer.open();
}

/** 캡션 칩은 이미 열린 자리를 사용하고, 닫혀 있을 때만 확장 표면을 연다. 마지막 자리 선택은 바꾸지 않는다. */
export function openObjectiveFromCluster(theaterId?: string): void {
  // 비활성 Theater 의 줄 — 그 Theater 로 옮긴 뒤 표면을 연다. reveal 은 표면이 새 Theater 의 목록을 읽을 때 집힌다.
  if (installed && theaterId && installed.consoleState.getActiveTheaterId() !== theaterId) installed.consoleState.setActiveTheater(theaterId);
  if (installed?.rail.isOpen(OBJECTIVE_PANEL_ID) || installed?.surfaces.isOpen(OBJECTIVE_PANEL_ID)) return;
  installed?.surfaces.open({ surfaceId: OBJECTIVE_PANEL_ID });
}
