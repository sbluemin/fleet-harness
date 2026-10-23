import type { ConsoleResidentAgentHost } from "../../execution/host/agent/console-resident.js";
import type { ResidentSessionFingerprints } from "../../execution/host/agent/launch-fingerprint.js";
import { Buffer } from "node:buffer";
import type { AgentInputBlock, PluginAttachmentHost } from "@fleet-console/sdk/agent";
import type { PluginMcpServerTools, PluginMcpTool } from "@fleet-console/sdk/mcp";
import { canonicalModelId, isAgentEffort } from "@fleet-console/sdk/models";
import type { FleetPluginModelsHost } from "@fleet-console/sdk/plugin";
import { DEFAULT_EXPERIMENT_SETTINGS, experimentAideSelection, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

import type { CommodoreAttachmentReader, CommodoreBoardWakeCode, CommodoreBoardAdapter, CommodoreBoardWatch, CommodoreTurnBindings } from "@fleet-console/sdk/commodore";
import { CommodoreStoreError } from "./errors.js";
import { commodoreSessionSetup, createCommodoreSession, type CommodoreSession, type CommodoreSessionCoordinates, type CommodoreTurnOutcome } from "./session.js";
import type { CommodoreStore } from "./store.js";
import { createCommodoreTools, type CommandExecute } from "./tools.js";
import { messagePromptText } from "./prompt.js";
import { undeliveredMessageSeqs } from "../shared/delivery.js";
import { MAX_COMMODORE_TURN_IMAGE_BYTES, MAX_COMMODORE_SESSION_IMAGE_BYTES, MAX_COMMODORE_SESSION_IMAGE_BASE64_BYTES, MAX_COMMODORE_TURN_MESSAGE_CHARS } from "../shared/attachment-budget.js";
import { commodoreCompactAt, DEFAULT_PATROL_MINUTES, EMPTY_RUN_TOTALS, MAX_TRANSCRIPT_PAGE, patrolIntervalMs, type CommodoreEvent, type CommodoreRunStatus, type CommodoreTranscriptEntry } from "./types.js";

/**
 * 감독자 — 사령관 UUID마다 하나. 사령관 세션은 턴이 끝나면 쉬고, 끝없이 도는 것은 이 감독자가 보장한다.
 *
 * 깨울 이유(보드 사건·지시·정보·사람의 메시지·정체·순찰·빈 보드·재시작)를 모아 몇 초 뒤 한 턴으로 보내고, 턴 중에 온 이유는
 * 다음 턴 하나로 합친다. 턴 중에 온 사람의 말은 예외다 — 도는 턴에 건네 같은 턴이 읽는다(채팅·지휘관과 같다). 순찰은 사령관이
 * `next_wake` 로 예약하되 사람이 고른 순찰 간격(기본 60분)을 넘지 않고, 턴 오류는 1·5·15분 뒤 재시도한 뒤 60분 간격으로 계속한다
 * (자율 운영은 꺼지지 않는다). 문맥이 길어지면 같은 세션이 압축해 잇고, Console 재시작·자율 운영 재개는
 * 기록 꼬리의 최근 행위 요약을 받는 새 대화다. 좌표·언어·이미지 예산이 바뀔 때만 교대한다(새 세션 + 최근 행위 요약). Console 조합이 모든 플러그인을 붙인 뒤 켜진 Theater 를 복원한다. 자율 운영·실험 기능 끔은 바로 멈추고, 종료 예정 시각에는 알림 턴 하나 뒤 멈춘다.
 *
 * 순찰 간격만 사람의 노브다(서랍). 재시도 간격·모으는 시간·교대 비율은 감독자 내부 값이다.
 */

/** 저장값이 없을 때의 순찰 간격. */
export const DEFAULT_PATROL_MS = DEFAULT_PATROL_MINUTES * 60_000;
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
export const RETRY_STEADY_MS = 60 * 60_000;
/** 깨움 이유를 모으는 시간. */
export const COALESCE_MS = 3_000;
const RECENT_ACTIONS = 12;

export interface CommodoreSupervisorDeps {
  readonly store: CommodoreStore;
  readonly theaterIds: (commodoreId: string) => readonly string[];
  readonly cwd: (commodoreId: string) => string | null;
  readonly agent: ConsoleResidentAgentHost;
  readonly attachments?: PluginAttachmentHost;
  readonly experiments: () => ConsoleExperimentSettings;
  readonly subscribeExperiments?: (listener: () => void) => () => void;
  /**
   * Console의 모델 로스터 해석 — 저장 좌표를 Agent SDK wire id로 풀고, Gateway에서 끈 모델은 저장값을 고쳐 쓰지 않은 채
   * 폴백 좌표로 연다. 없는 호스트에서는 저장 좌표를 그대로 쓴다.
   */
  readonly models?: Pick<FleetPluginModelsHost, "resolve" | "pinClaudeVersion">;
  /** Theater 의 이름과 루트 실경로 — 모르면 null(잊힌·떨어진 Theater). */
  readonly theater: (commodoreId: string) => { readonly label: string; readonly root: string } | null;
  readonly board: () => CommodoreBoardAdapter | null;
  /** 호스트가 이 사령관에 묶어 준 지식 도구(Codex Wiki) — 세션을 열 때 읽는다. 없으면 사령관은 그 도구 없이 선다. */
  readonly knowledgeTools?: (commodoreId: string) => readonly PluginMcpServerTools[];
  readonly emit: (event: CommodoreEvent) => void;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
  /**
   * 세션 시작 구성의 지문 — 세션을 연 순간 한 번 찍고, 상태를 낼 때 지금의 기대 구성과 비교한 판정만 싣는다. 없으면 판정을 싣지 않는다.
   * 계산은 실행 기능(launch-fingerprint)이 지고, 여기는 불투명한 지문을 들고만 있다.
   */
  readonly setupFingerprints?: ResidentSessionFingerprints;
}

/** 한 턴을 여는 실행 좌표. `model`은 Agent SDK wire id다. */
interface RunCoordinates extends CommodoreSessionCoordinates {
  readonly contextWindow: number;
  /** 로스터 폴백으로 섰으면 실행 기록에 남길 사유(`fallback:<reason>:<model>`). */
  readonly fallback?: string;
}

export interface CommodoreSupervisor {
  /** 지금 상태 — 감독자가 모르는 Theater(돌지 않는)는 null. */
  status(commodoreId: string): Omit<CommodoreRunStatus, "totals"> | null;
  /** 재시도 대기를 지금 깨운다. 그 상태가 아니면 `commodore_not_retrying`. */
  retry(commodoreId: string): Promise<void>;
  /** 진행 턴·대기 메시지를 거두고 요약 없이 새 문맥으로 시작한다. 기록 파일도 지운다. */
  clear(commodoreId: string): Promise<void>;
  /** 실험 기능·자율 운영을 다시 읽어 돌아야 할 Theater 를 세우고 아닌 것을 멈춘다. */
  sync(reason?: string): void;
  reattach(): Promise<void>;
  detach(): Promise<void>;
  dispose(): Promise<void>;
}

type Phase = CommodoreRunStatus["phase"];

/**
 * 깨움 이유 코드 — 기록에는 `code` 또는 `code:N` 토큰으로 남고(화면이 로케일로 옮긴다), 모델에게는 영어 문장으로 간다.
 * 수가 붙는 코드는 절대값(지금 그 상태인 목표 수)이고, intel 은 아직 전달하지 않은 새 항목 수다. intel-edited·intel-removed 는 서로 다른 수정·삭제 항목 수다.
 */
export type WakeCode = "patrol" | "directive" | "intel" | "intel-edited" | "intel-removed" | "message" | "status" | "decision" | "review" | "criteria" | "pending" | "planned" | "followup" | "followup-failed" | "member-failed" | "stalled" | "empty" | "restart" | "autonomy" | "retry" | "rotated" | "answered" | "returned";

const STATUS_DETAILS = 8;

interface PendingReason {
  count?: number;
  readonly details: string[];
  /** 이 이유를 낸 목표(상태·정체)와 그 목표가 보탠 상세 — 범위 줄과, 돌려받은 목표의 사유를 걷는 데 쓴다. 보드 대기 코드는 턴 직전 보드에서 다시 찾는다. */
  ids?: Map<string, string[]>;
}

/** 보드 대기 상태의 코드 — 수는 턴 직전의 보드에서 다시 센다. */
const BOARD_CODES: ReadonlySet<WakeCode> = new Set<WakeCode>(["decision", "criteria", "review", "followup", "followup-failed", "member-failed", "pending", "planned"]);

/** 깨움 문장의 질문 가리킴 — 첫 질문 앞부분. 답은 asks 도구에 있다. */
const askDetail = (question: string) => `your question "${question.length > 60 ? `${question.slice(0, 59)}…` : question}" (read asks)`;

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
    case "intel-edited": return `the person edited ${plural("intel item")}${tail}`;
    case "intel-removed": return `the person removed ${plural("intel item")}${tail}`;
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
    case "answered": return `the person answered ${plural("item")} you handed or asked them${tail}`;
    case "returned": return `the person returned ${plural("item")} to you${tail}`;
    default: return code;
  }
}

