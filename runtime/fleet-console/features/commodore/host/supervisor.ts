import { nextRoutineAt } from "../shared/routines.js";
import { BOARD_WRITE_TOOL_NAMES } from "../shared/tool-names.js";
import type { ConsoleResidentAgentHost } from "../../execution/host/agent/console-resident.js";
import type { AgentWorkStep } from "../../execution/host/agent/types.js";
import { CLAUDE_AUTO_COMPACT_RESERVE } from "../../execution/host/agent/agent-session.js";
import { Buffer } from "node:buffer";
import type { AgentInputBlock, AttachmentHost } from "../../execution/shared/agent.js";
import type { McpServerTools } from "../../execution/shared/admiral-mcp.js";
import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";
import { canonicalModelId, isAgentEffort } from "../../ai-gateway/shared/models.js";
import type { ModelRosterHost } from "../../ai-gateway/host/model-ports.js";
import { DEFAULT_EXPERIMENT_SETTINGS, experimentAideSelection, type ConsoleExperimentSettings } from "../../settings/shared/experiments.js";

import type { CommodoreAttachmentReader, CommodoreBoardWakeCode, CommodoreBoardAdapter, CommodoreBoardWatch, CommodoreTurnBindings } from "../../objectives/shared/commodore-board.js";
import { CommodoreStoreError } from "./errors.js";
import { createCommodoreSession, type CommodoreSession, type CommodoreSessionCoordinates, type CommodoreTurnInput, type CommodoreTurnOutcome } from "./session.js";
import type { CommodoreStore } from "./store.js";
import type { CommandExecute } from "./tools.js";
import { messagePromptText } from "./prompt.js";
import { undeliveredMessageSeqs, unheardWakes, type CommodoreUnheardWakes } from "../shared/contracts/delivery.js";
import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES, MAX_COMMODORE_TURN_IMAGE_BYTES, MAX_COMMODORE_SESSION_IMAGE_BYTES, MAX_COMMODORE_SESSION_IMAGE_BASE64_BYTES, MAX_COMMODORE_TURN_MESSAGE_CHARS } from "../shared/contracts/attachment-budget.js";
import type { TaskforceAction, TaskforceEvent, TaskforceJudgingStatus, TaskforceLedgerEntry, TaskforceState } from "../shared/contracts/taskforce.js";
import type { TaskforceStore } from "./taskforce/store.js";
import { commodoreCompactAt, EMPTY_RUN_TOTALS, type CommodoreContextDetail, MAX_SCOPE_ITEMS, MAX_TRANSCRIPT_PAGE, type CommodoreEvent, type CommodoreRunStatus, type CommodoreTranscriptEntry } from "../shared/contracts/types.js";

/**
 * 사령관별 감독자. 사건과 켜진 루틴만 깨우며 고정 주기는 없다.
 * 턴 중 사건은 다음 턴으로 모으고, 오류는 재시도한다. 실험 기능을 끄면 즉시 멈춘다.
 */

export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
export const RETRY_STEADY_MS = 60 * 60_000;
/** 깨움 이유를 모으는 시간. */
export const COALESCE_MS = 3_000;
/** TaskForce 사람 발언 묶음 — 마지막 발언 뒤 이만큼 기다리고, 처음 발언부터 최대 이만큼까지만 미룬다. */
export const TF_PERSON_QUIET_MS = 10_000;
export const TF_PERSON_MAX_MS = 30_000;
/** TaskForce 사령관 발언 묶음 — 같이 깬 성원의 판단이 끝나길 기다리는 최대 시간과 확인 간격. */
export const TF_COMMODORE_MAX_MS = 90_000;
const TF_COMMODORE_POLL_MS = 1_000;
const RECENT_ACTIONS = 12;
/** 마지막 턴이 끝난 지 이 시간이 지나면 다음 깨움에 세션을 새로 연다 — 1시간 프롬프트 캐시가 만료돼 같은 세션을 이으면 대화를 통째로 다시 쓰기 때문이다. */
export const COMMODORE_IDLE_ROTATE_MS = 60 * 60_000;

export interface CommodoreSupervisorDeps {
  readonly store: CommodoreStore;
  readonly theaterIds: (commodoreId: string) => readonly string[];
  readonly cwd: (commodoreId: string) => string | null;
  readonly agent: ConsoleResidentAgentHost;
  readonly attachments?: AttachmentHost;
  readonly experiments: () => ConsoleExperimentSettings;
  readonly subscribeExperiments?: (listener: () => void) => () => void;
  /**
   * Console의 모델 로스터 해석 — 저장 좌표를 Agent SDK wire id로 풀고, Gateway에서 끈 모델은 저장값을 고쳐 쓰지 않은 채
   * 폴백 좌표로 연다. 없는 호스트에서는 저장 좌표를 그대로 쓴다.
   */
  readonly models?: Pick<ModelRosterHost, "resolve" | "pinClaudeVersion">;
  /** Theater 의 이름과 루트 실경로 — 모르면 null(잊힌·떨어진 Theater). */
  readonly theater: (commodoreId: string, theaterId: string) => { readonly label: string; readonly root: string } | null;
  readonly board: () => CommodoreBoardAdapter | null;
  /** 사령관 자신의 생성 도구 — 목표 보드의 권한·귀속 감싸기와 별개로 같은 턴 바인딩을 쓴다. */
  readonly managementTools?: (commodoreId: string, turn: CommodoreTurnBindings) => readonly ConsoleMcpTool[];
  /** 사령관이 고른 플러그인을 세션을 여는 순간 푼다. */
  readonly plugins?: (pluginIds: readonly string[]) => readonly import("./plugins.js").ResolvedPlugin[];
  /** 사람의 실제 Claude 홈 — 있으면 사령관 세션이 그 MCP·스킬·켜 둔 플러그인을 더한다. 목표 세션에는 닿지 않는다. */
  readonly claudeHome?: import("./home-overlay.js").ClaudeHomeLocation;
  readonly emit: (event: CommodoreEvent) => void;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
  readonly isDeleting?: (commodoreId: string) => boolean;
  /**
   * TaskForce 원장 — 판단·깨움 런타임. 없으면 TF 깨움·판단을 모두 쉬고 TF 도구는 거절한다.
   * 저장소는 판단 대상 항목·chain·readSeq의 주인이고, 여기서 깨움·판단 상태만 얹는다.
   */
  readonly taskforce?: TaskforceStore;
  /** `commodore` 채널로 나가는 TF 사건 — 화면이 판단 중 표시를 그린다. */
  readonly onTaskforceEvent?: (event: TaskforceEvent) => void;
  /** 이 사령관의 설명·정보 제안 도구. 없으면 그 제안 도구를 싣지 않는다. */
  readonly proposals?: (commodoreId: string) => import("./description-proposals.js").CommodoreDescriptionProposals;
  readonly intelProposals?: (commodoreId: string) => import("./intel-proposals.js").CommodoreIntelProposals;
}

/** 한 턴을 여는 실행 좌표. `model`은 Agent SDK wire id다. */
interface RunCoordinates extends CommodoreSessionCoordinates {
  readonly contextWindow: number;
  /** 로스터 폴백으로 섰으면 실행 기록에 남길 사유(`fallback:<reason>:<model>`). */
  readonly fallback?: string;
}

export interface CommodoreSupervisor {
  /** 실험 기능과 보드가 준비되면 사람 메시지를 받는다. */
  acceptsMessage(commodoreId: string): boolean;
  /**
   * 다음 턴을 새 세션으로 연다 — 고른 플러그인 목록은 그대로지만 그 MCP 의 키나 토큰이 바뀌어, 살아 있는 자식의 환경·연결이
   * 낡았다. 실행기가 없으면 다음 실행기가 어차피 새 세션으로 연다.
   */
  replaceSessionNext(commodoreId: string): void;
  /** 지금 상태 — 감독자가 모르는 Theater(돌지 않는)는 null. */
  status(commodoreId: string): Omit<CommodoreRunStatus, "totals"> | null;
  /** 재시도 대기를 지금 깨운다. 그 상태가 아니면 `commodore_not_retrying`. */
  retry(commodoreId: string): Promise<void>;
  /** 진행 턴·대기 메시지를 거두고 요약 없이 새 문맥으로 시작한다. 기록 파일도 지운다. */
  clear(commodoreId: string): Promise<void>;
  stopForDeletion(commodoreId: string): Promise<void>;
  /** 실험 기능을 다시 읽어 자동 운영할 사령관을 세운다. */
  sync(reason?: string): void;
  /** 설명·정보 제안이 결말 났다. 실행 중이 아니면 깨우지 않는다 — 제안 목록 도구가 결말을 남긴다. */
  noteProposal(commodoreId: string, kind: "description-proposal" | "intel-proposal", outcome: string): void;
  dispose(): Promise<void>;
}

type Phase = CommodoreRunStatus["phase"];

/**
 * 깨움 이유 코드 — 기록에는 `code` 또는 `code:N` 토큰으로 남고(화면이 로케일로 옮긴다), 모델에게는 영어 문장으로 간다.
 * 수가 붙는 코드는 절대값(지금 그 상태인 목표 수)이고, intel 은 아직 전달하지 않은 새 항목 수다. intel-edited·intel-removed 는 서로 다른 수정·삭제 항목 수다.
 */
export type WakeCode = "settled" | "routine" | "description" | "description-proposal" | "intel-proposal" | "intel" | "intel-edited" | "intel-removed" | "message" | "mail" | "taskforce" | "status" | "decision" | "review" | "criteria" | "pending" | "planned" | "followup" | "followup-failed" | "member-failed" | "stalled" | "empty" | "restart" | "started" | "retry" | "rotated" | "answered" | "returned" | "resume-failed";

const STATUS_DETAILS = 8;

interface RoutineAttempt { readonly id: string; readonly name: string; readonly task: string; readonly once: boolean }

interface PendingReason {
  count?: number;
  /** 실패 재시도의 루틴. 일회성 소비와 사람의 반복 루틴 취소를 구별한다. */
  routines?: RoutineAttempt[];
  readonly details: string[];
  /** 이 이유를 낸 목표(상태·정체)와 그 목표가 보탠 상세 — 범위 줄과, 돌려받은 목표의 사유를 걷는 데 쓴다. 보드 대기 코드는 턴 직전 보드에서 다시 찾는다. */
  ids?: Map<string, string[]>;
}

