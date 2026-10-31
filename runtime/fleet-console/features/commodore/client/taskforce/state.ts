import { useSyncExternalStore } from "react";
import type { CommodoreClientDeps } from "../deps.js";
import { post } from "../request.js";
import { MAX_TASKFORCE_LEDGER_PAGE, TASKFORCE_ROUTES, type TaskforceEvent, type TaskforceJudgingStatus, type TaskforceLedgerEntry, type TaskforceLedgerPage, type TaskforceState, type TaskforceSummary } from "../../shared/contracts/taskforce.js";

type Snapshot = {
  readonly state?: TaskforceState;
  readonly entries: readonly TaskforceLedgerEntry[];
  readonly judging: readonly string[];
  readonly outcomes: NonNullable<TaskforceJudgingStatus["outcomes"]>;
  readonly judgingAt: number;
  readonly hasMore: boolean;
  readonly loaded: boolean;
  readonly error: boolean;
  readonly actionEntries: readonly TaskforceLedgerEntry[];
  readonly actionsLoaded: boolean;
  readonly actionsLoading: boolean;
  readonly actionsError: boolean;
};
const EMPTY: Snapshot = { entries: [], judging: [], outcomes: {}, judgingAt: -1, hasMore: false, loaded: false, error: false, actionEntries: [], actionsLoaded: false, actionsLoading: false, actionsError: false };
type ReadResult = TaskforceLedgerPage & { readonly taskforce: TaskforceState; readonly judging: TaskforceJudgingStatus };
const snapshots = new Map<string, Snapshot>();
const removed = new Set<string>();
let summaries: readonly TaskforceSummary[] = [];
let deps: CommodoreClientDeps | null = null;
let version = 0;
let refreshFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const flights = new Map<string, Promise<void>>();
const emit = () => { version += 1; for (const listener of listeners) listener(); };
export const subscribeTaskforces = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const readTaskforces = () => summaries;
export const wasTaskforceRemoved = (id: string) => removed.has(id);
export const readTaskforce = (id: string): Snapshot => snapshots.get(id) ?? EMPTY;
export const useTaskforces = () => useSyncExternalStore(subscribeTaskforces, readTaskforces, readTaskforces);
export const useTaskforce = (id: string) => useSyncExternalStore(subscribeTaskforces, () => readTaskforce(id), () => EMPTY);

function rememberState(state: TaskforceState): void {
  if (removed.has(state.id)) return;
  const old = readTaskforce(state.id);
  snapshots.set(state.id, { ...old, state });
  const previous = summaries.find((summary) => summary.id === state.id);
  const summary: TaskforceSummary = { ...state, judging: old.judging, ...(previous?.preview ? { preview: previous.preview } : {}) };
  summaries = [...summaries.filter((row) => row.id !== state.id), summary].sort((a, b) => (b.preview?.at ?? b.createdAt) - (a.preview?.at ?? a.createdAt));
}

