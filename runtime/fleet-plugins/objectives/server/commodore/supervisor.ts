import type { AgentHost } from "@fleet-console/sdk/agent";
import type { ConsoleOperationObservation, PluginMcpTool } from "@fleet-console/sdk/mcp";
import { canonicalModelId, isAgentEffort } from "@fleet-console/sdk/models";
import type { FleetPluginModelsHost } from "@fleet-console/sdk/plugin";
import { DEFAULT_EXPERIMENT_SETTINGS, experimentAideSelection, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

import { createdByCommodore, inboxReasons, objectiveOperator, objectiveStatus, STALL_MS, stalledObjectives, type ObjectiveOperator, type ObjectiveStatus } from "../board-state.js";
import type { Objective, ObjectiveEvent } from "../types.js";
import { createCommodoreSession, type CommodoreSession, type CommodoreSessionCoordinates, type CommodoreTurnOutcome } from "./session.js";
import type { CommodoreStore } from "./store.js";
import type { CommandExecute } from "./tools.js";
import { COMMODORE_CONTEXT_ROTATE_RATIO, DEFAULT_PATROL_MINUTES, EMPTY_RUN_TOTALS, MAX_TRANSCRIPT_PAGE, patrolIntervalMs, type CommodoreEvent, type CommodoreRunStatus } from "./types.js";

/**
 * 감독자 — Theater 마다 하나. 사령관 세션은 턴이 끝나면 쉬고, 끝없이 도는 것은 이 감독자가 보장한다.
 *
 * 깨울 이유(보드 사건·지시·정보·사람의 메시지·정체·순찰·빈 보드·재시작)를 모아 몇 초 뒤 한 턴으로 보내고, 턴 중에 온 이유는
 * 다음 턴 하나로 합친다. 순찰은 사령관이 `next_wake` 로 예약하되 사람이 고른 순찰 간격(기본 60분)을 넘지 않고, 턴 오류는 1·5·15분 뒤 재시도한 뒤 60분
 * 간격으로 계속한다(자율 운영은 꺼지지 않는다). 문맥이 길어지면 다음 깨움에서 세션을 교대하고(새 세션 + 최근 행위 요약),
 * 플러그인 등록 때 켜진 Theater 를 복원한다. 자율 운영·실험 기능 끔은 바로 멈추고, 종료 예정 시각에는 알림 턴 하나 뒤 멈춘다.
 *
 * 순찰 간격만 사람의 노브다(서랍). 재시도 간격·모으는 시간·교대 비율은 감독자 내부 값이다.
 */

/** 저장값이 없을 때의 순찰 간격. */
export const DEFAULT_PATROL_MS = DEFAULT_PATROL_MINUTES * 60_000;
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
export const RETRY_STEADY_MS = 60 * 60_000;
/** 깨움 이유를 모으는 시간. */
export const COALESCE_MS = 3_000;
/** 정체 기준은 보드와 같다(`board-state.ts`) — inbox 보기와 감독자가 같은 목표를 정체라 부른다. */
export { STALL_MS };
export const STALL_CHECK_MS = 5 * 60_000;
const RECENT_ACTIONS = 12;

export interface CommodoreSupervisorDeps {
  readonly store: CommodoreStore;
  readonly agent: AgentHost;
  readonly experiments: () => ConsoleExperimentSettings;
  readonly subscribeExperiments?: (listener: () => void) => () => void;
  /**
   * Console의 모델 로스터 해석 — 저장 좌표를 Agent SDK wire id로 풀고, Gateway에서 끈 모델은 저장값을 고쳐 쓰지 않은 채
   * 폴백 좌표로 연다. 없는 호스트에서는 저장 좌표를 그대로 쓴다.
   */
  readonly models?: Pick<FleetPluginModelsHost, "resolve">;
  /** Theater 의 이름과 루트 실경로 — 모르면 null(잊힌·떨어진 Theater). */
  readonly theater: (theaterId: string) => { readonly label: string; readonly root: string } | null;
  readonly objectives: (theaterId: string) => readonly Objective[];
  /** 사람이 이 Theater 를 보는 언어 — 저장된 사령관 언어, 없으면 목표가 남긴 언어, 그것도 없으면 영어. */
  readonly language?: (theaterId: string) => "en" | "ko";
  readonly subscribeObjectives: (listener: (event: ObjectiveEvent) => void) => () => void;
  /** 이 Theater 에 묶인 보드 도구 — 없으면 사령관은 보드 없이 선다. */
  readonly boardTools: (theaterId: string) => readonly PluginMcpTool[];
  readonly observe?: (operationId: string) => ConsoleOperationObservation | null;
  readonly emit: (event: CommodoreEvent) => void;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
}

/** 한 턴을 여는 실행 좌표. `model`은 Agent SDK wire id다. */
interface RunCoordinates extends CommodoreSessionCoordinates {
  readonly contextWindow: number;
  /** 로스터 폴백으로 섰으면 실행 기록에 남길 사유(`fallback:<reason>:<model>`). */
  readonly fallback?: string;
}

export interface CommodoreSupervisor {
  /** 지금 상태 — 감독자가 모르는 Theater(돌지 않는)는 null. */
  status(theaterId: string): Omit<CommodoreRunStatus, "totals"> | null;
  /** 재시도 대기를 지금 깨운다. 그 상태가 아니면 `commodore_not_retrying`. */
  retry(theaterId: string): Promise<void>;
  /** 진행 턴·대기 메시지를 거두고 요약 없이 새 문맥으로 시작한다. 기록 파일도 지운다. */
  clear(theaterId: string): Promise<void>;
  /** 실험 기능·자율 운영을 다시 읽어 돌아야 할 Theater 를 세우고 아닌 것을 멈춘다. */
  sync(reason?: string): void;
  dispose(): Promise<void>;
}

type Phase = CommodoreRunStatus["phase"];

/**
 * 깨움 이유 코드 — 기록에는 `code` 또는 `code:N` 토큰으로 남고(화면이 로케일로 옮긴다), 모델에게는 영어 문장으로 간다.
 * 수가 붙는 코드는 절대값(지금 그 상태인 목표 수)이고, intel 만 누적이다.
 */
export type WakeCode = "patrol" | "directive" | "intel" | "message" | "status" | "decision" | "review" | "criteria" | "pending" | "planned" | "followup" | "followup-failed" | "member-failed" | "stalled" | "empty" | "restart" | "autonomy" | "retry" | "rotated";

/** 사령관 자신의 보드 쓰기가 끝난 뒤에도 그 목표의 상태 변화를 제 것으로 보는 시간 — 기동처럼 쓰기 뒤에 이어지는 사건까지. */
const SELF_WRITE_GRACE_MS = 5_000;
/** 깨움 문장에 싣는 상태 변화 줄 수 — 나머지는 수로만. 내용은 사령관이 보드에서 읽는다. */
const STATUS_DETAILS = 8;
const STATUS_WORDS: Record<ObjectiveStatus | "new", string> = {
  new: "new", pending: "not started", planning: "planning", planned: "lineup ready", running: "in progress",
  "missions-done": "missions done, awaiting hand-off", review: "awaiting review", done: "done", removed: "removed",
};

interface PendingReason {
  count?: number;
  readonly details: string[];
  /** 이 이유를 낸 목표(상태·정체)와 그 목표가 보탠 상세 — 범위 줄과, 돌려받은 목표의 사유를 걷는 데 쓴다. 보드 대기 코드는 턴 직전 보드에서 다시 찾는다. */
  ids?: Map<string, string[]>;
}

/** 감독자가 아는 목표 한 자리 — 상태와 운영 주체. 운영 주체가 사람에서 사령관으로 바뀌면 「맡겨짐」으로 깨운다. */
interface TrackedStatus {
  readonly status: ObjectiveStatus;
  readonly operator: ObjectiveOperator;
}

/** 사람이 운영하는 목표의 대기 키 머리 — 깨우지 않고 기록에만 남긴다. */
const HUMAN_KEY = "human";

/** 보드 대기 상태의 코드 — 수는 턴 직전의 보드에서 다시 센다. */
const BOARD_CODES: ReadonlySet<WakeCode> = new Set<WakeCode>(["decision", "criteria", "review", "followup", "followup-failed", "member-failed", "pending", "planned"]);

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
    case "status": {
      const shown = reason.details.slice(-STATUS_DETAILS);
      const more = reason.details.length - shown.length;
      return `${plural("objective status change")}: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
    }
    case "decision": return `inbox: ${plural("decision request")}`;
    case "review": return `inbox: ${n} awaiting review`;
    case "criteria": return `inbox: ${plural("criteria proposal")}`;
    case "pending": return `inbox: ${plural("objective")} not commenced`;
    case "planned": return `inbox: ${plural("objective")} ${n === 1 ? "has" : "have"} a lineup ready to commence`;
    case "followup": return `inbox: ${plural("open follow-up candidate")}`;
    case "followup-failed": return `inbox: ${plural("failed or unconfirmed follow-up creation")}`;
    case "member-failed": return `inbox: ${plural("objective with a failed member turn")}`;
    case "stalled": return `${plural("stalled objective")}${tail}`;
    case "empty": return "the board has no open objective you operate";
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
  /** 사람의 메시지 — 다음 턴에 그대로 실린다. seq 는 기록의 그 줄이다(끌 때 싣지 못한 것을 「전달되지 않음」으로 가리킨다). */
  messages: { readonly seq: number; readonly text: string }[];
  coalesce: ReturnType<typeof setTimeout> | null;
  patrol: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  inflight: Promise<void> | null;
  stopping: boolean;
  /** 예약 종료 알림 중 — 일반 깨움과 보드 쓰기는 더 받지 않는다. */
  ending: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** 턴 중에 사령관이 순찰을 예약했다. */
  patrolSet: boolean;
  /** 사령관이 `next_wake` 로 고른 시각과 이유 — 순찰 간격이 바뀌면 이 시각을 새 간격에 다시 맞춘다. 기본 순찰이면 null. */
  patrolRequest: { readonly at: number; readonly reason: string } | null;
  /** 마지막 턴이 끝난 시각 — 기본 순찰은 여기서 한 간격 뒤다. */
  lastTurnAt: number;
  lastInputTokens: number;
  /** 지금 세션의 모델 창. 마지막 입력 토큰과 짝이다. */
  contextWindow: number;
  coordinates: CommodoreSessionCoordinates | null;
  language: "en" | "ko";
  rotateNext: "replaced" | "restarted" | null;
  recentActions: string[];
  /** 사령관이 이미 들은 대기 상태 — `code:objectiveId[:rev]`. 새 항목이 생길 때만 깨우고, 줄어드는 것은 조용히 잊는다. */
  seen: Set<string>;
  stalledReported: Set<string>;
  emptyReported: boolean;
  /** 사령관이 아는 목표 상태와 운영 주체 — 사령관이 운영하는 목표의 상태가 바뀌거나 사람이 맡기면 깨운다. */
  statuses: Map<string, TrackedStatus>;
  /** 사령관 자신이 쓰는 중(또는 막 쓴) 목표 — 그 상태 변화는 깨울 일이 아니다. 값은 유효 시각(쓰는 중이면 Infinity). */
  selfWrites: Map<string, number>;
}

export function createCommodoreSupervisor(deps: CommodoreSupervisorDeps): CommodoreSupervisor {
  const now = deps.now ?? Date.now;
  const runners = new Map<string, Runner>();
  const clears = new Map<string, Promise<void>>();
  const stops = new Map<string, Promise<void>>();
  const cleanups: (() => void)[] = [];
  let disposed = false;

  const settings = () => { try { return deps.experiments(); } catch { return DEFAULT_EXPERIMENT_SETTINGS; } };
  const shouldRun = (theaterId: string) => settings().commodore && deps.store.read(theaterId)?.autonomy === true && deps.theater(theaterId) !== null;
  const resolveLanguage = (theaterId: string): "en" | "ko" => deps.store.read(theaterId)?.language ?? deps.language?.(theaterId) ?? "en";
  /** 실행 좌표 — Theater 좌표, 없으면 고정 기본값(Opus/High)을 로스터(`agent` 대상)에 대조한다. 턴마다 다시 푼다. */
  const resolveCoordinates = (theaterId: string): RunCoordinates => {
    const state = deps.store.read(theaterId);
    const stored = state?.model && state.effort ? { model: state.model, effort: state.effort } : experimentAideSelection(settings(), "commodore");
    if (!deps.models) return { model: stored.model, effort: stored.effort, contextWindow: contextWindow(stored.model) };
    const resolved = deps.models.resolve(stored, "agent");
    return {
      model: resolved.wireModel,
      ...(isAgentEffort(resolved.effort) ? { effort: resolved.effort } : {}),
      contextWindow: resolved.row?.contextWindow ?? contextWindow(resolved.model),
      // 실행 기록에는 사유와 실제로 도는 모델 id만 남긴다.
      ...(resolved.fallback ? { fallback: `fallback:${resolved.reason ?? "model_off"}:${resolved.model}` } : {}),
    };
  };

  const statusOf = (runner: Runner): Omit<CommodoreRunStatus, "totals"> => ({ phase: runner.phase, ...(runner.reason ? { reason: runner.reason } : {}), ...(runner.nextWakeAt ? { nextWakeAt: runner.nextWakeAt } : {}), ...(runner.stalledReported.size ? { stalled: [...runner.stalledReported] } : {}), ...(runner.contextWindow > 0 && runner.lastInputTokens > 0 ? { context: { window: runner.contextWindow, inputTokens: runner.lastInputTokens } } : {}) });
  const publish = (runner: Runner) => {
    const totals = deps.store.read(runner.theaterId)?.run ?? EMPTY_RUN_TOTALS;
    deps.emit({ op: "run", theaterId: runner.theaterId, run: { ...statusOf(runner), totals } });
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
  const clearTimer = (runner: Runner, key: "coalesce" | "patrol" | "retry" | "stopTimer") => {
    const timer = runner[key];
    if (timer) clearTimeout(timer);
    runner[key] = null;
  };
  const schedule = (runner: Runner, key: "coalesce" | "patrol" | "retry" | "stopTimer", delayMs: number, run: () => void) => {
    clearTimer(runner, key);
    const timer = setTimeout(() => { runner[key] = null; if (!runner.stopping && !disposed) run(); }, Math.max(0, delayMs));
    timer.unref?.();
    runner[key] = timer;
  };

  /** 이유를 모은다 — 턴이 돌고 있으면 끝난 뒤, 아니면 잠깐 뒤 한 턴. 수는 절대값이 덮고 `bump` 는 누적한다. */
  const wake = (runner: Runner, code: WakeCode, input: { readonly count?: number; readonly bump?: boolean; readonly detail?: string } = {}) => {
    if (runner.stopping || runner.ending) return;
    if (deadlineReached(runner)) { endScheduled(runner); return; }
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

  const patrolInterval = (theaterId: string) => patrolIntervalMs(deps.store.read(theaterId));
  const schedulePatrol = (runner: Runner, at: number, reason: string) => {
    if (runner.stopping || runner.ending) return;
    const bounded = Math.max(now(), Math.min(at, now() + patrolInterval(runner.theaterId)));
    runner.nextWakeAt = bounded;
    schedule(runner, "patrol", bounded - now(), () => { runner.nextWakeAt = undefined; runner.patrolRequest = null; wake(runner, "patrol", reason ? { detail: reason } : {}); });
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
    const language = resolveLanguage(runner.theaterId);
    const session = createCommodoreSession({
      theaterId: runner.theaterId, theaterLabel: theater.label, language, theaterRoot: theater.root, agent: deps.agent, store: deps.store, coordinates: { model: coordinates.model, ...(coordinates.effort ? { effort: coordinates.effort } : {}) },
      boardTools: deps.boardTools(runner.theaterId).map((tool) => selfAttributed(runner, tool)), now,
      onNextWake: (at, reason) => { runner.patrolSet = true; runner.patrolRequest = { at, reason }; schedulePatrol(runner, at, reason); },
      onLive: (live) => deps.emit({ op: "live", theaterId: runner.theaterId, live }),
      ...(deps.execute ? { execute: deps.execute } : {}),
    });
    await session.start();
    runner.session = session;
    runner.coordinates = coordinates;
    runner.language = language;
    runner.contextWindow = coordinates.contextWindow;
    runner.lastInputTokens = 0;
    deps.store.addRunTotals(runner.theaterId, { session: 1 });
    record(runner, { kind: "session", event, ...(coordinates.fallback ? { reason: coordinates.fallback } : {}) });
    if (coordinates.fallback) console.warn(`[objectives] commodore ${coordinates.fallback}`);
    return session;
  };

  const deadlineReached = (runner: Runner) => {
    const at = deps.store.read(runner.theaterId)?.stopAt;
    return at !== undefined && at <= now();
  };

  /** 종료는 일반 턴과 분리한다. 취소된 턴을 거둔 뒤 한 번만 알리고, 실패해도 순찰로 돌아가지 않는다. */
  const endScheduled = (runner: Runner) => {
    if (runner.ending || runner.stopping || disposed) return;
    runner.ending = true;
    clearTimer(runner, "stopTimer"); clearTimer(runner, "coalesce"); clearTimer(runner, "patrol"); clearTimer(runner, "retry");
    runner.pending.clear();
    runner.nextWakeAt = undefined;
    runner.session?.cancel();
    setPhase(runner, "turn", "scheduled_stop");
    const previous = runner.inflight;
    runner.inflight = (async () => {
      try {
        await previous;
        if (runner.stopping || disposed) return;
        // 메시지는 종료 알림에 섞지 않는다 — 아직 전달되지 않은 일은 사람에게 돌려준다.
        const undelivered = runner.messages.splice(0).map((message) => message.seq);
        for (let index = 0; index < undelivered.length; index += MAX_TRANSCRIPT_PAGE) record(runner, { kind: "undelivered", seqs: undelivered.slice(index, index + MAX_TRANSCRIPT_PAGE) });
        const session = runner.session ?? await openSession(runner, "restarted");
        if (runner.stopping || disposed) return;
        // 종료 알림도 무기한 운영으로 바뀌어서는 안 된다. SDK 취소 경로로 제한한다.
        const timeout = setTimeout(() => session.cancel(), 30_000);
        timeout.unref?.();
        try {
          const outcome = await session.turn({ reasons: ["scheduled-stop"], sentences: ["The scheduled end time has arrived. Autonomous operation is now ending. Do not patrol, schedule another wake, or change the board. Acknowledge the stop briefly; pending work returns to the person."] });
          noteOutcome(runner, outcome);
        } finally { clearTimeout(timeout); }
      } catch (error) {
        record(runner, { kind: "error", code: failureCode(error, "session_failed") });
      } finally {
        // Console 종료 중이면 예약을 남겨 재시작에서 처리한다. 사람이 이미 끈 새 상태는 건드리지 않는다.
        if (!runner.stopping && !disposed) deps.store.setAutonomy(runner.theaterId, false);
      }
    })().catch((error) => {
      console.warn(`[objectives] commodore scheduled stop failed: ${error instanceof Error ? error.message : String(error)}`);
      void stop(runner.theaterId, "scheduled stop failed");
    }).finally(() => { runner.inflight = null; });
  };

  const scheduleStop = (runner: Runner) => {
    clearTimer(runner, "stopTimer");
    if (runner.stopping || runner.ending) return;
    const at = deps.store.read(runner.theaterId)?.stopAt;
    if (at === undefined) return;
    if (at <= now()) { endScheduled(runner); return; }
    // Node 타이머 상한을 넘는 날짜도 일찍 실행하지 않고, 남은 기간을 다시 예약한다.
    schedule(runner, "stopTimer", Math.min(at - now(), 2_147_483_647), () => scheduleStop(runner));
  };

  const runTurn = async (runner: Runner): Promise<void> => {
    if (runner.stopping || runner.ending || disposed) return;
    if (deadlineReached(runner)) { endScheduled(runner); return; }
    if (runner.inflight) return runner.inflight;
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
        if (runner.stopping || runner.ending) return;
        scheduleRetry(runner, failureCode(error, "session_failed"));
        return;
      }
      // 여는 동안 꺼졌다 — 막 연 세션은 stop() 이 거둔다. 턴도 상태 방송도 하지 않는다.
      if (runner.stopping || runner.ending) return;
      if (deadlineReached(runner)) { endScheduled(runner); return; }
      // 이유는 세션이 열린 뒤에 거둔다 — 열지 못하면 그대로 남아 재시도 턴에 실린다. 보드 대기 상태의 수는 지금 보드에서 다시 센다
      // (모인 동안 사령관 자신이 완료한 목표는 빠진다); 그새 사라진 대기 상태는 이유에서 내린다.
      const digest = new Map(inboxDigest(deps.objectives(runner.theaterId)));
      const pending = [...runner.pending.entries()].flatMap(([code, reason]): [WakeCode, PendingReason][] => {
        if (!BOARD_CODES.has(code)) return [[code, reason]];
        const count = digest.get(code) ?? 0;
        return count ? [[code, { ...reason, count }]] : [];
      });
      runner.pending.clear();
      if (!pending.length) { setPhase(runner, "idle"); return; }
      const messages = runner.messages.splice(0);
      const reasons = pending.map(([code, reason]) => wakeToken(code, reason.count));
      const sentences = pending.map(([code, reason]) => wakeSentence(code, reason));
      const scope = scopeOf(runner, pending);
      setPhase(runner, "turn");
      runner.patrolSet = false;
      const outcome = await session.turn({ reasons, sentences, ...(scope ? { scope } : {}), ...(replacementSummary ? { replacementSummary } : {}), ...(messages.length ? { messages: messages.map((message) => message.text) } : {}) });
      noteOutcome(runner, outcome);
      if (runner.stopping || runner.ending) {
        // 끄기로 끝나지 못한 턴의 메시지도 stop()이 표시한다. 성공한 턴은 이미 전달됐으므로 제외한다.
        // 이 runner는 이미 제거됐고 다시 깨우지 않는다 — 재전달·재시도용으로 돌려놓는 것이 아니다.
        if (outcome.outcome !== "ok") runner.messages.unshift(...messages);
        return;
      }
      if (outcome.outcome === "error") {
        for (const [code, reason] of pending) if (!runner.pending.has(code)) runner.pending.set(code, reason);
        runner.messages.unshift(...messages);
        if (outcome.error === "session_disposed" || outcome.error === "session_failed") { runner.session = null; }
        scheduleRetry(runner, outcome.error ?? "turn_failed");
        return;
      }
      runner.retryAttempt = 0;
      runner.lastTurnAt = now();
      setPhase(runner, "idle");
      // 이번 턴이 순찰을 예약하지 않았으면 기본 순찰은 이 턴 끝에서 한 간격 뒤다 — 앞 턴의 타이머를 남기지 않는다.
      if (!runner.patrolSet) { runner.patrolRequest = null; schedulePatrol(runner, now() + patrolInterval(runner.theaterId), ""); }
    })().finally(() => {
      // 종료 알림이 이 턴을 기다리는 중이면 그 promise를 덮지 않는다.
      if (runner.ending) return;
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
    if (!runner.coordinates || runner.coordinates.model !== coordinates.model || runner.coordinates.effort !== coordinates.effort || runner.language !== resolveLanguage(runner.theaterId)) return true;
    return runner.lastInputTokens >= COMMODORE_CONTEXT_ROTATE_RATIO * coordinates.contextWindow;
  };

  const start = (theaterId: string, reason: WakeCode, wakeImmediately = true) => {
    if (disposed || clears.has(theaterId)) return;
    let runner = runners.get(theaterId);
    if (runner && !runner.stopping) return;
    runner = { theaterId, session: null, phase: "idle", pending: new Map(), messages: [], coalesce: null, patrol: null, retry: null, retryAttempt: 0, inflight: null, stopping: false, ending: false, stopTimer: null, patrolSet: false, patrolRequest: null, lastTurnAt: now(), lastInputTokens: 0, contextWindow: 0, coordinates: null, language: "en", rotateNext: reason === "restart" ? "restarted" : null, recentActions: [], seen: waitingKeys(deps.objectives(theaterId)), stalledReported: new Set(), emptyReported: false, statuses: statusMap(deps.objectives(theaterId)), selfWrites: new Map() };
    runners.set(theaterId, runner);
    setPhase(runner, "idle");
    scheduleStop(runner);
    // Clear 직후는 빈 기록을 유지한다. 다음 메시지·사건·순찰에서 새 세션을 연다.
    if (!wakeImmediately) { schedulePatrol(runner, now() + patrolInterval(theaterId), ""); return; }
    wake(runner, reason);
    if (!hasOpenOperated(deps.objectives(theaterId))) { runner.emptyReported = true; wake(runner, "empty"); }
  };

  const stop = (theaterId: string, reason: string): Promise<void> => {
    const previous = stops.get(theaterId);
    const runner = runners.get(theaterId);
    if (!runner) return previous ?? Promise.resolve();
    runner.stopping = true;
    runners.delete(theaterId);
    clearTimer(runner, "stopTimer");
    clearTimer(runner, "coalesce"); clearTimer(runner, "patrol"); clearTimer(runner, "retry");
    runner.pending.clear();
    // 모으는 중·재시도 대기뿐 아니라 취소된 진행 중 턴도, 결말을 기다린 뒤 아래에서 함께 표시한다.
    // 새 사령관은 지난 메시지를 읽지 않는다 — 다시 보내지는 않는다.
    runner.nextWakeAt = undefined;
    runner.session?.cancel();
    setPhase(runner, "off", reason);
    const session = runner.session;
    runner.session = null;
    const work = (async () => {
      // runner를 목록에서 내린 뒤에도 마지막 기록·폐기가 끝날 때까지 Clear가 합류할 수 있게 남긴다.
      await previous;
      try { await runner.inflight; } catch { /* 턴 결말은 세션이 삼킨다 */ }
      const opened = runner.session as CommodoreSession | null;
      runner.session = null;
      const undelivered = runner.messages.splice(0).map((message) => message.seq);
      for (let index = 0; index < undelivered.length; index += MAX_TRANSCRIPT_PAGE) record(runner, { kind: "undelivered", seqs: undelivered.slice(index, index + MAX_TRANSCRIPT_PAGE) });
      record(runner, { kind: "session", event: "stopped", reason });
      await session?.dispose();
      if (opened && opened !== session) await opened.dispose();
    })().finally(() => { if (stops.get(theaterId) === work) stops.delete(theaterId); });
    stops.set(theaterId, work);
    return work;
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
      if (event.change === "stopAt") { scheduleStop(runner); return; }
      if (event.change === "directive") wake(runner, "directive", { detail: `rev ${event.state.directive.rev}` });
      else if (event.change === "intel") wake(runner, "intel", { bump: true });
      else if (event.change === "coordinates") { runner.rotateNext ??= "replaced"; }
      else if (event.change === "patrol" && runner.patrol) {
        // 잡혀 있는 순찰을 새 간격에 다시 맞춘다 — 사령관이 고른 시각은 그대로 두되 새 간격을 넘지 않게, 기본 순찰은 마지막 턴에서 한 간격 뒤로.
        const request = runner.patrolRequest;
        schedulePatrol(runner, request ? request.at : runner.lastTurnAt + patrolInterval(runner.theaterId), request?.reason ?? "");
      }
      return;
    }
    if (event.op === "transcript" && event.entry.kind === "message" && runner) { runner.messages.push({ seq: event.entry.seq, text: event.entry.text }); wake(runner, "message"); }
  }));

  /** 사람이 운영하는 목표에 나서 깨우지 않은 사건 — 다음 턴의 범위 줄에 한 번 실리고 비워진다. */
  const held = new WeakMap<Runner, Map<string, Set<string>>>();
  const hold = (runner: Runner, objectiveId: string, code: string) => {
    let byObjective = held.get(runner);
    if (!byObjective) held.set(runner, byObjective = new Map());
    let codes = byObjective.get(objectiveId);
    if (!codes) byObjective.set(objectiveId, codes = new Set());
    codes.add(code);
  };
  const noteIds = (runner: Runner, code: WakeCode, id: string, detail: string) => {
    const reason = runner.pending.get(code);
    if (!reason) return;
    const ids = (reason.ids ??= new Map());
    ids.set(id, [...(ids.get(id) ?? []), detail]);
  };
  /** 사람이 돌려받은 목표 — 아직 턴에 실리지 않은 그 목표의 상태 사유(맡김 포함)를 걷는다. 남은 것이 없으면 사유째 내린다. */
  const forgetStatus = (runner: Runner, objectiveId: string) => {
    const reason = runner.pending.get("status");
    const mine = reason?.ids?.get(objectiveId);
    if (!reason || !mine) return;
    reason.ids!.delete(objectiveId);
    const others = new Set([...reason.ids!.values()].flat());
    for (const text of new Set(mine)) { const at = reason.details.indexOf(text); if (at >= 0 && !others.has(text)) reason.details.splice(at, 1); }
    reason.count = (reason.count ?? 0) - mine.length;
    if (reason.count <= 0 || !reason.details.length) runner.pending.delete("status");
  };

  /** 이번 턴의 보드 범위(기록 전용) — 보드 대기 코드는 지금 그 이유를 가진 운영 목표, 상태·정체는 모인 목표, 그리고 held. */
  const scopeOf = (runner: Runner, pending: readonly (readonly [WakeCode, PendingReason])[]) => {
    const objectives = deps.objectives(runner.theaterId);
    const operators = operatorsOf(objectives);
    const woke = new Map<string, Set<string>>();
    const add = (id: string, code: string) => { let codes = woke.get(id); if (!codes) woke.set(id, codes = new Set()); codes.add(code); };
    for (const [code, reason] of pending) {
      if (BOARD_CODES.has(code)) { for (const objective of objectives) if (operators.get(objective.id) === "commodore" && (inboxReasons(objective) as readonly string[]).includes(code)) add(objective.id, code); }
      else for (const id of reason.ids?.keys() ?? []) add(id, code);
    }
    const quiet = held.get(runner);
    held.delete(runner);
    if (!woke.size && !quiet?.size) return null;
    // 보드에서 사라진 목표는 사령관이 운영하던 것만 상태 변화로 실린다.
    return {
      woke: [...woke].map(([id, codes]) => ({ id, operator: operators.get(id) ?? "commodore", codes: [...codes] })),
      held: [...(quiet ?? [])].map(([id, codes]) => ({ id, operator: "human" as const, codes: [...codes] })),
    };
  };

  // 보드 사건 — 사령관이 운영하는 목표에 아직 듣지 못한 대기 상태가 생길 때만 깨운다. 사령관 자신의 개시·완료로 대기가 줄어드는
  // 것은 깨울 일이 아니다(빈 inbox 를 읽으러 깨어나는 비용). 줄어든 항목은 조용히 잊어 같은 상태가 돌아오면 다시 깨운다.
  // 사람이 운영하는 목표의 사건은 깨우지 않고 다음 턴의 범위 줄(held)에만 남는다 — 조회에는 그대로 보인다.
  cleanups.push(deps.subscribeObjectives((event) => {
    const runner = runners.get(event.theaterId);
    if (!runner) return;
    const objectives = deps.objectives(event.theaterId);
    const current = waitingKeys(objectives);
    const fresh = [...current].filter((key) => !runner.seen.has(key));
    runner.seen = current;
    const freshCodes = new Set<WakeCode>();
    for (const key of fresh) {
      const [head, ...rest] = key.split(":");
      if (head === HUMAN_KEY) hold(runner, rest[1]!, rest[0]!);
      else freshCodes.add(head as WakeCode);
    }
    if (freshCodes.size) {
      const digest = new Map(inboxDigest(objectives));
      for (const code of freshCodes) wake(runner, code, { count: digest.get(code) ?? 1 });
    }
    const empty = !hasOpenOperated(objectives);
    if (empty && !runner.emptyReported) wake(runner, "empty");
    runner.emptyReported = empty;
    // 상태 변화 — 사령관이 운영하는 목표가 한 단계 옮겨 갈 때마다(새 목표·지워짐·사람이 맡김 포함). 사령관 자신의 쓰기와 그 쓰기로
    // 생긴 목표는 뺀다.
    for (const change of statusChanges(runner, objectives)) { wake(runner, "status", { bump: true, detail: change.text }); noteIds(runner, "status", change.id, change.text); }
  }));

  /** 보드 도구를 감싸 사령관이 쓰는 목표를 표시한다 — 쓰는 동안과 끝난 뒤 잠깐, 그 목표의 상태 변화는 사령관 자신의 것이다. */
  const selfAttributed = (runner: Runner, tool: PluginMcpTool): PluginMcpTool => ({
    ...tool,
    execute: async (args, context) => {
      // 종료 알림은 보드를 변경하는 마지막 기회가 아니다. 이미 실행 중인 쓰기를 되돌리지는 않는다.
      if (runner.stopping || runner.ending || deadlineReached(runner)) return { content: [{ type: "text", text: JSON.stringify({ error: "commodore_stopping" }) }], isError: true };
      const targets = writeTargets(args);
      for (const id of targets) runner.selfWrites.set(id, Number.POSITIVE_INFINITY);
      try { return await tool.execute(args, context); }
      finally { const until = now() + SELF_WRITE_GRACE_MS; for (const id of targets) runner.selfWrites.set(id, until); }
    },
  });

  const statusChanges = (runner: Runner, objectives: readonly Objective[]): { readonly id: string; readonly text: string }[] => {
    const at = now();
    for (const [id, until] of runner.selfWrites) if (until < at) runner.selfWrites.delete(id);
    const tracked = statusMap(objectives);
    const byId = new Map(objectives.map((objective) => [objective.id, objective]));
    const changes: { id: string; text: string }[] = [];
    for (const objective of objectives) {
      const next = tracked.get(objective.id)!;
      const previous = runner.statuses.get(objective.id);
      if (previous?.status === next.status && previous.operator === next.operator) continue;
      runner.statuses.set(objective.id, next);
      // 사람이 맡김 — 사령관은 운영값을 바꿀 수 없으므로 이 전환은 늘 사람의 것이다. 사령관의 쓰기 유예 안이어도 한 번 깨운다.
      if (previous?.operator === "human" && next.operator === "commodore") { changes.push({ id: objective.id, text: `"${objective.title}" handed to you by the person (${STATUS_WORDS[next.status]})` }); continue; }
      // 사람이 돌려받음 — 깨우지 않고, 모으는 동안 쌓인 이 목표의 상태 사유(방금 맡김 포함)도 걷는다.
      if (previous?.operator === "commodore" && next.operator === "human") { forgetStatus(runner, objective.id); continue; }
      if (runner.selfWrites.has(objective.id)) continue;
      // 사람이 운영하는 목표는 깨우지 않고 기록에만 남긴다.
      if (next.operator === "human") { hold(runner, objective.id, "status"); continue; }
      if (previous === undefined && createdByCommodore(objective, (id) => byId.get(id))) continue;
      changes.push({ id: objective.id, text: `"${objective.title}" ${STATUS_WORDS[previous?.status ?? "new"]} → ${STATUS_WORDS[next.status]}` });
    }
    // 보드에서 영영 사라진 목표(영구 삭제)도 지워짐이다.
    for (const [id, previous] of [...runner.statuses]) {
      if (byId.has(id)) continue;
      runner.statuses.delete(id);
      if (previous.status === "removed" || runner.selfWrites.has(id)) continue;
      if (previous.operator === "human") hold(runner, id, "status");
      else changes.push({ id, text: `${id} ${STATUS_WORDS[previous.status]} → ${STATUS_WORDS.removed}` });
    }
    return changes;
  };

  if (deps.subscribeExperiments) cleanups.push(deps.subscribeExperiments(() => sync("autonomy")));

  // 정체 — 보드와 같은 판정(`stalledObjectives`): 임무가 남고 보드가 오래 그대로인데 지휘관·구성원이 모두 쉰다. 새로 정체된
  // 목표만 한 번 깨우고, 움직이거나 보드에서 사라지면 표시를 거둔다.
  const stallTimer = setInterval(() => {
    if (disposed || !deps.observe) return;
    for (const runner of runners.values()) {
      const objectives = deps.objectives(runner.theaterId);
      const operators = operatorsOf(objectives);
      const stalled = new Set(stalledObjectives(objectives, deps.observe, now()));
      let changed = false;
      for (const id of [...runner.stalledReported]) if (!stalled.has(id)) { runner.stalledReported.delete(id); changed = true; }
      for (const id of stalled) {
        if (runner.stalledReported.has(id)) continue;
        runner.stalledReported.add(id); changed = true;
        // 정체 표시는 사람의 줄에도 서야 하므로 모두 적고, 깨우는 것은 사령관이 운영하는 목표만이다.
        if (operators.get(id) === "human") { hold(runner, id, "stalled"); continue; }
        const title = objectives.find((objective) => objective.id === id)?.title ?? id;
        wake(runner, "stalled", { bump: true, detail: title });
        noteIds(runner, "stalled", id, title);
      }
      if (changed) publish(runner);
    }
  }, STALL_CHECK_MS);
  stallTimer.unref?.();
  cleanups.push(() => clearInterval(stallTimer));

  return {
    status(theaterId) {
      const runner = runners.get(theaterId);
      return runner ? statusOf(runner) : null;
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
    clear(theaterId) {
      const pending = clears.get(theaterId);
      if (pending) return pending;
      if (disposed) return Promise.reject(new Error("commodore_inactive"));
      const work = (async () => {
        await stop(theaterId, "cleared");
        deps.store.transcriptClear(theaterId);
      })().finally(() => {
        clears.delete(theaterId);
        if (!disposed && shouldRun(theaterId)) start(theaterId, "autonomy", false);
      });
      clears.set(theaterId, work);
      return work;
    },
    sync,
    async dispose() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      await Promise.all([...clears.values(), ...stops.values(), ...[...runners.keys()].map((theaterId) => stop(theaterId, "Console stopping"))]);
    },
  };

}

function statusMap(objectives: readonly Objective[]): Map<string, TrackedStatus> {
  const operators = operatorsOf(objectives);
  return new Map(objectives.map((objective) => [objective.id, { status: objectiveStatus(objective), operator: operators.get(objective.id)! }]));
}

/** 목표마다 운영 주체 — 깨움·집계·기록이 같은 판정(`objectiveOperator`)을 쓴다. */
function operatorsOf(objectives: readonly Objective[]): Map<string, ObjectiveOperator> {
  const byId = new Map(objectives.map((objective) => [objective.id, objective]));
  return new Map(objectives.map((objective) => [objective.id, objectiveOperator(objective, (id) => byId.get(id))]));
}

/** 사령관이 운영하는 열린 목표가 하나라도 있다 — 없으면 「빈 보드」로 한 번 깨운다. */
function hasOpenOperated(objectives: readonly Objective[]): boolean {
  const operators = operatorsOf(objectives);
  return objectives.some((objective) => operators.get(objective.id) === "commodore" && !objective.done && !objective.removed);
}

/** 보드 도구 입력이 가리키는 목표 — 읽기는 상태를 바꾸지 않으니 함께 표시돼도 해가 없다. */
function writeTargets(args: unknown): readonly string[] {
  if (!args || typeof args !== "object") return [];
  const input = args as { objectiveId?: unknown; remove?: { objectiveIds?: unknown }; merge?: { into?: unknown; from?: unknown }; restore?: unknown };
  const ids = [input.objectiveId, ...(Array.isArray(input.remove?.objectiveIds) ? input.remove.objectiveIds : []), input.merge?.into, ...(Array.isArray(input.merge?.from) ? input.merge.from : []), ...(Array.isArray(input.restore) ? input.restore : [])];
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * 보드의 대기 상태 항목 — `code:objectiveId`, 결정 요청은 개정까지(같은 목표의 새 요청도 새 항목). 이유는 inbox 보기와 같다.
 * 사람이 운영하는 목표의 항목은 `human:` 머리를 단다 — 깨우지 않고, 사람이 맡기면 머리 없는 새 항목이 되어 그때 깨운다.
 */
function waitingKeys(objectives: readonly Objective[]): Set<string> {
  const operators = operatorsOf(objectives);
  const keys = new Set<string>();
  for (const objective of objectives) {
    const head = operators.get(objective.id) === "human" ? `${HUMAN_KEY}:` : "";
    for (const reason of inboxReasons(objective)) keys.add(head + (reason === "decision" ? `${reason}:${objective.id}:${objective.decisionRequestRevision}` : `${reason}:${objective.id}`));
  }
  return keys;
}

/** 사령관이 운영하는 목표에 남은 대기 상태의 수 — 지금 그 이유를 가진 목표 수(절대값). 없으면 빈 목록이다. */
function inboxDigest(objectives: readonly Objective[]): readonly [WakeCode, number][] {
  // 보드가 아는 이유 코드는 깨움 코드와 이름이 같다 — 보드가 새 이유를 더하면 여기 순서에 넣는다.
  const operators = operatorsOf(objectives);
  const counts = new Map<string, number>();
  for (const objective of objectives) if (operators.get(objective.id) === "commodore") for (const reason of inboxReasons(objective) as readonly string[]) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return (["decision", "criteria", "review", "followup", "followup-failed", "member-failed", "pending", "planned"] as const).flatMap((code) => (counts.get(code) ? [[code, counts.get(code)!] as [WakeCode, number]] : []));
}

/** 모델 문맥 — 네 Claude 가족(정준·bare)은 1M, 그 밖 bare 모델은 200k(교대 판단에만 쓴다). */
function contextWindow(model: string): number {
  const id = canonicalModelId(model);
  if (/\[1m\]/i.test(id) || id === "fable" || id === "opus" || id === "sonnet" || id === "haiku") return 1_000_000;
  return 200_000;
}

function failureCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/gateway_unavailable|agent_host_disposed/.test(message)) return "session_failed";
  if (/model/i.test(message)) return "model_unavailable";
  return /^[a-z_]{1,64}$/.test(message) ? message : fallback;
}