interface QueuedMessage {
  readonly seq: number;
  readonly text: string;
  readonly messageId?: string;
  readonly attachments?: readonly { readonly id: string }[];
  readonly imageBytes?: number;
}

interface Runner {
  readonly commodoreId: string;
  session: CommodoreSession | null;
  phase: Phase;
  reason?: string;
  nextWakeAt?: number;
  /** 다음 턴에 실을 이유 — 코드마다 하나, 순서 보존. */
  pending: Map<WakeCode, PendingReason>;
  /** 사람의 메시지 — 다음 턴에 그대로 실린다. seq 는 기록의 그 줄이다(끌 때 싣지 못한 것을 「전달되지 않음」으로 가리킨다). */
  messages: QueuedMessage[];
  /** 도는 턴에 건넸고 아직 집히지 않은 메시지 — 건넨 id 로. 집히면 「전달됨」, 닿지 못하면 `messages` 로 돌아온다. */
  hosted: Map<string, QueuedMessage>;
  /** 이번 턴에 실은 메시지만 보드 도구가 복사할 수 있다. 대기·과거 메시지는 권한이 아니다. */
  turnMessages: readonly QueuedMessage[];
  sessionImageBytes: number;
  sessionImageBase64Bytes: number;
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
  /** 마지막 턴이 끝났을 때의 대화 크기(마지막 호출의 입력 토큰). */
  lastInputTokens: number;
  /** 지금 세션의 모델 창. 마지막 입력 토큰과 짝이다. */
  contextWindow: number;
  /** 지금 세션이 대화를 요약할 지점(토큰). 실행 경로가 정하는데 호스트도 모르면 null 이다. */
  compactAt: number | null;
  coordinates: CommodoreSessionCoordinates | null;
  language: "en" | "ko";
  rotateNext: "replaced" | "restarted" | null;
  recentActions: string[];
  /** 실제 첫 턴까지 붙든다 — 보드 사유가 사라져 방금 연 세션이 쉬어도 요약을 잃지 않는다. */
  replacementSummary?: readonly string[];
  board: CommodoreBoardWatch | null;
  /** 지금 열린 세션이 시작할 때 실은 구성의 지문(불투명). 세션을 새로 열 때만 바뀐다. */
  setupFingerprint?: unknown;
  stalledReported: Set<string>;
  emptyReported: boolean;
}