const mergeEntries = (previous: readonly TaskforceLedgerEntry[], incoming: readonly TaskforceLedgerEntry[]) => {
  const bySeq = new Map(previous.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
};

function rememberEntries(id: string, entries: readonly TaskforceLedgerEntry[]): void {
  if (removed.has(id)) return;
  const old = readTaskforce(id);
  const merged = mergeEntries(old.entries, entries);
  snapshots.set(id, { ...old, entries: merged, actionEntries: mergeEntries(old.actionEntries, entries.filter((entry) => entry.actions?.length)) });
  const newestSeq = merged.at(-1)?.seq ?? -1;
  const last = merged.findLast((entry) => entry.speaker.kind !== "system" && entry.text.trim())
    ?? merged.find((entry) => entry.speaker.kind === "system" && entry.speaker.code === "created");
  if (last) summaries = summaries.map((summary) => summary.id === id && (summary.preview?.seq ?? -1) <= newestSeq
    ? { ...summary, preview: { seq: last.seq, at: last.at, text: last.text, speaker: last.speaker } } : summary)
    .sort((a, b) => (b.preview?.at ?? b.createdAt) - (a.preview?.at ?? a.createdAt));
}

function rememberJudging(status: TaskforceJudgingStatus): void {
  if (removed.has(status.taskforceId)) return;
  const previous = readTaskforce(status.taskforceId);
  if (previous.judgingAt > status.at) return;
  snapshots.set(status.taskforceId, { ...previous, judging: status.judging, outcomes: status.outcomes ?? {}, judgingAt: status.at });
  summaries = summaries.map((row) => row.id === status.taskforceId ? { ...row, judging: status.judging } : row);
}

export async function taskforceRequest<T>(route: keyof typeof TASKFORCE_ROUTES, body: unknown): Promise<T> {
  if (!deps) throw new Error("taskforce_unavailable");
  return post<T>(deps.api, TASKFORCE_ROUTES[route], body);
}

export function refreshTaskforces(): Promise<void> {
  if (refreshFlight) return refreshFlight;
  const owner = deps;
  const run = async () => {
    for (;;) {
      const started = version;
      const result = await taskforceRequest<{ taskforces: readonly TaskforceSummary[] }>("list", {});
      if (deps !== owner) return;
      // 읽는 동안 도착한 실시간 갱신을 오래된 목록으로 지우지 않고 다시 읽는다.
      if (started !== version) continue;
      summaries = result.taskforces.filter((row) => !removed.has(row.id));
      for (const row of summaries) {
        const previous = readTaskforce(row.id);
        if (previous.judgingAt < 0) snapshots.set(row.id, { ...previous, judging: row.judging });
      }
      emit(); return;
    }
  };
  refreshFlight = run().finally(() => { refreshFlight = null; });
  return refreshFlight;
}

export function loadTaskforce(id: string, older = false): Promise<void> {
  if (removed.has(id)) return Promise.resolve();
  const key = `${id}:${older}`;
  const flight = flights.get(key);
  if (flight) return flight;
  const owner = deps;
  const oldState = readTaskforce(id).state;
  const oldJudging = readTaskforce(id).judging;
  const before = older ? readTaskforce(id).entries[0]?.seq : undefined;
  const run = taskforceRequest<ReadResult>("read", { taskforceId: id, ...(before !== undefined ? { before } : {}) })
    .then((result) => {
      if (deps !== owner || removed.has(id)) return;
      const current = readTaskforce(id);
      // 같은 seq의 주제 편집도 실시간 상태가 우선한다. 과거 페이지로 새 상태를 되돌리지 않는다.
      if (current.state === oldState || (current.state?.lastSeq ?? -1) < result.taskforce.lastSeq) rememberState(result.taskforce);
      rememberEntries(id, result.entries);
      if (result.judging && (readTaskforce(id).judging === oldJudging || result.judging.at > readTaskforce(id).judgingAt)) rememberJudging(result.judging);
      const updated = readTaskforce(id);
      snapshots.set(id, { ...updated, loaded: true, error: false, hasMore: older || !updated.loaded ? result.hasMore : updated.hasMore });
    }).catch(() => { if (deps === owner && !removed.has(id)) snapshots.set(id, { ...readTaskforce(id), error: true }); })
    .finally(() => { if (flights.get(key) === run) flights.delete(key); if (deps === owner) emit(); });
  flights.set(key, run);
  return run;
}

/** 행동 목록만 원장 첫머리까지 읽는다. 피드의 읽은 범위와 스크롤 위치는 바꾸지 않는다. */
export async function loadTaskforceActions(id: string): Promise<void> {
  const previous = readTaskforce(id);
  if (previous.actionsLoaded || previous.actionsLoading || removed.has(id)) return;
  const owner = deps;
  snapshots.set(id, { ...previous, actionsLoading: true, actionsError: false }); emit();
  try {
    let before: number | undefined;
    for (;;) {
      const page = await taskforceRequest<ReadResult>("read", { taskforceId: id, limit: MAX_TASKFORCE_LEDGER_PAGE, ...(before !== undefined ? { before } : {}) });
      if (deps !== owner || removed.has(id)) return;
      const current = readTaskforce(id);
      snapshots.set(id, { ...current, actionEntries: mergeEntries(current.actionEntries, page.entries.filter((entry) => entry.actions?.length)) });
      if (!page.hasMore) break;
      const next = page.entries[0]?.seq;
      if (next === undefined || next === before) throw new Error("taskforce_invalid_page");
      before = next;
    }
    snapshots.set(id, { ...readTaskforce(id), actionsLoaded: true });
  } catch { if (deps === owner && !removed.has(id)) snapshots.set(id, { ...readTaskforce(id), actionsError: true }); }
  finally { if (deps === owner && !removed.has(id)) { snapshots.set(id, { ...readTaskforce(id), actionsLoading: false }); emit(); } }
}

export async function mutateTaskforce(route: Exclude<keyof typeof TASKFORCE_ROUTES, "list" | "read" | "image">, body: unknown): Promise<TaskforceState | undefined> {
  const owner = deps;
  const result = await taskforceRequest<{ taskforce?: TaskforceState; entry?: TaskforceLedgerEntry; deleted?: string }>(route, body);
  if (deps !== owner) return;
  if (result.taskforce) {
    const id = result.taskforce.id;
    if ((readTaskforce(id).state?.lastSeq ?? -1) <= result.taskforce.lastSeq) rememberState(result.taskforce);
    if (result.entry) rememberEntries(id, [result.entry]);
  }
  if (result.deleted) forgetTaskforce(result.deleted);
  emit();
  return result.taskforce;
}

function forgetTaskforce(id: string): void {
  removed.add(id);
  summaries = summaries.filter((row) => row.id !== id);
  snapshots.delete(id);
}

export function installTaskforces(next: CommodoreClientDeps): () => void {
  deps = next;
  void refreshTaskforces().catch(() => {});
  const off = next.consoleEvents.subscribe("commodore", (payload) => {
    const event = payload as TaskforceEvent | null;
    if (!event?.op?.startsWith("taskforce-")) return;
    const id = event.taskforceId;
    if (event.op === "taskforce-state") rememberState(event.state);
    if (event.op === "taskforce-ledger") rememberEntries(id, [event.entry]);
    if (event.op === "taskforce-removed") forgetTaskforce(id);
    if (event.op === "taskforce-judging") rememberJudging(event);
    emit();
  });
  const offReconnect = next.consoleEvents.onReconnect?.(() => {
    for (const [id, snapshot] of snapshots) {
      snapshots.set(id, { ...snapshot, judging: [], outcomes: {}, judgingAt: -1 });
      if (snapshot.loaded) void loadTaskforce(id);
    }
    emit();
    void refreshTaskforces().catch(() => {});
  });
  return () => { off(); offReconnect?.(); if (deps === next) deps = null; snapshots.clear(); summaries = []; removed.clear(); flights.clear(); refreshFlight = null; emit(); };
}