/** 보드 대기 상태의 코드 — 수는 턴 직전의 보드에서 다시 센다. */
const BOARD_CODES: ReadonlySet<WakeCode> = new Set<WakeCode>(["decision", "criteria", "review", "followup", "followup-failed", "member-failed", "pending", "planned"]);
/** 끌 때 듣지 못하면 다음 기동이 다시 볼 보드 깨움 — 사람의 말·연락·답은 따로 남아 다시 실린다. */
const UNHEARD_CODES: ReadonlySet<WakeCode> = new Set<WakeCode>([...BOARD_CODES, "settled", "status", "stalled", "empty", "returned", "resume-failed"]);
/** TF 판단 턴의 조용함을 깨지 않는 이유 — 세션 수명주기(교대·재시작·재시도)는 깨움 문장만 보탤 뿐 말할 이유가 아니다. */
const QUIET_OK_REASONS: ReadonlySet<WakeCode> = new Set<WakeCode>(["taskforce", "rotated", "restart", "started", "retry", "resume-failed"]);

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
    case "settled": return `${plural("objective group")} went idle${tail}`;
    case "routine": return `routine${tail}`;
    case "description": return `description changed${tail}`;
    case "description-proposal":
    case "intel-proposal": {
      const count = reason.count ?? 1;
      const noun = code === "intel-proposal" ? "intel proposal" : "description proposal";
      return `${count} ${noun}${count === 1 ? "" : "s"} you made ${count === 1 ? "was" : "were"} settled${tail}`;
    }
    case "intel": return `${plural("new intel item")}`;
    case "intel-edited": return `the person edited ${plural("intel item")}${tail}`;
    case "intel-removed": return `the person removed ${plural("intel item")}${tail}`;
    case "message": return "the person sent you a message (quoted below)";
    case "mail": return "another Commodore sent you a message (their words, not the person's; quoted below)";
    case "taskforce": return "a TaskForce you belong to has new utterances (their words, not the person's; quoted below)";
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
    case "resume-failed": return `${plural("objective")} could not continue on its own (after a Console restart or an extension's criteria were settled)${tail}`;
    case "started": return "autonomous operation started";
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
  readonly mentions?: readonly { readonly id: string; readonly alias: string }[];
}

type ReceivedMessage = Extract<CommodoreTranscriptEntry, { kind: "received" }>;

interface Runner {
  readonly commodoreId: string;
  session: CommodoreSession | null;
  /** 막 연 세션의 첫 실제 턴에만 TF 이력을 보탠다. 빈 깨움은 이 표시를 소비하지 않는다. */
  sessionFirstTurn: boolean;
  phase: Phase;
  reason?: string;
  nextWakeAt?: number;
  /** 도는 턴 안에서 지금 하는 일의 계열 — `run.step`으로 방송된다. 턴이 아니면 null. */
  step: AgentWorkStep | null;
  /** 다음 턴에 실을 이유 — 코드마다 하나, 순서 보존. */
  pending: Map<WakeCode, PendingReason>;
  /** 사람의 메시지 — 다음 턴에 그대로 실린다. seq 는 기록의 그 줄이다(끌 때 싣지 못한 것을 「전달되지 않음」으로 가리킨다). */
  messages: QueuedMessage[];
  /** 다른 사령관의 말은 사람 입력·권한 큐에 절대 섞지 않는다. */
  mail: ReceivedMessage[];
  /** 도는 턴에 TF 원장에 남긴 말 — 성공한 턴이 보드 쓰기 묶음을 그 말 아래에 덧붙인다. */
  tfPosts: { readonly taskforceId: string; readonly seq: number }[];
  turnSent: Set<string>;
  /** 도는 턴에 건넸고 아직 집히지 않은 메시지 — 건넨 id 로. 집히면 「전달됨」, 닿지 못하면 `messages` 로 돌아온다. */
  hosted: Map<string, QueuedMessage>;
  /** 이번 턴에 실은 메시지만 보드 도구가 복사할 수 있다. 대기·과거 메시지는 권한이 아니다. */
  turnMessages: readonly QueuedMessage[];
  /** 이번 턴에 실은 사령관 연락 — 사람 메시지와 같은 ID 공간으로 복사한다. */
  turnMail: readonly ReceivedMessage[];
  sessionImageBytes: number;
  sessionImageBase64Bytes: number;
  coalesce: ReturnType<typeof setTimeout> | null;
  routineTimer: ReturnType<typeof setTimeout> | null;
  routineTimes: Map<string, { at: number; revision: string }>;
  retry: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  inflight: Promise<void> | null;
  stopping: boolean;
  /** 마지막 턴이 끝났을 때의 대화 크기(마지막 호출의 입력 토큰). */
  lastInputTokens: number;
  /** 마지막 턴이 끝난 시각(ms, now()) — 유휴 교대 판정용. 아직 돈 턴이 없으면 null. */
  lastTurnAt: number | null;
  /** 지금 세션의 모델 창. 마지막 입력 토큰과 짝이다. */
  contextWindow: number;
  /** 지금 세션이 대화를 요약할 지점(토큰). 실행 경로가 정하는데 호스트도 모르면 null 이다. */
  compactAt: number | null;
  /** 마지막 턴이 끝난 뒤 세션에서 얻은 범주별 문맥 내역. 새 세션을 열면 비운다. */
  contextDetail: CommodoreContextDetail | null;
  coordinates: CommodoreSessionCoordinates | null;
  language: "en" | "ko";
  rotateNext: "replaced" | "restarted" | null;
  recentActions: string[];
  /** 실제 첫 턴까지 붙든다 — 보드 사유가 사라져 방금 연 세션이 쉬어도 요약을 잃지 않는다. */
  replacementSummary?: readonly string[];
  /** 세션 교대에도 유지하는 모델 전용 일회성 진단 — 원장·상태에는 싣지 않는다. */
  openUIFeedback?: string;
  board: CommodoreBoardWatch | null;
  stalledReported: Set<string>;
  /** 끌 때 아직 턴이 듣지 못한 보드 깨움 — stop() 이 기록에 남긴다. */
  unheard: { codes: Set<WakeCode>; ids: Set<string>; all: boolean };
}