export function createCommodoreSupervisor(deps: CommodoreSupervisorDeps): CommodoreSupervisor {
  const now = deps.now ?? Date.now;
  const theaterIdOf = (id: string) => deps.theaterIds(id)[0] ?? "";
  const runners = new Map<string, Runner>();
  const clears = new Map<string, Promise<void>>();
  const stops = new Map<string, Promise<void>>();
  const cleanups: (() => void)[] = [];
  let disposed = false;

  const releaseMessages = (runner: Runner, messages: readonly QueuedMessage[]) => {
    for (const message of messages) if (message.messageId) deps.attachments?.release(runner.commodoreId, message.messageId);
  };
  const turnAttachments = (runner: Runner): CommodoreAttachmentReader => (ids) => {
    const unavailable = () => new CommodoreStoreError("attachment_not_available", undefined, { hint: "Only attached image IDs delivered in this turn can be copied. For an earlier image not preserved on the objective, ask the person to resend it." });
    if (!deps.attachments || runner.stopping || runner.ending || disposed || !runner.turnMessages.length) throw unavailable();
    const selected = ids.map((id) => {
      const message = runner.turnMessages.find((entry) => entry.messageId && entry.attachments?.some((image) => image.id === id));
      if (!message?.messageId) throw unavailable();
      return { id, messageId: message.messageId };
    });
    const messages = new Map<string, ReturnType<PluginAttachmentHost["read"]>>();
    for (const { messageId } of selected) if (!messages.has(messageId)) {
      try { messages.set(messageId, deps.attachments.read(runner.commodoreId, messageId)); }
      catch { throw unavailable(); }
    }
    return selected.map(({ id, messageId }) => {
      const image = messages.get(messageId)!.find((entry) => entry.id === id);
      if (!image) throw unavailable();
      return image;
    });
  };
  const boardTools = (runner: Runner): readonly PluginMcpTool[] => {
    const turn: CommodoreTurnBindings = {
      readAttachments: turnAttachments(runner),
      hasPersonMessage: () => !disposed && !runner.stopping && !runner.ending && runner.phase === "turn" && runner.turnMessages.length > 0,
      stopping: () => disposed || runner.stopping || runner.ending || deadlineReached(runner),
    };
    return (deps.board()?.tools(theaterIdOf(runner.commodoreId), turn) ?? []).map((tool) => runner.board?.attribute(tool, turn) ?? tool);
  };

  const takeUndelivered = (runner: Runner) => {
    const messages = runner.messages.splice(0);
    releaseMessages(runner, messages);
    return messages.map((message) => message.seq);
  };
  const settings = () => { try { return deps.experiments(); } catch { return DEFAULT_EXPERIMENT_SETTINGS; } };
  const shouldRun = (commodoreId: string) => settings().commodore && deps.store.read(commodoreId)?.autonomy === true && deps.theater(theaterIdOf(commodoreId)) !== null && deps.board() !== null;
  const resolveLanguage = (commodoreId: string): "en" | "ko" => deps.store.read(commodoreId)?.language ?? deps.board()?.language?.(theaterIdOf(commodoreId)) ?? "en";
  /** 실행 좌표 — Theater 좌표, 없으면 고정 기본값(Opus/High)을 로스터(`agent` 대상)에 대조한다. 턴마다 다시 푼다. */
  const resolveCoordinates = (commodoreId: string): RunCoordinates => {
    const state = deps.store.read(commodoreId);
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

  /** 같은 입력으로 지금 세션을 열면 실릴 구성 — openSession 과 같은 함수(commodoreSessionSetup)를 지난다. 도구는 설명·스키마만 읽는다. */
  const expectedSetup = (runner: Runner) => {
    const theater = deps.theater(theaterIdOf(runner.commodoreId));
    if (!theater) return null;
    const commodoreTools = createCommodoreTools({ commodoreId: runner.commodoreId, theaterRoot: theater.root, store: deps.store, onNextWake: () => undefined, objective: () => null, now, ...(deps.execute ? { execute: deps.execute } : {}) });
    const knowledgeTools = deps.knowledgeTools?.(runner.commodoreId);
    return commodoreSessionSetup({ theaterLabel: theater.label, language: resolveLanguage(runner.commodoreId), commodoreTools, boardTools: boardTools(runner), ...(knowledgeTools ? { knowledgeTools } : {}) });
  };
  /** 열린 세션의 시작 구성 판정 — 판정과 이전 release 만 상태에 싣는다. 기대 구성을 짓지 못하면 최신이라 단정하지 않는다. */
  const configurationOf = (runner: Runner): Pick<CommodoreRunStatus, "configurationState" | "configurationRelease"> => {
    if (!runner.session || !deps.setupFingerprints) return {};
    let verdict: ReturnType<ResidentSessionFingerprints["describe"]>;
    try {
      const current = expectedSetup(runner);
      verdict = current ? deps.setupFingerprints.describe(runner.setupFingerprint, current) : { state: "unknown" };
    } catch {
      verdict = { state: "unknown" };
    }
    return { configurationState: verdict.state, ...(verdict.release ? { configurationRelease: verdict.release } : {}) };
  };
  const statusOf = (runner: Runner): Omit<CommodoreRunStatus, "totals"> => ({ ...configurationOf(runner), phase: runner.phase, ...(runner.reason ? { reason: runner.reason } : {}), ...(runner.nextWakeAt ? { nextWakeAt: runner.nextWakeAt } : {}), ...(runner.stalledReported.size ? { stalled: [...runner.stalledReported] } : {}), ...(runner.contextWindow > 0 && runner.lastInputTokens > 0 ? { context: { window: runner.contextWindow, inputTokens: runner.lastInputTokens, ...(runner.compactAt !== null ? { compactAt: runner.compactAt } : {}) } } : {}), ...(runner.session && runner.coordinates ? { session: { model: runner.coordinates.model, ...(runner.coordinates.effort ? { effort: runner.coordinates.effort } : {}) } } : {}) });
  const publish = (runner: Runner) => {
    const totals = deps.store.read(runner.commodoreId)?.run ?? EMPTY_RUN_TOTALS;
    deps.emit({ op: "run", commodoreId: runner.commodoreId, theaterIds: deps.theaterIds(runner.commodoreId), run: { ...statusOf(runner), totals } });
  };
  const setPhase = (runner: Runner, phase: Phase, reason?: string) => {
    runner.phase = phase;
    runner.reason = reason;
    publish(runner);
  };
  const record = (runner: Runner, entry: Parameters<CommodoreStore["transcriptAppend"]>[1]) => {
    try { deps.store.transcriptAppend(runner.commodoreId, entry); }
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

  const patrolInterval = (commodoreId: string) => patrolIntervalMs(deps.store.read(commodoreId));
  const schedulePatrol = (runner: Runner, at: number, reason: string) => {
    if (runner.stopping || runner.ending) return;
    const bounded = Math.max(now(), Math.min(at, now() + patrolInterval(runner.commodoreId)));
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

  const captureRunner = (runner: Runner) => ({
    schema: 1,
    scalars: { setupFingerprint: runner.setupFingerprint, phase: runner.phase, reason: runner.reason, nextWakeAt: runner.nextWakeAt, messages: runner.messages, turnMessages: runner.turnMessages, sessionImageBytes: runner.sessionImageBytes, sessionImageBase64Bytes: runner.sessionImageBase64Bytes, retryAttempt: runner.retryAttempt, ending: runner.ending, patrolSet: runner.patrolSet, patrolRequest: runner.patrolRequest, lastTurnAt: runner.lastTurnAt, lastInputTokens: runner.lastInputTokens, contextWindow: runner.contextWindow, compactAt: runner.compactAt, coordinates: runner.coordinates, language: runner.language, rotateNext: runner.rotateNext, recentActions: runner.recentActions, replacementSummary: runner.replacementSummary, emptyReported: runner.emptyReported },
    pending: [...runner.pending].map(([code, reason]) => [code, { ...reason, ids: reason.ids ? [...reason.ids] : undefined }] as const),
    hosted: [...runner.hosted], stalledReported: [...runner.stalledReported],
  });
  const restoreRunner = (runner: Runner, raw: unknown) => {
    const saved = raw as ReturnType<typeof captureRunner>;
    if (saved?.schema !== 1 || !saved.scalars) throw new Error("commodore_runner_checkpoint_incompatible");
    const target = runner as unknown as Record<string, unknown>;
    for (const key of Object.keys(captureRunner(runner).scalars)) if (Object.hasOwn(saved.scalars, key)) target[key] = (saved.scalars as unknown as Record<string, unknown>)[key];
    runner.pending.clear(); for (const [code, reason] of saved.pending) runner.pending.set(code, { ...reason, ...(reason.ids ? { ids: new Map(reason.ids) } : { ids: undefined }) });
    runner.hosted.clear(); for (const [id, message] of saved.hosted) runner.hosted.set(id, message);
    runner.stalledReported = new Set(saved.stalledReported);
  };

  const openSession = async (runner: Runner, event: "opened" | "replaced" | "restarted"): Promise<CommodoreSession> => {
    const theater = deps.theater(theaterIdOf(runner.commodoreId));
    if (!theater) throw new Error("theater_unavailable");
    const cwd = deps.cwd(runner.commodoreId);
    if (!cwd) throw new Error("commodore_unavailable");
    const coordinates = resolveCoordinates(runner.commodoreId);
    const language = resolveLanguage(runner.commodoreId);
    // Agent SDK의 내장 CLI는 Claude 별칭을 자기 버전의 표로 푼다 — 설치된 Claude Code가 띄우는 지휘관과 다른 모델로
    // 서지 않게, 사령관은 설치 CLI가 푸는 정식 id로 연다. 회전 판정은 별칭 좌표로 한다(고정 id는 이 세션의 것이다).
    const model = await deps.models?.pinClaudeVersion?.(coordinates.model).catch(() => coordinates.model) ?? coordinates.model;
    // 문맥이 길어져도 세션을 바꾸지 않는다 — 같은 세션이 이 지점에서 대화를 요약해 이어 간다.
    const compactAt = commodoreCompactAt(coordinates.contextWindow);
    const session = createCommodoreSession({
      commodoreId: runner.commodoreId, cwd, theaterLabel: theater.label, language, theaterRoot: theater.root, agent: deps.agent, store: deps.store, coordinates: { model, ...(coordinates.effort ? { effort: coordinates.effort } : {}), compactAt },
      boardTools: boardTools(runner), now,
      ...(deps.setupFingerprints ? { setupFingerprints: deps.setupFingerprints } : {}),
      checkpoint: { capture: () => captureRunner(runner), restore: (state) => restoreRunner(runner, state) },
      ...(deps.knowledgeTools ? { knowledgeTools: deps.knowledgeTools(runner.commodoreId) } : {}),
      objective: (objectiveId) => { const objective = deps.board()?.objective(theaterIdOf(runner.commodoreId), objectiveId); return objective && !objective.removed ? objective : null; },
      onNextWake: (at, reason) => { runner.patrolSet = true; runner.patrolRequest = { at, reason }; schedulePatrol(runner, at, reason); },
      onLive: (live) => deps.emit({ op: "live", commodoreId: runner.commodoreId, theaterIds: deps.theaterIds(runner.commodoreId), live }),
      onInput: ({ id, state }) => {
        const message = runner.hosted.get(id);
        if (!message) return;
        runner.hosted.delete(id);
        if (state === "started") {
          runner.turnMessages = [...runner.turnMessages, message];
          record(runner, { kind: "delivered", seqs: [message.seq] }); return;
        }
        // 모델에 닿지 못했다 — 받은 순서대로 대기열에 돌려놓는다. 끄는 중이면 stop() 이 「전달되지 않음」으로 남긴다.
        const at = runner.messages.findIndex((queued) => queued.seq > message.seq);
        runner.messages.splice(at < 0 ? runner.messages.length : at, 0, message);
        wake(runner, "message");
      },
      ...(deps.execute ? { execute: deps.execute } : {}),
    });
    await session.start();
    runner.session = session;
    // host의 원 지문을 우선한다. 구 snapshot에 지문이 없으면 orchestration checkpoint의 원값을 유지한다.
    if (session.attached) { runner.setupFingerprint = session.launchFingerprint ?? runner.setupFingerprint; return session; }
    runner.setupFingerprint = session.launchFingerprint;
    runner.replacementSummary = runner.recentActions.length ? runner.recentActions.slice(-RECENT_ACTIONS) : undefined;
    runner.coordinates = coordinates;
    runner.language = language;
    runner.contextWindow = coordinates.contextWindow;
    runner.compactAt = compactAt;
    runner.lastInputTokens = 0;
    runner.sessionImageBytes = 0;
    runner.sessionImageBase64Bytes = 0;
    // 세션을 열 때마다 새 대화다.
    deps.store.addRunTotals(runner.commodoreId, { session: 1 });
    record(runner, { kind: "session", event, ...(coordinates.fallback ? { reason: coordinates.fallback } : {}), model: coordinates.model, ...(coordinates.effort ? { effort: coordinates.effort } : {}) });
    if (coordinates.fallback) console.warn(`[objectives] commodore ${coordinates.fallback}`);
    return session;
  };

  const firstTurnSummary = (runner: Runner) => {
    const summary = runner.replacementSummary;
    runner.replacementSummary = undefined;
    return summary ? { replacementSummary: summary } : {};
  };

  const deadlineReached = (runner: Runner) => {
    const at = deps.store.read(runner.commodoreId)?.stopAt;
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
        const undelivered = takeUndelivered(runner);
        for (let index = 0; index < undelivered.length; index += MAX_TRANSCRIPT_PAGE) record(runner, { kind: "undelivered", seqs: undelivered.slice(index, index + MAX_TRANSCRIPT_PAGE) });
        const session = runner.session ?? await openSession(runner, "restarted");
        if (runner.stopping || disposed) return;
        // 종료 알림도 무기한 운영으로 바뀌어서는 안 된다. SDK 취소 경로로 제한한다.
        const timeout = setTimeout(() => session.cancel(), 30_000);
        timeout.unref?.();
        try {
          const outcome = await session.turn({ ...firstTurnSummary(runner), reasons: ["scheduled-stop"], sentences: ["The scheduled end time has arrived. Autonomous operation is now ending. Do not patrol, schedule another wake, or change the board. Acknowledge the stop briefly; pending work returns to the person."] });
          noteOutcome(runner, outcome);
        } finally { clearTimeout(timeout); }
      } catch (error) {
        record(runner, { kind: "error", code: failureCode(error, "session_failed") });
      } finally {
        // Console 종료 중이면 예약을 남겨 재시작에서 처리한다. 사람이 이미 끈 새 상태는 건드리지 않는다.
        if (!runner.stopping && !disposed) deps.store.setAutonomy(runner.commodoreId, false);
      }
    })().catch((error) => {
      console.warn(`[objectives] commodore scheduled stop failed: ${error instanceof Error ? error.message : String(error)}`);
      void stop(runner.commodoreId, "scheduled stop failed");
    }).finally(() => { runner.inflight = null; });
  };

  const scheduleStop = (runner: Runner) => {
    clearTimer(runner, "stopTimer");
    if (runner.stopping || runner.ending) return;
    const at = deps.store.read(runner.commodoreId)?.stopAt;
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
      // 이미 수락한 말은 순서를 지키며 나눈다. 초과분은 다음 턴에 남고 빠지지 않는다.
      let batchBytes = 0;
      let batchBase64Bytes = 0;
      let batchChars = 0;
      let batchCount = 0;
      for (const message of runner.messages) {
        if (batchBytes + (message.imageBytes ?? 0) > MAX_COMMODORE_TURN_IMAGE_BYTES || batchChars + message.text.length > MAX_COMMODORE_TURN_MESSAGE_CHARS) break;
        batchBytes += message.imageBytes ?? 0; batchChars += message.text.length; batchCount += 1;
      }
      const selected = runner.messages.slice(0, batchCount);
      let preparedMessages: (string | { text: string; images: Extract<AgentInputBlock, { type: "image" }>[] })[] = [];
      let session = runner.session;
      try {
        // 교대 — 좌표·언어가 바뀌었거나 이미지 예산을 넘었거나 재시작 뒤다. 새 세션은 최근 행위 요약으로 연다.
        // 문맥 길이는 교대 사유가 아니다 — 세션이 스스로 압축해 이어 간다.
        preparedMessages = selected.map((message) => {
          if (!message.attachments?.length) return message.text;
          if (!deps.attachments || !message.messageId) throw new Error("attachment_not_found");
          const images = deps.attachments.read(runner.commodoreId, message.messageId);
          if (images.length !== message.attachments.length || images.some((image, index) => image.id !== message.attachments![index]!.id)) throw new Error("attachment_not_found");
          return { text: `${message.text}\n\nAttached images for this turn (copy with attachmentIds in add or edit_brief before the turn ends; do not reconstruct them as text):\n${images.map((image, index) => `${index + 1}. ${image.id}`).join("\n")}`, images: images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mime, data: Buffer.from(image.bytes).toString("base64") } })) };
        });
        batchBase64Bytes = preparedMessages.reduce((total, message) => total + (typeof message === "string" ? 0 : message.images.reduce((bytes, image) => bytes + image.source.data.length, 0)), 0);
        const rotate = runner.rotateNext ?? (session && (coordinatesChanged(runner) || runner.sessionImageBytes + batchBytes > MAX_COMMODORE_SESSION_IMAGE_BYTES || runner.sessionImageBase64Bytes + batchBase64Bytes > MAX_COMMODORE_SESSION_IMAGE_BASE64_BYTES) ? "replaced" : null);
        if (session && rotate) { await session.dispose(); session = null; runner.session = null; }
        if (!session) {
          const event = rotate ?? "opened";
          session = await openSession(runner, event);
          runner.rotateNext = null;
          if (event === "replaced") wake(runner, "rotated");
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
      const digest = runner.board?.recount() ?? new Map();
      const pending = [...runner.pending.entries()].flatMap(([code, reason]): [WakeCode, PendingReason][] => {
        if (!BOARD_CODES.has(code)) return [[code, reason]];
        const count = digest.get(code as CommodoreBoardWakeCode) ?? 0;
        return count ? [[code, { ...reason, count }]] : [];
      });
      runner.pending.clear();
      if (!pending.length) { setPhase(runner, "idle"); return; }
      const messages = runner.messages.splice(0, batchCount);
      const reasons = pending.map(([code, reason]) => wakeToken(code, reason.count));
      const sentences = pending.map(([code, reason]) => wakeSentence(code, reason));
      const scope = runner.board?.scope(new Map(pending.map(([code, reason]) => [code, [...(reason.ids?.keys() ?? [])]])));
      setPhase(runner, "turn");
      runner.patrolSet = false;
      // 실패한 턴도 살아 있는 세션의 CLI 이력에 남을 수 있다 — 재시도 이미지도 예산에 보수적으로 센다.
      runner.sessionImageBytes += batchBytes;
      runner.sessionImageBase64Bytes += batchBase64Bytes;
      runner.turnMessages = messages;
      let outcome: CommodoreTurnOutcome;
      try {
        outcome = await session.turn({ reasons, sentences, ...(scope ? { scope } : {}), ...firstTurnSummary(runner), ...(messages.length ? { messages: preparedMessages } : {}) });
      } finally { runner.turnMessages = []; }
      if (outcome.outcome === "ok") releaseMessages(runner, messages);
      noteOutcome(runner, outcome);
      if (runner.stopping || runner.ending) {
        // 끄기로 끝나지 못한 턴의 메시지도 stop()이 표시한다. 성공한 턴은 이미 전달됐으므로 제외한다. 남는 대화라도 끊긴 턴의 말이 그
        // 대화에 닿았는지는 모른다(자식이 기록하기 전에 접혔을 수 있다) — 성공을 듣기 전까지는 다시 보낼 수 있게 둔다. 겹쳐 읽는 쪽이 잃는 쪽보다 낫다.
        if (outcome.outcome !== "ok") runner.messages.unshift(...messages);
        return;
      }
      if (outcome.outcome !== "ok") {
        for (const [code, reason] of pending) if (!runner.pending.has(code)) runner.pending.set(code, reason);
        runner.messages.unshift(...messages);
        if (outcome.error === "session_disposed" || outcome.error === "session_failed") { runner.session = null; }
        // 요약이 실패한 채 턴이 오류로 끝난 세션은 넘친 대화를 그대로 안고 있다 — 같은 세션으로 다시 시도하면 같은 오류다.
        // 다음 시도는 최근 행위 요약으로 새 세션을 연다. 요약만 실패하고 턴이 끝난 세션은 다음 턴에 자식이 다시 요약한다.
        else if (outcome.outcome === "error" && outcome.compactionFailed) { runner.rotateNext ??= "replaced"; }
        scheduleRetry(runner, outcome.error ?? "turn_failed");
        return;
      }
      if (runner.messages.length) wake(runner, "message");
      runner.retryAttempt = 0;
      runner.lastTurnAt = now();
      setPhase(runner, "idle");
      // 이번 턴이 순찰을 예약하지 않았으면 기본 순찰은 이 턴 끝에서 한 간격 뒤다 — 앞 턴의 타이머를 남기지 않는다.
      if (!runner.patrolSet) { runner.patrolRequest = null; schedulePatrol(runner, now() + patrolInterval(runner.commodoreId), ""); }
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
    // 대화 크기는 마지막 호출의 입력이다 — 턴 합계는 도구를 쓴 만큼 부풀고 압축으로 줄어든 대화를 말하지 못한다.
    if (outcome.usage) runner.lastInputTokens = outcome.usage.contextTokens ?? outcome.usage.inputTokens;
    // Gateway 모델 세션은 압축 지점을 Gateway 가 정한다 — 호스트가 그 지점과 창을 토큰과 같은 단위로 알려 주면 그것을 쓴다.
    const context = outcome.usage?.context;
    if (context) {
      if (context.window !== null) runner.contextWindow = context.window;
      runner.compactAt = context.compactAt;
    }
    // 교대 요약의 재료 — 이 턴의 보드 행위 수와 결말만. 내용은 사령관이 도구로 다시 읽는다.
    const at = new Date(now()).toISOString();
    runner.recentActions.push(`${at}: ${outcome.outcome}${outcome.error ? ` (${outcome.error})` : ""}, ${outcome.actions} board action${outcome.actions === 1 ? "" : "s"}`.slice(0, 200));
    if (runner.recentActions.length > RECENT_ACTIONS * 2) runner.recentActions.splice(0, runner.recentActions.length - RECENT_ACTIONS);
  };

  const coordinatesChanged = (runner: Runner) => {
    const coordinates = resolveCoordinates(runner.commodoreId);
    return !runner.coordinates || runner.coordinates.model !== coordinates.model || runner.coordinates.effort !== coordinates.effort || runner.language !== resolveLanguage(runner.commodoreId);
  };

  /** clear 경계 뒤 최근 결말과 같은 턴의 성공한 보드 쓰기만 복원한다. 원시 대화는 읽지 않는다. */
  const restoreRecentActions = (id: string): string[] => {
    const results: string[] = [];
    let before: number | undefined;
    let chunks: CommodoreTranscriptEntry[][] = [];
    // 결과 12개를 포함하는 턴의 시작까지 읽는다. 파일 자체는 저장소의 4MiB 보관 상한 안이다.
    for (;;) {
      const page = deps.store.transcriptRead(id, { limit: MAX_TRANSCRIPT_PAGE, ...(before === undefined ? {} : { before }) });
      chunks.unshift([...page.entries]);
      if (!page.hasMore || chunks.flat().filter((entry) => entry.kind === "result").length > RECENT_ACTIONS) break;
      before = page.entries[0]?.seq;
      if (before === undefined) break;
    }
    let actions = 0;
    for (const entry of chunks.flat()) {
      if (entry.kind === "wake") actions = 0;
      else if (entry.kind === "tool" && entry.action && entry.ok !== false && (entry.name === "console_objectives" || entry.name === "console_objectives_detail")) actions += 1;
      else if (entry.kind === "result") {
        results.push(`${new Date(entry.at).toISOString()}: ${entry.outcome}${entry.error ? ` (${entry.error})` : ""}, ${actions} board action${actions === 1 ? "" : "s"}`.slice(0, 200));
        actions = 0;
      }
    }
    return results.slice(-RECENT_ACTIONS);
  };

  const start = (commodoreId: string, reason: WakeCode, wakeImmediately = true) => {
    if (disposed || clears.has(commodoreId)) return;
    let runner = runners.get(commodoreId);
    if (runner && !runner.stopping) return;
    runner = { commodoreId, session: null, phase: "idle", pending: new Map(), messages: [], hosted: new Map(), turnMessages: [], sessionImageBytes: 0, sessionImageBase64Bytes: 0, coalesce: null, patrol: null, retry: null, retryAttempt: 0, inflight: null, stopping: false, ending: false, stopTimer: null, patrolSet: false, patrolRequest: null, lastTurnAt: now(), lastInputTokens: 0, contextWindow: 0, compactAt: 0, coordinates: null, language: "en", rotateNext: reason === "restart" ? "restarted" : null, recentActions: restoreRecentActions(commodoreId), board: null, stalledReported: new Set(), emptyReported: false };
    const current = runner;
    current.board = deps.board()?.watch(theaterIdOf(commodoreId), {
      wake: (code, input) => {
        wake(current, code, input);
        if (input?.objectiveId && input.detail) noteIds(current, code, input.objectiveId, input.detail);
      },
      forget: (objectiveId) => forgetStatus(current, objectiveId),
      stalledChanged: (ids) => { current.stalledReported = new Set(ids); publish(current); },
    }) ?? null;
    runners.set(commodoreId, runner);
    setPhase(runner, "idle");
    scheduleStop(runner);
    // Clear 직후는 빈 기록을 유지한다. 다음 메시지·사건·순찰에서 새 세션을 연다.
    if (!wakeImmediately) { schedulePatrol(runner, now() + patrolInterval(commodoreId), ""); return; }
    requeueUndelivered(runner);
    wake(runner, reason);
    if (runner.board?.emptyOperated()) { runner.emptyReported = true; wake(runner, "empty"); }
    // 자율 운영이 꺼진 동안 사람이 답한 질문 — 사령관이 아직 읽지 않았다.
    for (const ask of deps.store.read(commodoreId)?.asks ?? []) if (ask.settled?.outcome === "answered" && ask.readAt === undefined) wake(runner, "answered", { bump: true, detail: askDetail(ask.questions[0]?.text ?? ask.id) });
  };

  /**
   * 지난번 끌 때 「전달되지 않음」으로 남은 사람의 메시지를 대기열에 다시 싣는다 — 새 대화에서도 그 말을 잃지 않는다.
   * 이미지가 붙은 말은 끌 때 보관이 풀려 다시 싣지 못한다(그대로 「전달되지 않음」이다).
   */
  const requeueUndelivered = (runner: Runner) => {
    let entries: readonly CommodoreTranscriptEntry[];
    try { entries = deps.store.transcriptRead(runner.commodoreId, { limit: MAX_TRANSCRIPT_PAGE }).entries; }
    catch { return; }
    const waiting = undeliveredMessageSeqs(entries);
    const messages = entries.flatMap((entry) => (entry.kind === "message" && waiting.has(entry.seq) && !entry.attachments?.length ? [entry] : []));
    if (!messages.length) return;
    for (const entry of messages) runner.messages.push({ seq: entry.seq, text: messagePromptText(entry) });
    record(runner, { kind: "requeued", seqs: messages.map((entry) => entry.seq) });
    wake(runner, "message");
  };

  const stop = (commodoreId: string, reason: string): Promise<void> => {
    const previous = stops.get(commodoreId);
    const runner = runners.get(commodoreId);
    if (!runner) return previous ?? Promise.resolve();
    runner.stopping = true;
    runner.board?.dispose();
    runners.delete(commodoreId);
    clearTimer(runner, "stopTimer");
    clearTimer(runner, "coalesce"); clearTimer(runner, "patrol"); clearTimer(runner, "retry");
    runner.pending.clear();
    // 모으는 중·재시도 대기뿐 아니라 취소된 진행 중 턴도, 결말을 기다린 뒤 아래에서 함께 표시한다.
    // 표시한 메시지는 다음에 자율 운영이 설 때 다시 실린다(requeueUndelivered) — 새 대화에도 그 말을 싣는다.
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
      const undelivered = takeUndelivered(runner);
      for (let index = 0; index < undelivered.length; index += MAX_TRANSCRIPT_PAGE) record(runner, { kind: "undelivered", seqs: undelivered.slice(index, index + MAX_TRANSCRIPT_PAGE) });
      record(runner, { kind: "session", event: "stopped", reason });
      await session?.dispose();
      if (opened && opened !== session) await opened.dispose();
    })().finally(() => { if (stops.get(commodoreId) === work) stops.delete(commodoreId); });
    stops.set(commodoreId, work);
    return work;
  };

  const sync = (reason: WakeCode = "autonomy") => {
    if (disposed) return;
    const wanted = new Set<string>();
    for (const commodoreId of deps.store.autonomousCommodores()) if (shouldRun(commodoreId)) wanted.add(commodoreId);
    for (const commodoreId of [...runners.keys()]) if (!wanted.has(commodoreId)) void stop(commodoreId, settings().commodore ? "autonomy off" : "experiment off");
    for (const commodoreId of wanted) start(commodoreId, reason);
  };

  // 지시·정보·메시지·좌표 — 저장소 사건이 깨움 이유다.
  cleanups.push(deps.store.subscribe((event) => {
    const runner = runners.get(event.commodoreId);
    if (event.op === "state") {
      if (event.change === "autonomy") { sync(); return; }
      if (!runner) return;
      if (event.change === "stopAt") { scheduleStop(runner); return; }
      if (event.change === "directive") wake(runner, "directive", { detail: `rev ${event.state.directive.rev}` });
      else if (event.change === "intel") wake(runner, "intel", { bump: true, detail: event.intelId });
      else if (event.change === "intel-removed" && event.removedIntel) {
        const { id, text } = event.removedIntel;
        const wasNew = runner.pending.get("intel")?.details.includes(id) ?? false;
        // 아직 전하지 않은 추가·수정은 삭제와 함께 걷는다. 새 항목의 취소는 별도로 깨우지 않는다.
        for (const code of ["intel", "intel-edited"] as const) {
          const reason = runner.pending.get(code);
          const at = reason?.details.indexOf(id) ?? -1;
          if (!reason || at < 0) continue;
          reason.details.splice(at, 1);
          reason.count = reason.details.length;
          if (!reason.count) runner.pending.delete(code);
        }
        if (!runner.pending.size) clearTimer(runner, "coalesce");
        if (!wasNew) {
          // 지운 본문은 도구로 다시 읽을 수 없으므로 짧은 발췌를 싣는다.
          const detail = `${id} "${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`;
          const removed = new Set(runner.pending.get("intel-removed")?.details).add(detail);
          wake(runner, "intel-removed", { count: removed.size, detail });
        }
      }
      else if (event.change === "intel-edited" && event.intelId) {
        // 고친 항목 id 를 상세로 모은다 — 수는 서로 다른 항목 수다. 본문은 싣지 않는다(사령관이 intel 도구로 읽는다).
        const edited = new Set(runner.pending.get("intel-edited")?.details).add(event.intelId);
        wake(runner, "intel-edited", { count: edited.size, detail: event.intelId });
      }
      else if (event.change === "coordinates") { runner.rotateNext ??= "replaced"; }
      else if (event.change === "patrol" && runner.patrol) {
        // 잡혀 있는 순찰을 새 간격에 다시 맞춘다 — 사령관이 고른 시각은 그대로 두되 새 간격을 넘지 않게, 기본 순찰은 마지막 턴에서 한 간격 뒤로.
        const request = runner.patrolRequest;
        schedulePatrol(runner, request ? request.at : runner.lastTurnAt + patrolInterval(runner.commodoreId), request?.reason ?? "");
      }
      return;
    }
    // 사람이 사령관의 질문에 답했다 — 답은 asks 도구로 읽는다(깨움 문장에는 싣지 않는다).
    if (event.op === "transcript" && event.entry.kind === "ask-answered" && runner) { wake(runner, "answered", { bump: true, detail: askDetail(event.entry.answers[0]?.question ?? event.entry.askId) }); return; }
    if (event.op === "transcript" && event.entry.kind === "message" && runner) {
      const { entry } = event;
      const text = messagePromptText(entry);
      const message: QueuedMessage = { seq: entry.seq, text, ...(entry.messageId ? { messageId: entry.messageId, attachments: entry.attachments, imageBytes: entry.imageBytes } : {}) };
      // 턴이 돌고 있으면 그 턴에 건넨다 — 다음 도구 경계에서 같은 턴이 읽는다. 이미지가 붙은 말은 보관·예산을 지는 다음 턴에 싣는다.
      const id = `m${entry.seq}`;
      if (!message.messageId && runner.phase === "turn" && !runner.ending && !runner.stopping && runner.session?.steer(text, id)) { runner.hosted.set(id, message); return; }
      runner.messages.push(message); wake(runner, "message");
    }
  }));

  const noteIds = (runner: Runner, code: WakeCode, id: string, detail: string) => {
    const reason = runner.pending.get(code);
    if (!reason) return;
    const ids = (reason.ids ??= new Map());
    ids.set(id, [...(ids.get(id) ?? []), detail]);
  };
  /** 사람이 돌려받은 목표 — 아직 턴에 실리지 않은 그 목표의 상태·정체 사유(맡김 포함)를 걷는다. 남은 것이 없으면 사유째 내린다. */
  const forgetStatus = (runner: Runner, objectiveId: string) => {
    for (const code of ["status", "stalled"] as const) {
      const reason = runner.pending.get(code);
      const mine = reason?.ids?.get(objectiveId);
      if (!reason || !mine) continue;
      reason.ids!.delete(objectiveId);
      const others = new Set([...reason.ids!.values()].flat());
      for (const text of new Set(mine)) { const at = reason.details.indexOf(text); if (at >= 0 && !others.has(text)) reason.details.splice(at, 1); }
      reason.count = (reason.count ?? 0) - mine.length;
      if (reason.count <= 0 || !reason.details.length) runner.pending.delete(code);
    }
  };

  if (deps.subscribeExperiments) cleanups.push(deps.subscribeExperiments(() => sync("autonomy")));

  return {
    status(commodoreId) {
      const runner = runners.get(commodoreId);
      return runner ? statusOf(runner) : null;
    },
    async retry(commodoreId) {
      const runner = runners.get(commodoreId);
      if (!runner || (runner.phase !== "retrying" && runner.phase !== "error")) throw new Error("commodore_not_retrying");
      clearTimer(runner, "retry");
      runner.nextWakeAt = undefined;
      wake(runner, "retry");
      clearTimer(runner, "coalesce");
      await runTurn(runner);
    },
    clear(commodoreId) {
      const pending = clears.get(commodoreId);
      if (pending) return pending;
      if (disposed) return Promise.reject(new Error("commodore_inactive"));
      const work = (async () => {
        await stop(commodoreId, "cleared");
        // 새 문맥 — 제품 기록을 지우므로 다음 세션에는 요약도 없다.
        deps.store.transcriptClear(commodoreId);
      })().finally(() => {
        clears.delete(commodoreId);
        if (!disposed && shouldRun(commodoreId)) start(commodoreId, "autonomy", false);
      });
      clears.set(commodoreId, work);
      return work;
    },
    sync,
    async reattach() {
      for (const id of deps.store.autonomousCommodores()) {
        if (!shouldRun(id) || !deps.agent.hasLiveSession?.(`commodore:${id}`)) continue;
        start(id, "restart", false);
        const runner = runners.get(id)!;
        clearTimer(runner, "coalesce"); clearTimer(runner, "patrol"); clearTimer(runner, "retry");
        let session: CommodoreSession;
        try {
          session = await openSession(runner, "opened");
          if (!session.attached) throw new Error("commodore_live_attach_missing");
        } catch (error) {
          const code = failureCode(error, "session_reattach_failed");
          record(runner, { kind: "error", code }); setPhase(runner, "error", code);
          continue;
        }
        const scheduleRestored = () => {
          if (disposed || runner.stopping) return;
          if (runner.pending.size) schedule(runner, "coalesce", COALESCE_MS, () => void runTurn(runner));
          else schedulePatrol(runner, runner.nextWakeAt ?? now() + patrolInterval(id), runner.patrolRequest?.reason ?? "");
        };
        if (runner.phase === "turn") {
          runner.inflight = (async () => {
            const outcome = await session.continueTurn!();
            const messages = runner.turnMessages; runner.turnMessages = [];
            if (outcome.outcome === "ok") releaseMessages(runner, messages);
            noteOutcome(runner, outcome);
            if (disposed || runner.stopping) return;
            if (runner.ending) { deps.store.setAutonomy(id, false); return; }
            if (outcome.outcome !== "ok") {
              runner.messages.unshift(...messages); scheduleRetry(runner, outcome.error ?? "turn_failed"); return;
            }
            runner.retryAttempt = 0; runner.lastTurnAt = now(); setPhase(runner, "idle");
            if (!runner.patrolSet) runner.nextWakeAt = now() + patrolInterval(id);
          })().finally(() => { runner.inflight = null; if (runner.phase !== "retrying" && runner.phase !== "error") scheduleRestored(); });
          void runner.inflight.catch((error) => { if (!disposed) scheduleRetry(runner, failureCode(error, "session_failed")); });
        } else if (runner.phase === "retrying" || runner.phase === "error") schedule(runner, "retry", Math.max(0, (runner.nextWakeAt ?? now()) - now()), () => { runner.nextWakeAt = undefined; void runTurn(runner); });
        else scheduleRestored();
      }
    },
    async detach() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      const sessions: Promise<void>[] = [];
      for (const runner of runners.values()) {
        runner.board?.dispose();
        for (const key of ["coalesce", "patrol", "retry", "stopTimer"] as const) clearTimer(runner, key);
        if (runner.session) sessions.push(runner.session.dispose());
      }
      runners.clear(); await Promise.all(sessions);
    },
    async dispose() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      await Promise.all([...clears.values(), ...stops.values(), ...[...runners.keys()].map((commodoreId) => stop(commodoreId, "Console stopping"))]);
    },
  };

}


/** 모델 문맥 — 네 Claude 가족(정준·bare)은 1M, 그 밖 bare 모델은 200k(압축 지점과 문맥 미터에만 쓴다). */
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
