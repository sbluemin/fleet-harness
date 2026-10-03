import type { AgentHost } from "@fleet-console/sdk/agent";
import type { ConsoleOperationObservation, PluginMcpTool } from "@fleet-console/sdk/mcp";
import { DEFAULT_EXPERIMENT_SETTINGS, experimentAideSelection, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

import type { Objective, ObjectiveEvent } from "../types.js";
import { createCommodoreSession, type CommodoreSession, type CommodoreTurnOutcome } from "./session.js";
import type { CommodoreStore } from "./store.js";
import type { CommandExecute } from "./tools.js";
import { EMPTY_RUN_TOTALS, type CommodoreCoordinates, type CommodoreEvent, type CommodoreRunStatus } from "./types.js";

/**
 * 감독자 — Theater 마다 하나. 사령관 세션은 턴이 끝나면 쉬고, 끝없이 도는 것은 이 감독자가 보장한다.
 *
 * 깨울 이유(보드 사건·지시·정보·사람의 메시지·정체·순찰·빈 보드·재시작)를 모아 몇 초 뒤 한 턴으로 보내고, 턴 중에 온 이유는
 * 다음 턴 하나로 합친다. 순찰은 사령관이 `next_wake` 로 예약하되 60분 상한을 지키고, 턴 오류는 1·5·15분 뒤 재시도한 뒤 60분
 * 간격으로 계속한다(자율 운영은 꺼지지 않는다). 문맥이 길어지면 다음 깨움에서 세션을 교대하고(새 세션 + 최근 행위 요약),
 * 플러그인 등록 때 켜진 Theater 를 복원한다. 멈추는 것은 둘뿐 — 글리프(자율 운영) 끔, 실험 기능 끔.
 *
 * 상한·간격·교대 비율은 감독자 내부 값이다. 사용자 설정 노브로 두지 않는다.
 */

export const PATROL_CEILING_MS = 60 * 60_000;
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
export const RETRY_STEADY_MS = 60 * 60_000;
/** 깨움 이유를 모으는 시간. */
export const COALESCE_MS = 3_000;
/** 지휘관이 이 시간 동안 쉬면(임무가 남았는데 세션이 유휴·휴면) 정체로 본다. */
export const STALL_MS = 30 * 60_000;
const STALL_CHECK_MS = 5 * 60_000;
/** 마지막 턴의 입력 토큰이 모델 문맥의 이 비율을 넘으면 다음 깨움에서 교대한다. */
const CONTEXT_ROTATE_RATIO = 0.75;
const RECENT_ACTIONS = 12;

export interface CommodoreSupervisorDeps {
  readonly store: CommodoreStore;
  readonly agent: AgentHost;
  readonly experiments: () => ConsoleExperimentSettings;
  readonly subscribeExperiments?: (listener: () => void) => () => void;
  /** Theater 의 이름과 루트 실경로 — 모르면 null(잊힌·떨어진 Theater). */
  readonly theater: (theaterId: string) => { readonly label: string; readonly root: string } | null;
  readonly objectives: (theaterId: string) => readonly Objective[];
  readonly subscribeObjectives: (listener: (event: ObjectiveEvent) => void) => () => void;
  /** 이 Theater 에 묶인 보드 도구 — 없으면 사령관은 보드 없이 선다. */
  readonly boardTools: (theaterId: string) => readonly PluginMcpTool[];
  readonly observe?: (operationId: string) => ConsoleOperationObservation | null;
  readonly emit: (event: CommodoreEvent) => void;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
}

export interface CommodoreSupervisor {
  /** 지금 상태 — 감독자가 모르는 Theater(돌지 않는)는 null. */
  status(theaterId: string): Omit<CommodoreRunStatus, "totals"> | null;
  /** 재시도 대기를 지금 깨운다. 그 상태가 아니면 `commodore_not_retrying`. */
  retry(theaterId: string): Promise<void>;
  /** 실험 기능·자율 운영을 다시 읽어 돌아야 할 Theater 를 세우고 아닌 것을 멈춘다. */
  sync(reason?: string): void;
  dispose(): Promise<void>;
}

type Phase = CommodoreRunStatus["phase"];

/**
 * 깨움 이유 코드 — 기록에는 `code` 또는 `code:N` 토큰으로 남고(화면이 로케일로 옮긴다), 모델에게는 영어 문장으로 간다.
 * 수가 붙는 코드는 절대값(지금 그 상태인 목표 수)이고, intel 만 누적이다.
 */
export type WakeCode = "patrol" | "directive" | "intel" | "message" | "board" | "decision" | "review" | "criteria" | "pending" | "followup" | "followup-failed" | "stalled" | "empty" | "restart" | "autonomy" | "retry" | "rotated";

interface PendingReason {
  count?: number;
  readonly details: string[];
}

export function wakeToken(code: WakeCode, count?: number): string {
  return count === undefined ? code : `${code}:${count}`;
}

function wakeSentence(code: WakeCode, reason: PendingReason): string {
  const n = reason.count ?? 0;
  const plural = (noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const tail = reason.details.length ? `: ${reason.details.join("; ")}` : "";
  switch (code) {
    case "patrol": return `patrol${tail}`;
    case "directive": return `directive changed${tail}`;
    case "intel": return `${plural("new intel item")}`;
    case "message": return "the person sent you a message (quoted below)";
    case "board": return "the board changed";
    case "decision": return `inbox: ${plural("decision request")}`;
    case "review": return `inbox: ${n} awaiting review`;
    case "criteria": return `inbox: ${plural("criteria proposal")}`;
    case "pending": return `inbox: ${plural("objective")} not commenced`;
    case "followup": return `inbox: ${plural("open follow-up candidate")}`;
    case "followup-failed": return `inbox: ${plural("failed follow-up creation")}`;
    case "stalled": return `${plural("stalled objective")}${tail}`;
    case "empty": return "the board is empty";
    case "restart": return "Console restarted";
    case "autonomy": return "autonomy turned on";
    case "retry": return "retry requested by the person";
    case "rotated": return "your session was replaced";
    default: return code;
  }
}

interface Runner {
  readonly theaterId: string;
  session: CommodoreSession | null;
  phase: Phase;
  reason?: string;
  nextWakeAt?: number;
  /** 다음 턴에 실을 이유 — 코드마다 하나, 순서 보존. */
  pending: Map<WakeCode, PendingReason>;
  /** 사람의 메시지 — 다음 턴에 그대로 실린다. */
  messages: string[];
  coalesce: ReturnType<typeof setTimeout> | null;
  patrol: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  inflight: Promise<void> | null;
  stopping: boolean;
  /** 턴 중에 사령관이 순찰을 예약했다. */
  patrolSet: boolean;
  lastInputTokens: number;
  coordinates: CommodoreCoordinates | null;
  rotateNext: "replaced" | "restarted" | null;
  recentActions: string[];
  signature: string;
  stalledSince: Map<string, number>;
  stalledReported: Set<string>;
  emptyReported: boolean;
}

export function createCommodoreSupervisor(deps: CommodoreSupervisorDeps): CommodoreSupervisor {
  const now = deps.now ?? Date.now;
  const runners = new Map<string, Runner>();
  const cleanups: (() => void)[] = [];
  let disposed = false;

  const settings = () => { try { return deps.experiments(); } catch { return DEFAULT_EXPERIMENT_SETTINGS; } };
  const shouldRun = (theaterId: string) => settings().commodore && deps.store.read(theaterId)?.autonomy === true && deps.theater(theaterId) !== null;
  const resolveCoordinates = (theaterId: string): CommodoreCoordinates => {
    const state = deps.store.read(theaterId);
    if (state?.model && state.effort) return { model: state.model, effort: state.effort };
    return experimentAideSelection(settings(), "commodore");
  };

  const publish = (runner: Runner) => {
    const totals = deps.store.read(runner.theaterId)?.run ?? EMPTY_RUN_TOTALS;
    deps.emit({ op: "run", theaterId: runner.theaterId, run: { phase: runner.phase, ...(runner.reason ? { reason: runner.reason } : {}), ...(runner.nextWakeAt ? { nextWakeAt: runner.nextWakeAt } : {}), totals } });
  };
  const setPhase = (runner: Runner, phase: Phase, reason?: string) => {
    runner.phase = phase;
    runner.reason = reason;
    publish(runner);
  };
  const record = (runner: Runner, entry: Parameters<CommodoreStore["transcriptAppend"]>[1]) => {
    try { deps.store.transcriptAppend(runner.theaterId, entry); }
    catch (error) { console.warn(`[objectives] commodore log failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const clearTimer = (runner: Runner, key: "coalesce" | "patrol" | "retry") => {
    const timer = runner[key];
    if (timer) clearTimeout(timer);
    runner[key] = null;
  };
  const schedule = (runner: Runner, key: "coalesce" | "patrol" | "retry", delayMs: number, run: () => void) => {
    clearTimer(runner, key);
    const timer = setTimeout(() => { runner[key] = null; if (!runner.stopping && !disposed) run(); }, Math.max(0, delayMs));
    timer.unref?.();
    runner[key] = timer;
  };

  /** 이유를 모은다 — 턴이 돌고 있으면 끝난 뒤, 아니면 잠깐 뒤 한 턴. 수는 절대값이 덮고 `bump` 는 누적한다. */
  const wake = (runner: Runner, code: WakeCode, input: { readonly count?: number; readonly bump?: boolean; readonly detail?: string } = {}) => {
    if (runner.stopping) return;
    const existing = runner.pending.get(code);
    const reason: PendingReason = existing ?? { details: [] };
    if (input.bump) reason.count = (reason.count ?? 0) + 1;
    else if (input.count !== undefined) reason.count = input.count;
    if (input.detail && !reason.details.includes(input.detail)) reason.details.push(input.detail);
    if (!existing) runner.pending.set(code, reason);
    if (runner.inflight) return;
    if (runner.phase === "retrying" || runner.phase === "error") return; // 재시도 시각에 함께 실린다
    schedule(runner, "coalesce", COALESCE_MS, () => void runTurn(runner));
  };

  const schedulePatrol = (runner: Runner, at: number, reason: string) => {
    const bounded = Math.min(at, now() + PATROL_CEILING_MS);
    runner.nextWakeAt = bounded;
    schedule(runner, "patrol", bounded - now(), () => { runner.nextWakeAt = undefined; wake(runner, "patrol", reason ? { detail: reason } : {}); });
    publish(runner);
  };

  const scheduleRetry = (runner: Runner, code: string) => {
    const delay = RETRY_DELAYS_MS[runner.retryAttempt] ?? RETRY_STEADY_MS;
    runner.retryAttempt += 1;
    const at = now() + delay;
    runner.nextWakeAt = at;
    record(runner, { kind: "error", code, retryAt: at });
    setPhase(runner, runner.retryAttempt > RETRY_DELAYS_MS.length ? "error" : "retrying", code);
    schedule(runner, "retry", delay, () => { runner.nextWakeAt = undefined; void runTurn(runner); });
  };

  const openSession = async (runner: Runner, event: "opened" | "replaced" | "restarted"): Promise<CommodoreSession> => {
    const theater = deps.theater(runner.theaterId);
    if (!theater) throw new Error("theater_unavailable");
    const coordinates = resolveCoordinates(runner.theaterId);
    const session = createCommodoreSession({
      theaterId: runner.theaterId, theaterLabel: theater.label, theaterRoot: theater.root, agent: deps.agent, store: deps.store, coordinates,
      boardTools: deps.boardTools(runner.theaterId), now,
      onNextWake: (at, reason) => { runner.patrolSet = true; schedulePatrol(runner, at, reason); },
      ...(deps.execute ? { execute: deps.execute } : {}),
    });
    await session.start();
    runner.session = session;
    runner.coordinates = coordinates;
    runner.lastInputTokens = 0;
    deps.store.addRunTotals(runner.theaterId, { session: 1 });
    record(runner, { kind: "session", event });
    return session;
  };

  const runTurn = async (runner: Runner): Promise<void> => {
    if (runner.inflight) return runner.inflight;
    if (runner.stopping || disposed) return;
    if (!runner.pending.size) return;
    clearTimer(runner, "coalesce"); clearTimer(runner, "retry");
    runner.inflight = (async () => {
      let session = runner.session;
      let replacementSummary: readonly string[] | undefined;
      try {
        // 교대 — 좌표가 바뀌었거나 문맥이 길어졌거나 재시작 뒤다. 새 세션은 최근 행위 요약으로 연다.
        const rotate = runner.rotateNext ?? (session && needsRotation(runner) ? "replaced" : null);
        if (session && rotate) { await session.dispose(); session = null; runner.session = null; }
        if (!session) {
          const event = rotate ?? "opened";
          if (event !== "opened") { replacementSummary = runner.recentActions.slice(-RECENT_ACTIONS); wake(runner, event === "restarted" ? "restart" : "rotated"); }
          runner.rotateNext = null;
          session = await openSession(runner, event);
        }
      } catch (error) {
        scheduleRetry(runner, failureCode(error, "session_failed"));
        return;
      }
      // 이유는 세션이 열린 뒤에 거둔다 — 열지 못하면 그대로 남아 재시도 턴에 실린다.
      const pending = [...runner.pending.entries()];
      runner.pending.clear();
      const messages = runner.messages.splice(0);
      const reasons = pending.map(([code, reason]) => wakeToken(code, reason.count));
      const sentences = pending.map(([code, reason]) => wakeSentence(code, reason));
      setPhase(runner, "turn");
      runner.patrolSet = false;
      const outcome = await session.turn({ reasons, sentences, ...(replacementSummary ? { replacementSummary } : {}), ...(messages.length ? { messages } : {}) });
      noteOutcome(runner, outcome);
      if (runner.stopping) return;
      if (outcome.outcome === "error") {
        for (const [code, reason] of pending) if (!runner.pending.has(code)) runner.pending.set(code, reason);
        runner.messages.unshift(...messages);
        if (outcome.error === "session_disposed" || outcome.error === "session_failed") { runner.session = null; }
        scheduleRetry(runner, outcome.error ?? "turn_failed");
        return;
      }
      runner.retryAttempt = 0;
      setPhase(runner, "idle");
      if (!runner.patrolSet && !runner.patrol) schedulePatrol(runner, now() + PATROL_CEILING_MS, "");
    })().finally(() => {
      runner.inflight = null;
      // 턴 중에 온 이유는 다음 턴 하나로.
      if (runner.pending.size && !runner.stopping && !disposed && runner.phase !== "retrying" && runner.phase !== "error") schedule(runner, "coalesce", COALESCE_MS, () => void runTurn(runner));
    });
    return runner.inflight;
  };

  const noteOutcome = (runner: Runner, outcome: CommodoreTurnOutcome) => {
    if (outcome.usage) runner.lastInputTokens = outcome.usage.inputTokens;
    // 교대 요약의 재료 — 이 턴의 보드 행위 수와 결말만. 내용은 사령관이 도구로 다시 읽는다.
    const at = new Date(now()).toISOString();
    runner.recentActions.push(`${at}: ${outcome.outcome}${outcome.actions ? `, ${outcome.actions} board action${outcome.actions === 1 ? "" : "s"}` : ""}`);
    if (runner.recentActions.length > RECENT_ACTIONS * 2) runner.recentActions.splice(0, runner.recentActions.length - RECENT_ACTIONS);
  };

  const needsRotation = (runner: Runner) => {
    const coordinates = resolveCoordinates(runner.theaterId);
    if (!runner.coordinates || runner.coordinates.model !== coordinates.model || runner.coordinates.effort !== coordinates.effort) return true;
    return runner.lastInputTokens >= CONTEXT_ROTATE_RATIO * contextWindow(coordinates.model);
  };

  const start = (theaterId: string, reason: WakeCode) => {
    let runner = runners.get(theaterId);
    if (runner && !runner.stopping) return;
    runner = { theaterId, session: null, phase: "idle", pending: new Map(), messages: [], coalesce: null, patrol: null, retry: null, retryAttempt: 0, inflight: null, stopping: false, patrolSet: false, lastInputTokens: 0, coordinates: null, rotateNext: reason === "restart" ? "restarted" : null, recentActions: [], signature: signatureOf(deps.objectives(theaterId)), stalledSince: new Map(), stalledReported: new Set(), emptyReported: false };
    runners.set(theaterId, runner);
    setPhase(runner, "idle");
    wake(runner, reason);
    if (!deps.objectives(theaterId).some((objective) => !objective.done && !objective.removed)) { runner.emptyReported = true; wake(runner, "empty"); }
  };

  const stop = async (theaterId: string, reason: string) => {
    const runner = runners.get(theaterId);
    if (!runner) return;
    runner.stopping = true;
    runners.delete(theaterId);
    clearTimer(runner, "coalesce"); clearTimer(runner, "patrol"); clearTimer(runner, "retry");
    runner.pending.clear();
    runner.messages.length = 0;
    runner.nextWakeAt = undefined;
    runner.session?.cancel();
    setPhase(runner, "off", reason);
    const session = runner.session;
    runner.session = null;
    try { await runner.inflight; } catch { /* 턴 결말은 세션이 삼킨다 */ }
    record(runner, { kind: "session", event: "stopped", reason });
    await session?.dispose();
  };

  const sync = (reason: WakeCode = "autonomy") => {
    if (disposed) return;
    const wanted = new Set<string>();
    for (const theaterId of deps.store.autonomousTheaters()) if (shouldRun(theaterId)) wanted.add(theaterId);
    for (const theaterId of [...runners.keys()]) if (!wanted.has(theaterId)) void stop(theaterId, settings().commodore ? "autonomy off" : "experiment off");
    for (const theaterId of wanted) start(theaterId, reason);
  };

  // 지시·정보·메시지·좌표 — 저장소 사건이 깨움 이유다.
  cleanups.push(deps.store.subscribe((event) => {
    const runner = runners.get(event.theaterId);
    if (event.op === "state") {
      if (event.change === "autonomy") { sync(); return; }
      if (!runner) return;
      if (event.change === "directive") wake(runner, "directive", { detail: `rev ${event.state.directive.rev}` });
      else if (event.change === "intel") wake(runner, "intel", { bump: true });
      else if (event.change === "coordinates") { runner.rotateNext ??= "replaced"; }
      return;
    }
    if (event.op === "transcript" && event.entry.kind === "message" && runner) { runner.messages.push(event.entry.text); wake(runner, "message"); }
  }));

  // 보드 사건 — 대기 상태의 서명이 바뀔 때만, 무엇이 바뀌었는지 한 줄로.
  cleanups.push(deps.subscribeObjectives((event) => {
    const runner = runners.get(event.theaterId);
    if (!runner) return;
    const objectives = deps.objectives(event.theaterId);
    const signature = signatureOf(objectives);
    if (signature === runner.signature) return;
    runner.signature = signature;
    const digest = inboxDigest(objectives);
    if (digest.length) for (const [code, count] of digest) wake(runner, code, { count });
    else wake(runner, "board");
    const empty = !objectives.some((objective) => !objective.done && !objective.removed);
    if (empty && !runner.emptyReported) wake(runner, "empty");
    runner.emptyReported = empty;
  }));

  if (deps.subscribeExperiments) cleanups.push(deps.subscribeExperiments(() => sync("autonomy")));

  // 정체 — 임무가 남았는데 지휘관 세션이 오래 쉰다.
  const stallTimer = setInterval(() => {
    if (disposed || !deps.observe) return;
    for (const runner of runners.values()) {
      for (const objective of deps.objectives(runner.theaterId)) {
        const resting = objective.commenced && !objective.done && !objective.removed && !objective.awaitingReview && !objective.awaitingHandoff && !objective.decisionRequest && objective.missions.some((mission) => !mission.done);
        const observation = resting ? deps.observe(objective.id) : null;
        const idle = !!observation && (observation.lifecycle === "dormant" || observation.activity === "idle");
        if (!idle) { runner.stalledSince.delete(objective.id); runner.stalledReported.delete(objective.id); continue; }
        const since = runner.stalledSince.get(objective.id) ?? now();
        runner.stalledSince.set(objective.id, since);
        if (now() - since >= STALL_MS && !runner.stalledReported.has(objective.id)) { runner.stalledReported.add(objective.id); wake(runner, "stalled", { bump: true, detail: objective.title }); }
      }
    }
  }, STALL_CHECK_MS);
  stallTimer.unref?.();
  cleanups.push(() => clearInterval(stallTimer));

  return {
    status(theaterId) {
      const runner = runners.get(theaterId);
      if (!runner) return null;
      return { phase: runner.phase, ...(runner.reason ? { reason: runner.reason } : {}), ...(runner.nextWakeAt ? { nextWakeAt: runner.nextWakeAt } : {}) };
    },
    async retry(theaterId) {
      const runner = runners.get(theaterId);
      if (!runner || (runner.phase !== "retrying" && runner.phase !== "error")) throw new Error("commodore_not_retrying");
      clearTimer(runner, "retry");
      runner.nextWakeAt = undefined;
      wake(runner, "retry");
      clearTimer(runner, "coalesce");
      await runTurn(runner);
    },
    sync,
    async dispose() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      await Promise.all([...runners.keys()].map((theaterId) => stop(theaterId, "Console stopping")));
    },
  };

}

/** 보드의 대기 상태 서명 — 바뀔 때만 깨운다. 진행 중 세부(임무 완료 표시 등)는 포함하지 않는다. */
function signatureOf(objectives: readonly Objective[]): string {
  return objectives.filter((objective) => !objective.removed).map((objective) => [
    objective.id, objective.done ? "d" : objective.commenced ? "c" : "p", objective.awaitingReview ? "r" : "", objective.awaitingHandoff ? "h" : "", objective.decisionRequest ? `q${objective.decisionRequestRevision}` : "",
    objective.criteriaProposals.length, objective.followups.filter((followup) => followup.state === "open").length, objective.followupBatches.flatMap((batch) => batch.items).filter((item) => item.state === "failed").length,
  ].join(":")).sort().join("|");
}

/** 사람 전용으로 남은 대기 상태의 수 — 지금 그 상태인 목표 수(절대값). 없으면 빈 목록이다. */
function inboxDigest(objectives: readonly Objective[]): readonly [WakeCode, number][] {
  const live = objectives.filter((objective) => !objective.removed && !objective.done);
  const counts: [WakeCode, number][] = [
    ["decision", live.filter((objective) => objective.decisionRequest).length],
    ["criteria", live.filter((objective) => objective.criteriaProposals.length).length],
    ["review", live.filter((objective) => objective.awaitingReview).length],
    ["followup", live.filter((objective) => objective.followups.some((followup) => followup.state === "open")).length],
    ["followup-failed", live.filter((objective) => objective.followupBatches.some((batch) => batch.items.some((item) => item.state === "failed"))).length],
    ["pending", live.filter((objective) => !objective.commenced).length],
  ];
  return counts.filter(([, count]) => count > 0);
}

/** 모델 문맥 — `[1m]` 별칭은 1M, 그 밖은 200k 로 본다(교대 판단에만 쓴다). */
function contextWindow(model: string): number {
  return /\[1m\]/i.test(model) ? 1_000_000 : 200_000;
}

function failureCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/gateway_unavailable|agent_host_disposed/.test(message)) return "session_failed";
  if (/model/i.test(message)) return "model_unavailable";
  return /^[a-z_]{1,64}$/.test(message) ? message : fallback;
}