export function createCommodoreSupervisor(deps: CommodoreSupervisorDeps): CommodoreSupervisor {
  const now = deps.now ?? Date.now;
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
    if (runner.stopping || disposed || (!runner.turnMessages.length && !runner.turnMail.length)) throw unavailable();
    const selected = ids.map((id) => {
      const human = runner.turnMessages.find((entry) => entry.messageId && entry.attachments?.some((image) => image.id === id));
      if (human?.messageId) return { id, messageId: human.messageId, kind: "human" as const };
      const peer = runner.turnMail.find((entry) => entry.messageId && entry.attachments?.some((image) => image.id === id));
      if (peer?.messageId) return { id, messageId: peer.messageId, kind: "mail" as const };
      throw unavailable();
    });
    const humanMessages = new Map<string, ReturnType<AttachmentHost["read"]>>();
    const mailImages = new Map<string, { id: string; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; bytes: Uint8Array }>();
    for (const { messageId, kind } of selected) {
      if (kind === "human") {
        if (!deps.attachments || humanMessages.has(messageId)) continue;
        try { humanMessages.set(messageId, deps.attachments.read(runner.commodoreId, messageId)); }
        catch { throw unavailable(); }
      } else if (!mailImages.has(messageId)) {
        try {
          const entry = runner.turnMail.find((mail) => mail.messageId === messageId);
          const images = (entry?.attachments ?? []).map((attachment) => {
            const image = deps.store.images.read(runner.commodoreId, messageId, attachment.id);
            if (!image) throw unavailable();
            return image;
          });
          for (const image of images) mailImages.set(`${messageId}:${image.id}`, image);
        } catch (error) {
          if (error instanceof CommodoreStoreError) throw error;
          throw unavailable();
        }
      }
    }
    return selected.map(({ id, messageId, kind }) => {
      if (kind === "human") {
        const image = humanMessages.get(messageId)!.find((entry) => entry.id === id);
        if (!image) throw unavailable();
        return image;
      }
      const image = mailImages.get(`${messageId}:${id}`);
      if (!image) throw unavailable();
      return image;
    });
  };
  const inTurn = (runner: Runner) => !disposed && !runner.stopping && runner.phase === "turn";
  const hasPersonMessage = (runner: Runner) => () => inTurn(runner) && runner.turnMessages.length > 0;
  const boardTools = (runner: Runner): readonly ConsoleMcpTool[] => {
    const turn: CommodoreTurnBindings = {
      readAttachments: turnAttachments(runner),
      readBriefImages: (ids) => {
        const board = deps.board();
        const reader = board?.briefImages?.(runner.commodoreId);
        if (!reader) throw new CommodoreStoreError("attachment_not_available", undefined, { hint: "Only attached image IDs delivered in this turn can be copied. For an earlier image not preserved on the objective, ask the person to resend it." });
        return reader(ids);
      },
      hasPersonMessage: hasPersonMessage(runner),
      stopping: () => disposed || runner.stopping,
    };
    return [
      ...(deps.board()?.tools(runner.commodoreId, turn) ?? []).map((tool) => runner.board?.attribute(tool, turn) ?? tool),
      ...(deps.managementTools?.(runner.commodoreId, turn) ?? []),
    ];
  };

  const takeUndelivered = (runner: Runner) => {
    const messages = runner.messages.splice(0);
    releaseMessages(runner, messages);
    return messages.map((message) => message.seq);
  };
  const settings = () => { try { return deps.experiments(); } catch { return DEFAULT_EXPERIMENT_SETTINGS; } };
  /** TF 실험이 켜져 있는가 — 꺼져 있으면 TF 깨움·판단 블록·도구를 쉬고 데이터는 그대로 둔다. */
  const tfEnabled = () => deps.taskforce !== undefined && settings().taskforce === true;
  const canRun = (commodoreId: string) => !deps.isDeleting?.(commodoreId) && settings().commodore && deps.store.read(commodoreId) !== null && deps.cwd(commodoreId) !== null && deps.board() !== null;
  const resolveLanguage = (commodoreId: string): "en" | "ko" => deps.store.read(commodoreId)?.language ?? deps.board()?.language?.(commodoreId) ?? "en";
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

  const statusOf = (runner: Runner): Omit<CommodoreRunStatus, "totals"> => ({ phase: runner.phase, ...(runner.step ? { step: runner.step } : {}), routineTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, routineNextRuns: Object.fromEntries([...runner.routineTimes].map(([id, value]) => [id, value.at])), ...(runner.reason ? { reason: runner.reason } : {}), ...(runner.nextWakeAt ? { nextWakeAt: runner.nextWakeAt } : {}), ...(runner.stalledReported.size ? { stalled: [...runner.stalledReported] } : {}), ...(runner.contextWindow > 0 && runner.lastInputTokens > 0 ? { context: { window: runner.contextWindow, inputTokens: runner.lastInputTokens, ...(runner.compactAt !== null ? { compactAt: runner.compactAt } : {}), ...(runner.contextDetail ? { detail: runner.contextDetail } : {}) } } : {}), ...(runner.session && runner.coordinates ? { session: { model: runner.coordinates.model, ...(runner.coordinates.effort ? { effort: runner.coordinates.effort } : {}) } } : {}) });
  const publish = (runner: Runner) => {
    const totals = deps.store.read(runner.commodoreId)?.run ?? EMPTY_RUN_TOTALS;
    deps.emit({ op: "run", commodoreId: runner.commodoreId, theaterIds: deps.theaterIds(runner.commodoreId), run: { ...statusOf(runner), totals } });
  };
  const setPhase = (runner: Runner, phase: Phase, reason?: string) => {
    runner.phase = phase;
    // 계열은 도는 턴의 것 — 턴을 벗어나면 지우고 쉼으로 방송한다.
    runner.step = null;
    runner.reason = reason;
    publish(runner);
  };
  const record = (runner: Runner, entry: Parameters<CommodoreStore["transcriptAppend"]>[1]) => {
    try { deps.store.transcriptAppend(runner.commodoreId, entry); }
    catch (error) { console.warn(`[objectives] commodore log failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const clearTimer = (runner: Runner, key: "coalesce" | "routineTimer" | "retry") => {
    const timer = runner[key];
    if (timer) clearTimeout(timer);
    runner[key] = null;
  };
  const schedule = (runner: Runner, key: "coalesce" | "routineTimer" | "retry", delayMs: number, run: () => void) => {
    clearTimer(runner, key);
    const timer = setTimeout(() => { runner[key] = null; if (!runner.stopping && !disposed) run(); }, Math.max(0, delayMs));
    timer.unref?.();
    runner[key] = timer;
  };

  /**
   * TaskForce 깨움 묶음 — 사람 발언은 조용해질 때까지(새 발언이 재대기, 최대 30초), 사령관 발언은 같이 깬
   * 성원의 판단이 끝날 때까지(최대 90초) 모은다. 다른 이유가 함께 있으면 기본 묶음 시간을 쓴다.
   */
  const tfWaits = new Map<string, { kind: "person" | "commodore"; first: number; last: number; blockers: Map<string, Set<string>> }>();
  const coalesceDelay = (runner: Runner): number => {
    const wait = tfWaits.get(runner.commodoreId);
    if (!wait || runner.pending.size !== 1 || !runner.pending.has("taskforce")) return COALESCE_MS;
    const t = now();
    if (wait.kind === "person") return Math.max(0, Math.min(wait.last + TF_PERSON_QUIET_MS, wait.first + TF_PERSON_MAX_MS) - t);
    const due = wait.first + TF_COMMODORE_MAX_MS - t;
    let judging = false;
    for (const [taskforceId, members] of wait.blockers) for (const member of members) if (tfJudging.get(taskforceId)?.has(member)) judging = true;
    if (!judging) return Math.max(0, wait.last + COALESCE_MS - t);
    return Math.max(0, Math.min(due, TF_COMMODORE_POLL_MS));
  };
  const scheduleTurn = (runner: Runner) => schedule(runner, "coalesce", coalesceDelay(runner), () => {
    // 기다릴 이유가 남았으면(판단 중인 성원·새 사람 발언) 다시 잰다.
    if (runner.pending.size && !runner.inflight && tfWaits.has(runner.commodoreId) && runner.pending.size === 1 && runner.pending.has("taskforce") && coalesceDelay(runner) > 0) { scheduleTurn(runner); return; }
    void runTurn(runner);
  });

  /** 이유를 모은다 — 턴이 돌고 있으면 끝난 뒤, 아니면 잠깐 뒤 한 턴. 수는 절대값이 덮고 `bump` 는 누적한다. */
  const wake = (runner: Runner, code: WakeCode, input: { readonly count?: number; readonly bump?: boolean; readonly detail?: string; readonly tf?: { readonly kind: "person" | "commodore"; readonly taskforceId: string; readonly blockers: ReadonlySet<string> } } = {}) => {
    if (runner.stopping) return;
    if (!canRun(runner.commodoreId)) return;
    if (input.tf) {
      const t = now();
      const wait = tfWaits.get(runner.commodoreId) ?? { kind: input.tf.kind, first: t, last: t, blockers: new Map<string, Set<string>>() };
      // 사람 발언이 한 번이라도 있으면 사람 묶음이다.
      if (input.tf.kind === "person") wait.kind = "person";
      wait.last = t;
      const blockers = wait.blockers.get(input.tf.taskforceId) ?? new Set<string>();
      for (const member of input.tf.blockers) blockers.add(member);
      wait.blockers.set(input.tf.taskforceId, blockers);
      tfWaits.set(runner.commodoreId, wait);
    }
    const existing = runner.pending.get(code);
    const reason: PendingReason = existing ?? { details: [] };
    if (input.bump) reason.count = (reason.count ?? 0) + 1;
    else if (input.count !== undefined) reason.count = input.count;
    if (input.detail && !reason.details.includes(input.detail)) reason.details.push(input.detail);
    if (!existing) runner.pending.set(code, reason);
    if (runner.inflight) return;
    // 새 사건도 예약 재시도에 합친다.
    if (runner.phase === "retrying" || runner.phase === "error") return;
    scheduleTurn(runner);
  };

  const scheduleRoutines = (runner: Runner) => {
    clearTimer(runner, "routineTimer");
    if (runner.stopping || !canRun(runner.commodoreId)) return;
    const routines = deps.store.read(runner.commodoreId)?.routines ?? [];
    const enabled = new Set(routines.filter((r) => r.enabled).map((r) => r.id));
    for (const id of runner.routineTimes.keys()) if (!enabled.has(id)) runner.routineTimes.delete(id);
    for (const routine of routines) {
      if (!routine.enabled) continue;
      const revision = JSON.stringify([routine.updatedAt, routine.schedule]);
      if (runner.routineTimes.get(routine.id)?.revision === revision) continue;
      const at = nextRoutineAt(routine, now());
      if (at !== null) runner.routineTimes.set(routine.id, { at, revision });
    }
    const times = [...runner.routineTimes.values()].map((r) => r.at);
    const at = times.length ? Math.min(...times) : undefined;
    if (!runner.retry) runner.nextWakeAt = at;
    if (at !== undefined) schedule(runner, "routineTimer", Math.min(Math.max(0, at - now()), 2_147_483_647), () => {
      if (at > now()) { scheduleRoutines(runner); return; }
      wake(runner, "routine");
    });
    publish(runner);
  };

  const scheduleRetry = (runner: Runner, code: string) => {
    if (!canRun(runner.commodoreId)) {
      runner.nextWakeAt = undefined;
      record(runner, { kind: "error", code });
      setPhase(runner, "error", code);
      return;
    }
    const delay = RETRY_DELAYS_MS[runner.retryAttempt] ?? RETRY_STEADY_MS;
    runner.retryAttempt += 1;
    const at = now() + delay;
    runner.nextWakeAt = at;
    record(runner, { kind: "error", code, retryAt: at });
    setPhase(runner, runner.retryAttempt > RETRY_DELAYS_MS.length ? "error" : "retrying", code);
    schedule(runner, "retry", delay, () => { runner.nextWakeAt = undefined; void runTurn(runner); });
  };

  const openSession = async (runner: Runner, event: "opened" | "replaced" | "restarted"): Promise<CommodoreSession> => {
    const cwd = deps.cwd(runner.commodoreId);
    if (!cwd) throw new Error("commodore_unavailable");
    const coordinates = resolveCoordinates(runner.commodoreId);
    const language = resolveLanguage(runner.commodoreId);
    // Agent SDK의 내장 CLI는 Claude 별칭을 자기 버전의 표로 푼다 — 설치된 Claude Code가 띄우는 지휘관과 다른 모델로
    // 서지 않게, 사령관은 설치 CLI가 푸는 정식 id로 연다. 회전 판정은 별칭 좌표로 한다(고정 id는 이 세션의 것이다).
    const model = await deps.models?.pinClaudeVersion?.(coordinates.model).catch(() => coordinates.model) ?? coordinates.model;
    // 문맥이 길어져도 세션을 바꾸지 않는다 — 상한을 넘는 창은 상한 지점에서, 그 이하는 모델 기본 정책으로 같은 세션이 압축해 이어 간다.
    const compactAt = commodoreCompactAt(coordinates.contextWindow);
    const session = createCommodoreSession({
      commodoreId: runner.commodoreId, cwd, theaterLabel: deps.store.read(runner.commodoreId)?.alias ?? "Commodore", language, theaterRoot: cwd, theaters: () => deps.theaterIds(runner.commodoreId).map((theaterId) => { const theater = deps.theater(runner.commodoreId, theaterId); return { theaterId, label: theater?.label ?? theaterId, root: theater?.root ?? null }; }), agent: deps.agent, store: deps.store, coordinates: { model, ...(coordinates.effort ? { effort: coordinates.effort } : {}), ...(compactAt === null ? {} : { compactAt }) },
      boardTools: boardTools(runner), now,
      onOpenUIFeedback: (note) => { runner.openUIFeedback = note ?? undefined; },
      ...(deps.plugins ? { plugins: () => deps.plugins!(deps.store.read(runner.commodoreId)?.plugins ?? []) } : {}),
      ...(deps.claudeHome ? { claudeHome: deps.claudeHome } : {}),
      // 실험 상태는 세션을 연 뒤에도 바뀐다 — 도구 실행 때마다 확인해, 켠 뒤에는 열린 세션도 말할 수 있고 끈 뒤에는 막힌다.
      // 읽기는 말하기와 같은 문이다: 켜져 있을 때만 참여한 구간의 원장을 본다.
      ...(deps.proposals ? { proposals: deps.proposals(runner.commodoreId) } : {}),
      ...(deps.intelProposals ? { intelProposals: deps.intelProposals(runner.commodoreId) } : {}),
      ...(deps.taskforce ? {
        taskforce: {
          append: (...args: Parameters<TaskforceStore["append"]>) => {
            if (!tfEnabled()) throw new Error("taskforce_unavailable");
            return deps.taskforce!.append(...args);
          },
          list: (...args: Parameters<TaskforceStore["list"]>) => {
            if (!tfEnabled()) throw new Error("taskforce_unavailable");
            return deps.taskforce!.list(...args);
          },
          read: (...args: Parameters<TaskforceStore["read"]>) => {
            if (!tfEnabled()) throw new Error("taskforce_unavailable");
            return deps.taskforce!.read(...args);
          },
          readLedger: (...args: Parameters<TaskforceStore["readLedger"]>) => {
            if (!tfEnabled()) throw new Error("taskforce_unavailable");
            return deps.taskforce!.readLedger(...args);
          },
        },
      } : {}),
      objective: (objectiveId) => { const objective = deps.board()?.objective(runner.commodoreId, objectiveId); return objective && !objective.removed ? objective : null; },
      onLive: (live) => deps.emit({ op: "live", commodoreId: runner.commodoreId, theaterIds: deps.theaterIds(runner.commodoreId), live }),
      onStep: (step) => {
        // 도는 턴의 계열만 `run`에 싣는다 — 늦게 닿은 보고가 쉼을 덮지 않게. 바뀌었을 때만 방송한다.
        if (runner.phase !== "turn" || runner.step === step) return;
        runner.step = step;
        publish(runner);
      },
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
    runner.sessionFirstTurn = true;
    runner.replacementSummary = runner.recentActions.length ? runner.recentActions.slice(-RECENT_ACTIONS) : undefined;
    runner.coordinates = coordinates;
    runner.language = language;
    runner.contextWindow = coordinates.contextWindow;
    // 미터 표시 — 덮지 않은 창(null)은 모델 기본 지점(창 − 33k)을 보여준다. Gateway 모델은 첫 턴 사용량이 실제 지점으로 바로잡는다.
    runner.compactAt = compactAt ?? coordinates.contextWindow - CLAUDE_AUTO_COMPACT_RESERVE;
    runner.lastInputTokens = 0;
    runner.contextDetail = null;
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

  /**
   * TaskForce 판단 상태 — 휘발성이다. 판단 중인 성원 집합과 성원별 마지막 결과(spoke/silent)를
   * TF마다 들고, 바뀔 때마다 `taskforce-judging` 사건으로 방송한다. 재시작하면 읽지 않은
   * 원장에서 판단 중만 다시 세운다(결과는 비어 있을 수 있다).
   */
  const tfJudging = new Map<string, Set<string>>();
  const tfOutcomes = new Map<string, Map<string, { readonly outcome: "spoke" | "silent" | "failed"; readonly at: number }>>();
  const tfSnapshot = (taskforceId: string): TaskforceJudgingStatus => ({
    taskforceId,
    judging: [...(tfJudging.get(taskforceId) ?? [])].sort(),
    outcomes: Object.fromEntries(tfOutcomes.get(taskforceId) ?? new Map()),
    at: now(),
  });
  const emitTf = (event: TaskforceEvent) => {
    try { deps.onTaskforceEvent?.(event); }
    catch (error) { console.warn(`[objectives] taskforce event failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const judgingAdd = (taskforceId: string, member: string) => {
    let set = tfJudging.get(taskforceId);
    if (!set) { set = new Set(); tfJudging.set(taskforceId, set); }
    if (set.has(member)) return;
    set.add(member);
    emitTf({ ...tfSnapshot(taskforceId), op: "taskforce-judging" });
    persistTfJudging(taskforceId);
  };
  /** 판단 항목이 비어 판단이 끝난 성원 — 결과 없이 판단 중에서만 뺀다(빈 깨움 정리). */
  const judgingDropQuiet = (taskforceId: string, member: string) => {
    if (!tfJudging.get(taskforceId)?.delete(member)) return;
    emitTf({ ...tfSnapshot(taskforceId), op: "taskforce-judging" });
    persistTfJudging(taskforceId);
  };
  const recordTfOutcome = (taskforceId: string, member: string, outcome: "spoke" | "silent") => {
    if (tfJudging.get(taskforceId)?.delete(member)) { /* 판단에서 빠진다 */ }
    let outcomes = tfOutcomes.get(taskforceId);
    if (!outcomes) { outcomes = new Map(); tfOutcomes.set(taskforceId, outcomes); }
    // 끝난 판단마다 시각을 새긴다 — 같은 결과의 되풀이도 최근 시각으로 남는다.
    outcomes.set(member, { outcome, at: now() });
    emitTf({ ...tfSnapshot(taskforceId), op: "taskforce-judging" });
    persistTfJudging(taskforceId);
  };
  /** 실패·취소된 턴 — 항목은 다시 줄을 서고(pending 복원), 판단 중에는 남기고 결과만 failed로 둔다. */
  const recordTfFailed = (taskforceId: string, member: string) => {
    let set = tfJudging.get(taskforceId);
    if (!set) { set = new Set(); tfJudging.set(taskforceId, set); }
    set.add(member);
    let outcomes = tfOutcomes.get(taskforceId);
    if (!outcomes) { outcomes = new Map(); tfOutcomes.set(taskforceId, outcomes); }
    outcomes.set(member, { outcome: "failed", at: now() });
    emitTf({ ...tfSnapshot(taskforceId), op: "taskforce-judging" });
    persistTfJudging(taskforceId);
  };
  /** 판단 스냅샷을 읽을 때의 모습으로 남긴다 — 판단 사건 방송이 아니라 state.json이다. */
  const persistTfJudging = (taskforceId: string) => {
    if (!deps.taskforce) return;
    try { deps.taskforce.saveJudging(taskforceId, tfSnapshot(taskforceId)); }
    catch (error) { console.warn(`[objectives] taskforce judging persist failed: ${error instanceof Error ? error.message : String(error)}`); }
  };

  /** 속한 TF — 판단 블록과 재기동 재실음의 범위다. */
  const memberTaskforces = (commodoreId: string): readonly { readonly id: string; readonly name: string; readonly topic: string; readonly members: readonly string[] }[] => {
    if (!tfEnabled()) return [];
    try { return deps.taskforce!.list().filter((tf) => tf.members.includes(commodoreId)); }
    catch { return []; }
  };

  /** 판단 블록 머리 — id와 성원 id를 함께 싣는다. 도구가 UUID를 요구하므로 모델이 추측하지 않게 한다. */
  const tfHeadLine = (tf: { readonly id: string; readonly name: string; readonly topic: string; readonly members: readonly string[] }, note?: string): string => {
    const aliasOf = (id: string) => deps.store.read(id)?.alias ?? id;
    return [`TaskForce ${JSON.stringify(tf.name)} (id: ${tf.id}) — topic: ${tf.topic}${note ? ` (${note})` : ""}`, `Members: ${tf.members.map((id) => `${aliasOf(id)} (${id})`).join(", ")}`].join("\n");
  };

  /** 원장 한 줄 — 원장 내용만 싣는다. 1:1 기록·기억·연락은 절대 섞지 않는다(격리). */
  const tfEntryLine = (entry: TaskforceLedgerEntry): string => {
    const aliasOf = (id: string) => deps.store.read(id)?.alias ?? id;
    const speaker = entry.speaker.kind === "person" ? "person"
      : entry.speaker.kind === "system" ? `system(${entry.speaker.code})` : aliasOf(entry.speaker.commodoreId);
    const parts = [`[seq ${entry.seq}] ${entry.images?.length ? `(image ×${entry.images.length}) ` : ""}${speaker}: ${entry.text}`];
    if (entry.mentions.length) parts.push(`(to ${entry.mentions.map(aliasOf).join(", ")})`);
    if (entry.replyTo !== undefined) parts.push(`(reply to seq ${entry.replyTo})`);
    for (const action of entry.actions ?? []) parts.push(`(action ${action.kind} ${action.objectiveId} ${JSON.stringify(action.title)})`);
    return parts.join(" ");
  };

  /** 같은 턴의 성공한 보드 쓰기 — 기록의 이 턴 구간에서 action·objectiveId가 남은 tool 줄만 모은다. 새 쪽부터 걷는다. */
  const collectTurnBoardWrites = (commodoreId: string, afterSeq: number): TaskforceAction[] => {
    const writes: TaskforceAction[] = [];
    let before: number | undefined;
    for (;;) {
      let page;
      try { page = deps.store.transcriptRead(commodoreId, { limit: MAX_TRANSCRIPT_PAGE, ...(before === undefined ? {} : { before }) }); }
      catch { break; }
      let done = false;
      for (const entry of [...page.entries].reverse()) {
        if (entry.seq <= afterSeq) { done = true; break; }
        if (entry.kind === "tool" && entry.action && entry.objectiveId && entry.ok !== false && BOARD_WRITE_TOOL_NAMES.has(entry.name)) {
          writes.push({ kind: entry.action, objectiveId: entry.objectiveId, title: entry.title ?? "" });
        }
      }
      if (done || !page.hasMore || !page.entries.length) break;
      before = page.entries[0]!.seq;
    }
    return writes.reverse();
  };

  /**
   * 자기 발언·렌더용 보드 묶음만으로는 깨우지 않는다. 다른 성원만 지목한 말도 나를 깨우지 않는다 — 다음 깨움에 함께 실린다
   * (구독부의 지목 규칙과 같다: 발언자 자신만 지목한 말은 지목 없음으로 본다). 읽음 커서는 성공한 턴만 전진시킨다.
   */
  const tfNeedsJudgment = (entry: TaskforceLedgerEntry, commodoreId: string): boolean => {
    const speakerId = entry.speaker.kind === "commodore" ? entry.speaker.commodoreId : undefined;
    if (speakerId === commodoreId) return false;
    if (entry.actions?.length && !entry.text) return false;
    const mentioned = entry.mentions.filter((id) => id !== speakerId);
    return !mentioned.length || mentioned.includes(commodoreId);
  };

  /** 재기동 재실음 — 읽지 않은 TF 원장이 있으면 판단으로 깨운다. 기록 위치(readSeq)가 남아 판단은 겹치지 않는다. */
  const requeueTaskforce = (runner: Runner) => {
    if (!deps.taskforce) return;
    let wakeable = false;
    for (const tf of memberTaskforces(runner.commodoreId)) {
      let state: TaskforceState | null = null;
      let left = 0;
      try { state = deps.taskforce.read(tf.id); left = deps.taskforce.pending(tf.id, runner.commodoreId).filter((entry) => tfNeedsJudgment(entry, runner.commodoreId)).length; } catch { continue; }
      // 연쇄 제한으로 멈춘 TF의 남은 말은 깨우지 않는다 — 사람의 말·continue가 열 때까지 판단하지 않는다.
      if (!state || state.chain.paused || !left) continue;
      judgingAdd(tf.id, runner.commodoreId);
      wakeable = true;
    }
    if (wakeable) wake(runner, "taskforce");
  };

  /** 판단으로 깨울 TF — 연쇄 제한으로 멈추지 않았으며 읽지 않은 원장이 있다. */
  const tfWakeable = (commodoreId: string): boolean => {
    if (!deps.taskforce) return false;
    for (const tf of memberTaskforces(commodoreId)) {
      try {
        const state = deps.taskforce.read(tf.id);
        if (!state || state.chain.paused) continue;
        if (deps.taskforce.pending(tf.id, commodoreId).some((entry) => tfNeedsJudgment(entry, commodoreId))) return true;
      } catch { continue; }
    }
    return false;
  };

  /** TF 입력을 세션 교체 전에 준비한다 — 이미지도 1:1 메시지와 같은 턴·세션 예산에 센다. */
  const prepareTaskforceTurn = (commodoreId: string, mailChars: number, messageImageBytes: number) => {
    // 새 말은 mail과 같은 글자 예산으로 순서대로 싣고 초과분은 다음 턴에 남긴다.
    // 이미지 예산으로 세션 교체가 정해진 뒤, 새 세션 첫 턴에만 읽은 이력을 덧붙인다.
    // 새 말은 자르지 않고, 읽은 이력의 이미지는 다시 보내지 않는다.
    let tfChars = mailChars;
    let tfImageBytes = 0;
    let tfImageBase64Bytes = 0;
    const blocks: { readonly id: string; readonly head: string; readonly watermark: number; readonly lines: readonly string[] }[] = [];
    const tfImages: NonNullable<CommodoreTurnInput["taskforceImages"]>[number][] = [];
    const tfWatermark = new Map<string, number>();
    const tfTakeSeqs = new Map<string, number[]>();
    const tfContextSeqs = new Map<string, number[]>();
    const taskforce = tfEnabled() ? deps.taskforce : undefined;
    if (taskforce) {
      for (const tf of memberTaskforces(commodoreId)) {
        let state: TaskforceState | null = null;
        try { state = taskforce.read(tf.id); } catch { continue; }
        if (!state) continue;
        const watermark = state.readSeq[commodoreId] ?? 0;
        tfWatermark.set(tf.id, watermark);
        const take: { readonly seq: number; readonly line: string }[] = [];
        // 멈춤 TF는 읽은 이력만 보여 준다 — 사람의 말·continue가 열 때까지 새 판단은 하지 않는다.
        if (!state.chain.paused) {
          let pendingEntries: readonly TaskforceLedgerEntry[] = [];
          try { pendingEntries = taskforce.pending(tf.id, commodoreId); } catch { continue; }
          for (const entry of pendingEntries) {
            let line = tfEntryLine(entry);
            if (tfChars + line.length > MAX_COMMODORE_TURN_MESSAGE_CHARS) break;
            let entryBytes = (entry.images ?? []).reduce((bytes, image) => bytes + image.size, 0);
            let images: Extract<AgentInputBlock, { type: "image" }>[] = [];
            // 과거의 발언 하나가 턴 상한보다 크면 텍스트만 싣고 생략을 밝힌다(무한 재깨움 방어).
            if (entryBytes <= MAX_COMMODORE_MESSAGE_IMAGE_BYTES) {
              if (messageImageBytes + tfImageBytes + entryBytes > MAX_COMMODORE_TURN_IMAGE_BYTES) break;
              const loaded = (entry.images ?? []).map((image) => {
                const found = taskforce.readImage(tf.id, entry.seq, image.id);
                if (!found) throw new Error("attachment_not_found");
                return found;
              });
              entryBytes = loaded.reduce((bytes, image) => bytes + image.bytes.byteLength, 0);
              if (entryBytes <= MAX_COMMODORE_MESSAGE_IMAGE_BYTES) {
                if (messageImageBytes + tfImageBytes + entryBytes > MAX_COMMODORE_TURN_IMAGE_BYTES) break;
                images = loaded.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.bytes.toString("base64") } }));
              }
            }
            if (entryBytes > MAX_COMMODORE_MESSAGE_IMAGE_BYTES) {
              line += " (images omitted: exceeds 8 MiB message limit)";
              entryBytes = 0;
            }
            tfChars += line.length;
            tfImageBytes += entryBytes;
            tfImageBase64Bytes += images.reduce((bytes, image) => bytes + image.source.data.length, 0);
            take.push({ seq: entry.seq, line });
            if (images.length) tfImages.push({ taskforceId: tf.id, seq: entry.seq, images });
          }
        }
        blocks.push({ id: tf.id, head: tfHeadLine(tf, state.chain.paused ? "chain paused; reminder only, do not speak" : undefined), watermark, lines: take.map((entry) => entry.line) });
        tfTakeSeqs.set(tf.id, take.map((entry) => entry.seq));
      }
    }
    const formatPrompt = (freshSession: boolean): string[] => {
      let historyChars = 0;
      return blocks.flatMap(({ id, head, watermark, lines }) => {
        const history: string[] = [];
        const historySeqs: number[] = [];
        // 새 세션만 TF별 최근 20항목, 턴 전체 8,000자. 오래된 쪽부터 버리고 경계 항목을 자른다.
        // 블록이 있을 때만 돈다 — 실험이 꺼져 있으면 블록이 비어 여기는 닿지 않는다.
        if (freshSession && deps.taskforce) try {
          const page = deps.taskforce.readLedger(id, { limit: 20, before: watermark + 1 });
          for (const entry of [...page.entries].reverse()) {
            const remaining = 8000 - historyChars;
            const marker = " …[history truncated]";
            if (remaining <= marker.length + 1) break;
            const line = tfEntryLine(entry);
            const clipped = line.length + 1 > remaining;
            const shown = clipped ? line.slice(0, remaining - marker.length - 1) + marker : line;
            history.unshift(shown);
            historySeqs.unshift(entry.seq);
            historyChars += shown.length + 1;
            if (clipped) break;
          }
        } catch { /* 읽은 이력이 없어도 새 말은 싣는다. */ }
        tfContextSeqs.set(id, historySeqs);
        return history.length || lines.length ? [[
          head,
          ...(history.length ? ["Recent conversation reminder (already read; not new utterances):", ...history] : []),
          ...(lines.length ? ["New ledger entries (judge once; your own entries are context only):", ...lines] : []),
        ].join("\n")] : [];
      });
    };
    return { formatPrompt, tfImages, tfWatermark, tfTakeSeqs, tfContextSeqs, tfImageBytes, tfImageBase64Bytes };
  };

  const runTurn = async (runner: Runner): Promise<void> => {
    if (runner.stopping || disposed) return;
    if (!canRun(runner.commodoreId)) return;
    if (runner.inflight) return runner.inflight;
    if (!runner.pending.size) return;
    tfWaits.delete(runner.commodoreId);
    // 읽지 않은 판단 항목 없는 taskforce 깨움은 턴을 세우지 않는다 — 이유를 걷고 판단 중에서도
    // 뺀다(빈 깨움 턴의 1:1 기록·유료 호출을 아낀다). 남은 이유가 없으면 쉰다.
    if (runner.pending.has("taskforce") && deps.taskforce && !tfWakeable(runner.commodoreId)) {
      runner.pending.delete("taskforce");
      let memberIds: readonly string[] = [];
      try { memberIds = deps.taskforce.list().filter((tf) => tf.members.includes(runner.commodoreId)).map((tf) => tf.id); } catch { /* 읽을 수 없으면 다음 기회에 */ }
      for (const tfId of memberIds) {
        let left = 0;
        try { left = deps.taskforce.pending(tfId, runner.commodoreId).filter((entry) => tfNeedsJudgment(entry, runner.commodoreId)).length; } catch { continue; }
        if (!left) judgingDropQuiet(tfId, runner.commodoreId);
      }
      if (!runner.pending.size) { setPhase(runner, "idle"); scheduleRoutines(runner); return; }
    }
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
      // 배치의 글자 상한은 문맥 크기 방어다. 남은 말은 다음 턴에 싣는다.
      // 사람·mail·TF가 턴 상한을 나눈다 — 각자 따로 고르면 합쳐서 초과한다.
      let mailChars = 0;
      let mailBytes = 0;
      let mailCount = 0;
      for (const entry of runner.mail) {
        const bytes = entry.imageBytes ?? 0;
        if (batchChars + mailChars + entry.text.length > MAX_COMMODORE_TURN_MESSAGE_CHARS || batchBytes + mailBytes + bytes > MAX_COMMODORE_TURN_IMAGE_BYTES) break;
        mailChars += entry.text.length;
        mailBytes += bytes;
        mailCount += 1;
      }
      let taskforceInput: ReturnType<typeof prepareTaskforceTurn>;
      const selected = runner.messages.slice(0, batchCount);
      let preparedMessages: (string | { text: string; images: Extract<AgentInputBlock, { type: "image" }>[] })[] = [];
      let preparedMail: readonly Extract<CommodoreTranscriptEntry, { kind: "received" }>[] = [];
      let mailImages: readonly { readonly messageId: string; readonly images: readonly Extract<AgentInputBlock, { type: "image" }>[] }[] = [];
      let mailBase64Bytes = 0;
      let session = runner.session;
      try {
        // 교대 — 좌표·언어가 바뀌었거나 이미지 예산을 넘었거나 마지막 턴 뒤 1시간이 지났거나 재시작 뒤다. 새 세션은 최근 행위 요약으로 연다.
        // 문맥 길이는 교대 사유가 아니다 — 세션이 스스로 압축해 이어 간다. 유휴 교대는 따로 알리지 않고 원래 깨운 그 턴에 새 세션을 쓴다.
        preparedMessages = selected.map((message) => {
          if (!message.attachments?.length) return message.text;
          if (!deps.attachments || !message.messageId) throw new Error("attachment_not_found");
          const images = deps.attachments.read(runner.commodoreId, message.messageId);
          if (images.length !== message.attachments.length || images.some((image, index) => image.id !== message.attachments![index]!.id)) throw new Error("attachment_not_found");
          return { text: `${message.text}\n\nAttached images for this turn (copy with attachmentIds in add or edit_brief before the turn ends; do not reconstruct them as text):\n${images.map((image, index) => `${index + 1}. ${image.id}`).join("\n")}`, images: images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mime, data: Buffer.from(image.bytes).toString("base64") } })) };
        });
        batchBase64Bytes = preparedMessages.reduce((total, message) => total + (typeof message === "string" ? 0 : message.images.reduce((bytes, image) => bytes + image.source.data.length, 0)), 0);
        // 사령관 연락의 이미지 — 사람 메시지와 같은 턴·세션 예산에 센다. 사본은 수신 때 저장소에서 받았다.
        // 원본을 잃은 mail 한 건이 큐 전체를 막지 않게 텍스트만 전달하고 받은 처리를 확정한다(복사는 attachment_not_available).
        const mailSelected = runner.mail.slice(0, mailCount);
        const loadedMail = mailSelected.map((entry) => {
          if (!entry.attachments?.length) return { entry, images: [] as Extract<AgentInputBlock, { type: "image" }>[] };
          if (!entry.messageId) return { entry: { ...entry, attachments: undefined, imageBytes: undefined, text: `${entry.text}\n(images omitted: original expired before delivery)` }, images: [] as Extract<AgentInputBlock, { type: "image" }>[] };
          try {
            const stored = entry.attachments.map((attachment) => {
              const image = deps.store.images.read(runner.commodoreId, entry.messageId!, attachment.id);
              if (!image || image.id !== attachment.id) throw new Error("attachment_not_found");
              return image;
            });
            if (stored.length !== entry.attachments.length) throw new Error("attachment_not_found");
            const blocks = stored.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mime, data: Buffer.from(image.bytes).toString("base64") } }));
            return { entry, images: blocks };
          } catch {
            return { entry: { ...entry, attachments: undefined, imageBytes: undefined, text: `${entry.text}\n(images omitted: original expired before delivery)` }, images: [] as Extract<AgentInputBlock, { type: "image" }>[] };
          }
        });
        preparedMail = loadedMail.map(({ entry }) => entry);
        mailImages = loadedMail.filter(({ images }) => images.length).map(({ entry, images }) => ({ messageId: entry.messageId!, images }));
        mailBase64Bytes = loadedMail.reduce((total, { images }) => total + images.reduce((bytes, image) => bytes + image.source.data.length, 0), 0);
        batchBytes += mailBytes;
        batchBase64Bytes += mailBase64Bytes;
        taskforceInput = prepareTaskforceTurn(runner.commodoreId, batchChars + mailChars, batchBytes);
        batchBytes += taskforceInput.tfImageBytes;
        batchBase64Bytes += taskforceInput.tfImageBase64Bytes;
        const sizedOut = session !== null && (coordinatesChanged(runner) || runner.sessionImageBytes + batchBytes > MAX_COMMODORE_SESSION_IMAGE_BYTES || runner.sessionImageBase64Bytes + batchBase64Bytes > MAX_COMMODORE_SESSION_IMAGE_BASE64_BYTES);
        const idleExpired = session !== null && runner.lastTurnAt !== null && now() - runner.lastTurnAt > COMMODORE_IDLE_ROTATE_MS;
        const rotate = runner.rotateNext ?? (sizedOut || idleExpired ? "replaced" : null);
        const silentIdle = runner.rotateNext === null && !sizedOut && idleExpired;
        if (session && rotate) { await session.dispose(); session = null; runner.session = null; }
        if (!session) {
          const event = rotate ?? "opened";
          session = await openSession(runner, event);
          runner.rotateNext = null;
          if (event === "replaced" && !silentIdle) wake(runner, "rotated");
        }
      } catch (error) {
        if (runner.stopping) return;
        scheduleRetry(runner, failureCode(error, "session_failed"));
        return;
      }
      // 여는 동안 꺼졌다 — 막 연 세션은 stop() 이 거둔다. 턴도 상태 방송도 하지 않는다.
      if (runner.stopping) return;
      const { tfImages, tfWatermark, tfTakeSeqs, tfContextSeqs } = taskforceInput;
      const tfPrompt = taskforceInput.formatPrompt(runner.sessionFirstTurn);
      // 이유는 세션이 열린 뒤에 거둔다 — 열지 못하면 그대로 남아 재시도 턴에 실린다. 보드 대기 상태의 수는 지금 보드에서 다시 센다
      // (모인 동안 사령관 자신이 완료한 목표는 빠진다); 그새 사라진 대기 상태는 이유에서 내린다.
      const digest = runner.board?.recount() ?? new Map();
      const routines = deps.store.read(runner.commodoreId)?.routines ?? [];
      const due = routines.filter((r) => r.enabled && (runner.routineTimes.get(r.id)?.at ?? Infinity) <= now());
      if (due.length && !runner.pending.has("routine")) runner.pending.set("routine", { details: [] });
      const pending = [...runner.pending.entries()].flatMap(([code, reason]): [WakeCode, PendingReason][] => {
        if (code === "routine") {
          // 소비한 일회성은 재시도하되, 사람이 그새 끄거나 지운 반복 루틴은 실행하지 않는다.
          const attempts = new Map((reason.routines ?? []).flatMap((attempt) => {
            const current = routines.find((r) => r.id === attempt.id);
            return current?.enabled ? [[attempt.id, { ...attempt, name: current.name, task: current.task }] as const]
              : !current && attempt.once ? [[attempt.id, attempt] as const] : [];
          }));
          for (const routine of due) attempts.set(routine.id, { id: routine.id, name: routine.name, task: routine.task, once: routine.schedule.kind === "once" });
          const selected = [...attempts.values()];
          return selected.length ? [[code, { details: selected.map((r) => `${r.name}: ${r.task}`), routines: selected }]] : [];
        }
        if (!BOARD_CODES.has(code)) return [[code, reason]];
        const count = digest.get(code as CommodoreBoardWakeCode) ?? 0;
        return count ? [[code, { ...reason, count }]] : [];
      });
      runner.pending.clear();
      if (!pending.length) { setPhase(runner, "idle"); scheduleRoutines(runner); return; }
      if (due.length) {
        const previous = new Map(runner.routineTimes);
        for (const routine of due) runner.routineTimes.delete(routine.id);
        try { deps.store.routinesRun(runner.commodoreId, due.map((r) => r.id)); }
        catch (error) {
          runner.routineTimes = previous;
          for (const [code, reason] of pending) runner.pending.set(code, reason);
          scheduleRetry(runner, failureCode(error, "routine_save_failed"));
          return;
        }
      }
      const messages = runner.messages.splice(0, batchCount);
      const reasons = pending.map(([code, reason]) => wakeToken(code, reason.count));
      const notices = (deps.store.read(runner.commodoreId)?.routineNotices ?? []).slice(0, 20);
      const sentences = [...pending.map(([code, reason]) => wakeSentence(code, reason)), ...notices.map((n) => `The person removed routine "${n.name}". Do not recreate it without their request.`)];
      const scope = runner.board?.scope(new Map(pending.map(([code, reason]) => [code, [...(reason.ids?.keys() ?? [])]])));
      // 깨운 목표(대기 중·정체·맡김)의 보드 요약과 깨우지 않고 모은 단계 이동 — 모델이 이 턴에 읽는다.
      const board = runner.board?.brief([...new Set(pending.flatMap(([, reason]) => [...(reason.ids?.keys() ?? [])]))]) ?? null;
      setPhase(runner, "turn");
      // 실패한 턴도 살아 있는 세션의 CLI 이력에 남을 수 있다 — 재시도 이미지도 예산에 보수적으로 센다.
      runner.sessionImageBytes += batchBytes;
      runner.sessionImageBase64Bytes += batchBase64Bytes;
      const mail = runner.mail.splice(0, mailCount);
      runner.turnMessages = messages;
      runner.turnMail = preparedMail;
      runner.turnSent.clear();
      runner.tfPosts = [];
      // TF 판단 턴 — TF 항목을 싣고 사람의 1:1 메시지·mail·사람에게 말 거는 다른 이유가 없으면 조용하다.
      // 세션 수명주기(교대·재시작·재시도)는 깨움 문장만 보탤 뿐 조용함을 깨지 않는다.
      // 판단 항목이 비어 블록이 비었어도 taskforce로 깬 턴은 조용히 넘긴다(빈 깨움 방어).
      const quiet = !mail.length && !messages.length && pending.length > 0
        && pending.some(([code]) => code === "taskforce")
        && pending.every(([code]) => QUIET_OK_REASONS.has(code));
      // 이 턴 구간의 시작 — 성공한 턴의 보드 쓰기 묶음을 여기서부터 모은다.
      const turnStartSeq = (() => {
        try { return deps.store.transcriptRead(runner.commodoreId, { limit: 1 }).entries[0]?.seq ?? 0; }
        catch { return 0; }
      })();
      let outcome: CommodoreTurnOutcome;
      try {
        const openUIFeedback = runner.openUIFeedback;
        runner.openUIFeedback = undefined;
        runner.sessionFirstTurn = false;
        outcome = await session.turn({ reasons, sentences, ...(openUIFeedback ? { openUIFeedback } : {}), ...(scope ? { scope } : {}), ...(board ? { board } : {}), ...firstTurnSummary(runner), ...(messages.length ? { messages: preparedMessages } : {}), ...(mail.length ? { mail: preparedMail } : {}), ...(mailImages.length ? { mailImages } : {}), ...(tfPrompt.length ? { taskforce: tfPrompt } : {}), ...(tfImages.length ? { taskforceImages: tfImages } : {}), ...(quiet ? { quietText: true as const } : {}) });
        // 실패·취소된 시도는 다시 실릴 수 있다. 전하지 않았다는 판정은 성공한 턴에서만 확정한다.
        if (outcome.outcome === "ok") for (const message of runner.turnMessages) if (message.mentions?.length) record(runner, { kind: "mention-result", messageSeq: message.seq, unrelayed: message.mentions.filter((peer) => !runner.turnSent.has(peer.id)) });
      } finally { runner.turnMessages = []; runner.turnMail = []; }
      if (outcome.outcome === "ok") {
        for (let at = 0; at < mail.length; at += MAX_TRANSCRIPT_PAGE) record(runner, { kind: "received-read", seqs: mail.slice(at, at + MAX_TRANSCRIPT_PAGE).map((entry) => entry.seq) });
        // 받은 처리 확정 뒤 명시적 회수 — 보호가 풀린 사본의 초과분을 다음 저장까지 남기지 않는다.
        if (mail.length) { try { deps.store.images.trim(runner.commodoreId); } catch { /* 다음 정리에 다시 거둔다. */ } }
      } else runner.mail.unshift(...mail);
      if (outcome.outcome === "ok") {
        releaseMessages(runner, messages);
        // 알림 확인 저장 실패는 성공한 작업을 재실행하지 않는다. 남은 알림은 다음 턴에 다시 실린다.
        try { deps.store.routineNoticesRead(runner.commodoreId, notices.map((n) => n.id)); }
        catch { record(runner, { kind: "error", code: "routine_save_failed" }); }
        // TF — 읽은 위치를 전진시킨다(실패하면 그대로 두어 다음 턴이 다시 싣는다).
        // 말 없이 끝낸 성원은 silent로, 말한 성원은 말할 때 이미 spoke로 남았다.
        if (deps.taskforce) {
          const posted = new Set(runner.tfPosts.map((post) => post.taskforceId));
          for (const [tfId, watermark] of tfWatermark) {
            const included = [...(tfTakeSeqs.get(tfId) ?? []), ...(tfContextSeqs.get(tfId) ?? [])].sort((a, b) => a - b);
            let through = watermark;
            for (const seq of included) { if (seq === through + 1) through = seq; else if (seq > through + 1) break; }
            if (through > watermark) {
              try { deps.taskforce.advanceReadSeq(tfId, runner.commodoreId, through); }
              catch (error) { console.warn(`[objectives] taskforce read advance failed: ${error instanceof Error ? error.message : String(error)}`); }
            }
            if (!posted.has(tfId) && ((tfTakeSeqs.get(tfId)?.length ?? 0) + (tfContextSeqs.get(tfId)?.length ?? 0) > 0)) recordTfOutcome(tfId, runner.commodoreId, "silent");
          }
          // 같은 턴에 말하고 보드도 쓴 성원의 묶음 — 그 말 아래에 덧붙인다.
          const writes = collectTurnBoardWrites(runner.commodoreId, turnStartSeq);
          if (writes.length && runner.tfPosts.length) {
            for (let at = 0; at < writes.length; at += 8) {
              const actions = writes.slice(at, at + 8);
              for (const post of runner.tfPosts) {
                try { deps.taskforce.appendActions(post.taskforceId, runner.commodoreId, { actions, replyTo: post.seq }); }
                catch (error) { console.warn(`[objectives] taskforce actions append failed: ${error instanceof Error ? error.message : String(error)}`); }
              }
            }
          }
        }
      }
      noteOutcome(runner, outcome);
      refreshContextDetail(runner);
      /** 실패·취소된 TF 턴의 항목은 다시 줄을 선다 — 말한 성원은 말할 때 이미 spoke로 남았다. */
      const markTurnTfFailed = () => {
        if (!deps.taskforce) return;
        const posted = new Set(runner.tfPosts.map((post) => post.taskforceId));
        for (const tfId of tfWatermark.keys()) {
          if (posted.has(tfId)) continue;
          if ((tfTakeSeqs.get(tfId)?.length ?? 0) + (tfContextSeqs.get(tfId)?.length ?? 0) === 0) continue;
          recordTfFailed(tfId, runner.commodoreId);
        }
      };
      if (runner.stopping) {
        // 끄기로 끝나지 못한 턴의 메시지도 stop()이 표시한다. 성공한 턴은 이미 전달됐으므로 제외한다. 남는 대화라도 끊긴 턴의 말이 그
        // 대화에 닿았는지는 모른다(자식이 기록하기 전에 접혔을 수 있다) — 성공을 듣기 전까지는 다시 보낼 수 있게 둔다. 겹쳐 읽는 쪽이 잃는 쪽보다 낫다.
        if (outcome.outcome !== "ok") { runner.messages.unshift(...messages); keepUnheard(runner, pending); markTurnTfFailed(); }
        return;
      }
      if (outcome.outcome !== "ok") {
        markTurnTfFailed();
        for (const [code, reason] of pending) {
          const existing = runner.pending.get(code);
          if (!existing) runner.pending.set(code, reason);
          else if (code === "routine") {
            // 턴 중 새 루틴이 깨웠어도 이미 소비한 일회성의 실패 시도를 잃지 않는다.
            existing.routines = [...new Map([...(reason.routines ?? []), ...(existing.routines ?? [])].map((attempt) => [attempt.id, attempt])).values()];
          }
        }
        runner.messages.unshift(...messages);
        if (outcome.error === "session_disposed" || outcome.error === "session_failed") { runner.session = null; }
        // 요약이 실패한 채 턴이 오류로 끝난 세션은 넘친 대화를 그대로 안고 있다 — 같은 세션으로 다시 시도하면 같은 오류다.
        // 다음 시도는 최근 행위 요약으로 새 세션을 연다. 요약만 실패하고 턴이 끝난 세션은 다음 턴에 자식이 다시 요약한다.
        else if (outcome.outcome === "error" && outcome.compactionFailed) { runner.rotateNext ??= "replaced"; }
        scheduleRetry(runner, outcome.error ?? "turn_failed");
        return;
      }
      if (runner.messages.length) wake(runner, "message");
      if (runner.mail.length) wake(runner, "mail");
      // TF 초과분(글자 상한에 잘린 말)은 다음 턴에 싣는다. 연쇄 제한으로 멈춘 TF의 남은 말은 깨우지 않는다.
      if (tfWakeable(runner.commodoreId)) wake(runner, "taskforce");
      runner.retryAttempt = 0;
      setPhase(runner, "idle");
      scheduleRoutines(runner);
    })().finally(() => {
      runner.inflight = null;
      // 턴 중에 온 이유는 다음 턴 하나로.
      if (runner.pending.size && !runner.stopping && !disposed && runner.phase !== "retrying" && runner.phase !== "error") scheduleTurn(runner);
    });
    return runner.inflight;
  };

  const noteOutcome = (runner: Runner, outcome: CommodoreTurnOutcome) => {
    runner.lastTurnAt = now();
    // 대화 크기는 마지막 호출의 입력이다 — 턴 합계는 도구를 쓴 만큼 부풀고 압축으로 줄어든 대화를 말하지 못한다.
    if (outcome.usage) runner.lastInputTokens = outcome.usage.contextTokens ?? outcome.usage.inputTokens;
    // Gateway 모델 세션의 압축 지점(Gateway 정책과 요청 상한 중 이른 쪽)은 호스트가 토큰과 같은 단위로 알려 주면 그것을 쓴다.
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

  /**
   * 턴이 끝난 세션에서 범주별 문맥 내역을 다시 받아 방송한다. 응답이 느리거나(자식의 control 왕복) 못 받아도 턴은 이미 끝났다 —
   * 그 사이 세션이 바뀌었으면 낡은 값을 싣지 않는다. 얻지 못하면 직전 내역을 그대로 둔다(없는 값을 꾸미지 않는다).
   */
  const refreshContextDetail = (runner: Runner) => {
    const session = runner.session;
    if (!session || runner.stopping || disposed) return;
    void session.contextUsage().then((usage) => {
      if (!usage || runner.session !== session || disposed) return;
      runner.contextDetail = {
        total: usage.total, max: usage.max, ...(usage.reserved !== undefined ? { reserved: usage.reserved } : {}),
        slices: usage.slices, memoryFiles: usage.memoryFiles, mcpTools: usage.mcpTools, skills: usage.skills,
      };
      publish(runner);
    }, () => undefined);
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
      else if (entry.kind === "tool" && entry.action && entry.ok !== false && BOARD_WRITE_TOOL_NAMES.has(entry.name)) actions += 1;
      else if (entry.kind === "result") {
        results.push(`${new Date(entry.at).toISOString()}: ${entry.outcome}${entry.error ? ` (${entry.error})` : ""}, ${actions} board action${actions === 1 ? "" : "s"}`.slice(0, 200));
        actions = 0;
      }
    }
    return results.slice(-RECENT_ACTIONS);
  };

  const start = (commodoreId: string, reason: WakeCode, wakeImmediately = true, carried?: CommodoreUnheardWakes | null) => {
    if (disposed || clears.has(commodoreId) || stops.has(commodoreId) || !canRun(commodoreId)) return;
    let runner = runners.get(commodoreId);
    if (runner && !runner.stopping) return;
    // 기동 자체는 깨움이 아니다 — 지난 종료가 듣지 못했다고 남긴 보드 깨움만 다시 본다. Clear 는 지우기 전에 읽어 건넨다.
    const unheard = carried !== undefined ? carried : unheardOf(commodoreId);
    runner = { commodoreId, contextDetail: null, session: null, sessionFirstTurn: false, phase: "idle", step: null, pending: new Map(), messages: [], mail: [], tfPosts: [], turnSent: new Set(), hosted: new Map(), turnMessages: [], turnMail: [], sessionImageBytes: 0, sessionImageBase64Bytes: 0, coalesce: null, routineTimer: null, routineTimes: new Map(), retry: null, retryAttempt: 0, inflight: null, stopping: false, lastTurnAt: null, lastInputTokens: 0, contextWindow: 0, compactAt: 0, coordinates: null, language: "en", rotateNext: reason === "restart" ? "restarted" : null, recentActions: restoreRecentActions(commodoreId), board: null, stalledReported: new Set(), unheard: { codes: new Set(), ids: new Set(), all: false } };
    const current = runner;
    current.board = deps.board()?.watch(commodoreId, {
      automatic: () => !current.stopping && canRun(commodoreId),
      wake: (code, input) => {
        wake(current, code, input);
        if (input?.objectiveId && input.detail) noteIds(current, code, input.objectiveId, input.detail);
      },
      forget: (objectiveId) => forgetStatus(current, objectiveId),
      stalledChanged: (ids) => { current.stalledReported = new Set(ids); publish(current); },
      unheard,
    }) ?? null;
    runners.set(commodoreId, runner);
    setPhase(runner, "idle");
    scheduleRoutines(runner);
    // 끊긴 빈 보드 알림은 Clear 뒤에도 다시 낸다 — 감시는 기동 때의 빈 보드를 들은 것으로 두므로 여기서 놓치면 다시 오지 않는다.
    if (unheard?.empty && runner.board?.emptyOperated()) wake(runner, "empty");
    // Clear 뒤에는 기존 기록을 되살리지 않는다. 재시작 자체는 깨움 이유가 아니다.
    if (!wakeImmediately) { if (reason === "message") requeueUndelivered(runner); return; }
    requeueUndelivered(runner);
    requeueMail(runner);
    requeueTaskforce(runner);
    // 자율 운영이 꺼진 동안 사람이 답한 질문 — 사령관이 아직 읽지 않았다.
    for (const ask of deps.store.read(commodoreId)?.asks ?? []) if (ask.settled?.outcome === "answered" && ask.readAt === undefined) wake(runner, "answered", { bump: true, detail: askDetail(ask.questions[0]?.text ?? ask.id) });
  };

  /**
   * 지난번 끌 때 「전달되지 않음」으로 남은 사람의 메시지를 대기열에 다시 싣는다 — 새 대화에서도 그 말을 잃지 않는다.
   * 이미지가 붙은 말은 끌 때 보관이 풀려 다시 싣지 못한다(그대로 「전달되지 않음」이다).
   */
  const mentionsOf = (entry: Extract<CommodoreTranscriptEntry, { kind: "message" }>) =>
    (entry.references ?? []).flatMap((ref) => ref.kind === "commodore" ? [{ id: ref.id, alias: ref.title }] : []);

  /** 마지막 session 줄과 그 앞 unheard 줄들이 다 들어올 때까지 앞쪽 쪽을 더 읽는다 — 긴 세션 뒤의 비정상 종료도 폴백을 잃지 않는다. */
  const unheardOf = (commodoreId: string): CommodoreUnheardWakes | null => {
    try {
      let entries: CommodoreTranscriptEntry[] = [];
      let before: number | undefined;
      for (;;) {
        const page = deps.store.transcriptRead(commodoreId, { limit: MAX_TRANSCRIPT_PAGE, ...(before !== undefined ? { before } : {}) });
        entries = [...page.entries, ...entries];
        const last = entries.findLastIndex((entry) => entry.kind === "session");
        const settled = last >= 0 && entries.slice(0, last).some((entry) => entry.kind !== "unheard");
        if (settled || !page.hasMore || !page.entries.length) return unheardWakes(entries);
        before = page.entries[0]!.seq;
      }
    } catch { return null; }
  };

  const requeueMail = (runner: Runner) => {
    runner.mail.push(...deps.store.pendingReceived(runner.commodoreId));
    if (runner.mail.length) wake(runner, "mail");
  };

  const requeueUndelivered = (runner: Runner) => {
    let entries: readonly CommodoreTranscriptEntry[];
    try { entries = deps.store.transcriptRead(runner.commodoreId, { limit: MAX_TRANSCRIPT_PAGE }).entries; }
    catch { return; }
    const waiting = undeliveredMessageSeqs(entries);
    const messages = entries.flatMap((entry) => (entry.kind === "message" && waiting.has(entry.seq) && !entry.attachments?.length ? [entry] : []));
    if (!messages.length) return;
    for (const entry of messages) runner.messages.push({ seq: entry.seq, text: messagePromptText(entry), mentions: mentionsOf(entry) });
    record(runner, { kind: "requeued", seqs: messages.map((entry) => entry.seq) });
    wake(runner, "message");
  };

  const stop = (commodoreId: string, reason: string): Promise<void> => {
    const previous = stops.get(commodoreId);
    const runner = runners.get(commodoreId);
    if (!runner) return previous ?? Promise.resolve();
    if (previous) return previous;
    runner.stopping = true;
    runner.board?.dispose();
    clearTimer(runner, "coalesce"); clearTimer(runner, "routineTimer"); clearTimer(runner, "retry");
    keepUnheard(runner, runner.pending);
    runner.pending.clear();
    runner.nextWakeAt = undefined;
    runner.session?.cancel();
    if (!runner.inflight) setPhase(runner, "off", reason);
    const work = (async () => {
      try { await runner.inflight; } catch { /* 턴 결말은 세션이 삼킨다 */ }
      runner.board?.dispose();
      // 세션이 아직 읽지 않은 주입 메시지도 폐기 전에 보존한다. dispose 뒤의 SDK 사건은 세션이 받지 않는다.
      runner.messages.push(...runner.hosted.values());
      runner.hosted.clear();
      runner.messages.sort((a, b) => a.seq - b.seq);
      const undelivered = takeUndelivered(runner);
      for (let index = 0; index < undelivered.length; index += MAX_TRANSCRIPT_PAGE) record(runner, { kind: "undelivered", seqs: undelivered.slice(index, index + MAX_TRANSCRIPT_PAGE) });
      // stopped 바로 앞에 둔다 — 다음 기동은 마지막 stopped 앞의 이 줄만 읽는다.
      const { codes, ids, all } = runner.unheard;
      if (codes.size) record(runner, { kind: "unheard", codes: [...codes], ...(ids.size && ids.size <= MAX_SCOPE_ITEMS ? { objectiveIds: [...ids] } : {}), ...(all || ids.size > MAX_SCOPE_ITEMS ? { all: true as const } : {}) });
      record(runner, { kind: "session", event: "stopped", reason });
      await runner.session?.dispose();
      runner.session = null;
      // 정지·종료 뒤에도 대기·진행 중 보호는 유지한 채 초과분을 회수한다.
      try { deps.store.images.trim(commodoreId); } catch { /* 다음 정리에 다시 거둔다. */ }
      setPhase(runner, "off", reason);
    })().finally(() => {
      if (runners.get(commodoreId) === runner) runners.delete(commodoreId);
      if (stops.get(commodoreId) === work) stops.delete(commodoreId);
      // 종료하는 동안 실행 조건이 돌아왔으면 이전 세션을 거둔 뒤 시작한다.
      if (!disposed && !clears.has(commodoreId) && canRun(commodoreId)) start(commodoreId, "started");
    });
    stops.set(commodoreId, work);
    return work;
  };

  const sync = (reason: WakeCode = "started") => {
    if (disposed) return;
    const wanted = new Set<string>();
    for (const commodoreId of deps.store.availableCommodores()) if (canRun(commodoreId)) wanted.add(commodoreId);
    for (const commodoreId of runners.keys()) {
      if (!canRun(commodoreId)) void stop(commodoreId, "experiment or board unavailable");
    }
    for (const commodoreId of wanted) start(commodoreId, reason);
  };

  // 설명·정보·메시지·좌표 — 저장소 사건이 깨움 이유다.
  cleanups.push(deps.store.subscribe((event) => {
    let runner = runners.get(event.commodoreId);
    if (event.op === "state") {
      if (event.change === "created") { sync(); return; }
      if (!runner) return;
      if (event.change === "routines") { scheduleRoutines(runner); return; }
      if (event.change === "description") wake(runner, "description", { detail: `rev ${event.state.description.rev}` });
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
      else if (event.change === "coordinates" || event.change === "plugins") { runner.rotateNext ??= "replaced"; }
      return;
    }
    // 사람이 사령관의 질문에 답했다 — 답은 asks 도구로 읽는다(깨움 문장에는 싣지 않는다).
    if (event.op === "transcript" && event.entry.kind === "ask-answered" && runner) { wake(runner, "answered", { bump: true, detail: askDetail(event.entry.answers[0]?.question ?? event.entry.askId) }); return; }
    if (event.op === "transcript" && event.entry.kind === "sent" && event.entry.ok && runner?.phase === "turn") runner.turnSent.add(event.entry.to.id);
    if (event.op === "transcript" && event.entry.kind === "received") {
      // 새 실행기는 기록에서 복원하므로 현재 사건을 중복해서 넣지 않는다.
      if (!runner) { start(event.commodoreId, "mail"); return; }
      if (!runner.stopping) { runner.mail.push(event.entry); wake(runner, "mail"); }
      return;
    }
    if (event.op === "transcript" && event.entry.kind === "message") {
      // 첫 메시지가 실행기를 세울 때도 같은 사건 감시 경계를 쓴다.
      if (!runner) { start(event.commodoreId, "message", false); runner = runners.get(event.commodoreId); }
      if (!runner) return;
      const { entry } = event;
      const text = messagePromptText(entry);
      const message: QueuedMessage = { seq: entry.seq, text, mentions: mentionsOf(entry), ...(entry.messageId ? { messageId: entry.messageId, attachments: entry.attachments, imageBytes: entry.imageBytes } : {}) };
      // 턴이 돌고 있으면 그 턴에 건넨다 — 다음 도구 경계에서 같은 턴이 읽는다. 이미지가 붙은 말은 보관·예산을 지는 다음 턴에 싣는다.
      const id = `m${entry.seq}`;
      if (!message.messageId && runner.phase === "turn" && !runner.stopping && runner.session?.steer(text, id)) { runner.hosted.set(id, message); return; }
      runner.messages.push(message); wake(runner, "message");
    }
  }));

  // TaskForce 원장 사건 — Console이 유일한 쓰는 쪽이라 잠금 없이 읽는다. 도는 턴에는 절대
  // steer하지 않고 다음 턴 이유에만 모은다. 연쇄 제한으로 멈춘 TF는 깨우지 않는다.
  if (deps.taskforce) cleanups.push(deps.taskforce.subscribe((event) => {
    if (disposed) return;
    const taskforce = deps.taskforce!;
    if (event.op === "taskforce-removed") { tfJudging.delete(event.taskforceId); tfOutcomes.delete(event.taskforceId); return; }
    if (event.op !== "taskforce-ledger") return;
    const { entry } = event;
    // 보드 쓰기 묶음은 렌더용 — 깨우지도 chain에 세지도 않는다.
    if (entry.actions?.length && !entry.text) return;
    let state: TaskforceState | null = null;
    try { state = taskforce.read(event.taskforceId); } catch { return; }
    if (!state) return;
    // 말한 성원은 판단이 끝났다.
    const speaker = entry.speaker.kind === "commodore" ? entry.speaker.commodoreId : undefined;
    if (speaker) recordTfOutcome(event.taskforceId, speaker, "spoke");
    // chain 상한 — TF가 고른 상한에 사령관 발언이 닿으면 멈추고 system 항목을 남긴다. 사람 말이 열 때까지 깨우지 않는다.
    // 상한이 없으면(제한 안 함) 멈추지 않는다.
    if (entry.speaker.kind === "commodore") {
      try {
        const { limit } = state.chain;
        if (limit !== null && state.chain.count >= limit && !state.chain.paused) state = taskforce.pauseChain(event.taskforceId);
      } catch (error) { console.warn(`[objectives] taskforce chain pause failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    }
    const paused = state.chain.paused;
    const targets = new Set<string>();
    // 지목이 있으면 지목된 성원만 깨운다 — 나머지는 읽지 않은 채 남아 다음 깨움에 함께 실린다.
    const mentioned = new Set(entry.mentions.filter((id) => state!.members.includes(id) && id !== speaker));
    const addTargets = (all: boolean) => { for (const member of state!.members) if (member !== speaker && (all || !mentioned.size || mentioned.has(member))) targets.add(member); };
    if (entry.speaker.kind === "person") { addTargets(false); }
    else if (entry.speaker.kind === "commodore") { if (!paused) addTargets(false); }
    else if (entry.speaker.code === "created") { addTargets(true); }
    // 그 외 system 항목은 깨우지 않는다 — 다음 판단에 함께 실린다.
    // 사령관 발언 묶음이 기다릴 성원 — 이 사건 전에 이미 판단 중이던 성원이다(같은 사건으로 같이 깬 성원끼리는 기다리지 않는다).
    const judgingBefore = new Set(tfJudging.get(event.taskforceId) ?? []);
    const tfKind = entry.speaker.kind === "person" ? "person" : entry.speaker.kind === "commodore" ? "commodore" : null;
    for (const member of targets) {
      judgingAdd(event.taskforceId, member);
      const runner = runners.get(member);
      if (!runner || runner.stopping) continue;
      const blockers = new Set([...judgingBefore].filter((id) => id !== member));
      wake(runner, "taskforce", tfKind ? { tf: { kind: tfKind, taskforceId: event.taskforceId, blockers } } : {});
    }
    // 같은 턴에 말한 기록 — 성공한 턴이 보드 쓰기 묶음을 그 말 아래에 덧붙인다.
    if (entry.speaker.kind === "commodore") {
      const runner = runners.get(entry.speaker.commodoreId);
      if (runner?.phase === "turn") runner.tfPosts.push({ taskforceId: event.taskforceId, seq: entry.seq });
    }
  }));

  /** 듣지 못한 보드 깨움을 모은다 — 목표를 가리키지 않는 이유(보드에서 다시 세는 대기 수)는 다음 기동이 모든 대기를 다시 보게 한다. */
  const keepUnheard = (runner: Runner, reasons: Iterable<readonly [WakeCode, PendingReason]>) => {
    for (const [code, reason] of reasons) {
      if (!UNHEARD_CODES.has(code)) continue;
      runner.unheard.codes.add(code);
      if (code === "empty") continue;
      const ids = [...(reason.ids?.keys() ?? [])];
      if (!ids.length) runner.unheard.all = true;
      for (const id of ids) runner.unheard.ids.add(id);
    }
  };
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

  if (deps.subscribeExperiments) cleanups.push(deps.subscribeExperiments(() => sync("started")));

  return {
    replaceSessionNext(commodoreId) {
      const runner = runners.get(commodoreId);
      if (runner) runner.rotateNext ??= "replaced";
    },
    acceptsMessage: (commodoreId) => !disposed && !clears.has(commodoreId) && !stops.has(commodoreId) && canRun(commodoreId),
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
      let carried: CommodoreUnheardWakes | null = null;
      const work = (async () => {
        await stop(commodoreId, "cleared");
        // 새 문맥 — 제품 기록을 지우므로 다음 세션에는 요약도 없다. 끊긴 턴이 듣지 못한 보드 깨움만 지우기 전에 건진다.
        carried = unheardOf(commodoreId);
        deps.store.transcriptClear(commodoreId);
      })().finally(() => {
        clears.delete(commodoreId);
        if (!disposed && canRun(commodoreId)) start(commodoreId, "started", false, carried);
      });
      clears.set(commodoreId, work);
      return work;
    },
    async stopForDeletion(commodoreId) {
      await stop(commodoreId, "deleted");
      await clears.get(commodoreId);
    },
    sync,
    noteProposal(commodoreId, kind, outcome) {
      const runner = runners.get(commodoreId);
      if (!runner) return;
      wake(runner, kind, { bump: true, detail: outcome });
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
