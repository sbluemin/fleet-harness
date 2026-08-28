import { promises as fs } from "node:fs";
import path from "node:path";

import {
  createClaudeGatewaySdk,
  type ClaudeGatewayContextUsage,
  type ClaudeGatewayEffort,
  type ClaudeGatewayAgent,
  type ClaudeGatewayCommand,
  type ClaudeGatewayMessage,
  type ClaudeGatewaySdk,
  type ClaudeGatewaySdkOptions,
  type ClaudeGatewayServedMcpServer,
  type ClaudeGatewaySession,
  type ClaudeGatewaySystemPrompt,
} from "@dotobokuri/core-agent/claude";

import {
  CLAUDE_COMPAT_CONTEXT_WINDOW,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  compactThresholdTokens,
  hasClaudeOneMillionMarker,
  unprojectClaudeContextInputTokens,
  type CompactCeiling,
} from "@dotobokuri/core-ai-gateway";

import {
  AGENT_CHAT_ASK_TOOLS,
  agentChatAskFromToolInput,
  chatEventsFromSdkMessage,
  chatReplayFromTranscriptLine,
  chatShellTailFromOutput,
  chatSubagentTrailFromTranscript,
  readJobKind,
  type AgentChatCatalog,
  type AgentChatCatalogEntry,
  type AgentChatJobDetail,
  type AgentChatJobKind,
  type AgentChatJournalEvent,
  type AgentChatQuestion,
  type AgentChatQueueEntry,
  type AgentChatStreamEvent,
} from "./chat-events.js";
import type { ClaudeSessionHandle } from "@dotobokuri/fleet-admiral";

import { chatChildEnv } from "../shared/launch-env.js";
import type { CapturedAgentSession } from "./types.js";

/**
 * Chat Mode 세션 하나의 서버 소유 상태.
 *
 * PTY가 없다 — 같은 Claude 세션을 core-agent SDK가 **사용자의 실제 Claude 홈에서** 이어받아
 * 돌린다. 트랜스크립트는 터미널이 쓰던 그 파일 하나이고, 이 세션은 그것을 옮기지 않고 그대로
 * 키운다 — Console 재시작·터미널 복귀(--resume)·Session Analyst가 전부 같은 경로 하나를
 * 권위로 삼게 하기 위해서다. 매 턴이 끝나면 좌표만 다시 확정한다.
 */

/**
 * 이 세션이 어디서 시작하는가. `resume`은 이미 있는 트랜스크립트가 세션 id를 말해 주고,
 * `fresh`는 SDK가 첫 턴에 만들어 준 뒤에야 그것을 안다.
 *
 * 둘 다 **같은 파일**을 키운다. Chat Mode와 터미널은 한 세션의 두 얼굴이므로 트랜스크립트도
 * 하나여야 하고, 그래서 SDK는 사용자의 실제 Claude 홈을 그대로 쓴다 — 사본을 따로 키우다
 * 되쓰는 왕복은 원본을 덮어쓸 위험만 남기고 아무것도 사지 못했다.
 */
export type AgentChatSessionOrigin =
  | { readonly kind: "resume"; readonly transcriptPath: string }
  | { readonly kind: "fresh" };

export interface AgentChatSessionSeed {
  readonly baseUrl: string;
  readonly model: string;
  /**
   * 이 모델의 **실제** 문맥 창(카탈로그 값). 자식이 재는 창이 아니다 — 자식은 좌표가 둘뿐이라
   * 500k 모델도 200k라고 답하고, 그 답을 그대로 그리면 화면이 남의 자를 인쇄한다.
   *
   * 부재는 두 가지 뜻이고 둘 다 "손대지 않는다"로 같다: 네이티브 Claude 모델(투영이 애초에 없다)과
   * 카탈로그에 없는 id(무엇으로 되돌릴지 알 수 없다).
   */
  readonly contextWindow?: number;
  /**
   * 자동 압축 시점 정책. 게이트웨이가 usage를 투영할 때 쓴 값과 **같아야** 되돌릴 수 있으므로,
   * 세션이 열릴 때 한 번 고정한다 — 도중에 바뀐 정책으로 이전 정책이 투영한 값을 되돌리면
   * 그 세션의 남은 수명 내내 어긋난다.
   */
  readonly compactCeiling?: CompactCeiling | null;
  readonly effort?: ClaudeGatewayEffort;
  /**
   * 세션 설정 `ultracode`. 퀵런치 트랙의 ULTRACODE가 채팅으로 태어날 때 CLI `--effort ultracode`와
   * 같은 자리로 옮긴다. `effort`와 별개다 — SDK는 강도를 `xhigh`로 받고, 오케스트레이션은 이 플래그가 켠다.
   */
  readonly ultracode?: true;
  readonly cwd: string;
  /**
   * 사용자의 실제 Claude 홈(`CLAUDE_CONFIG_DIR` 또는 `~/.claude`). 터미널로 띄운 CLI가 쓰는
   * 바로 그 홈이며, 트랜스크립트가 한 자리에서 자라는 근거다.
   */
  readonly claudeConfigDir: string;
  readonly origin: AgentChatSessionOrigin;
  /**
   * Claude Code 자신의 기본 시스템 프롬프트를 이 세션에 실을지. `{ mode: "preset" }`이면 켜고,
   * `undefined`는 결함이 아니라 사용자의 설정(`off`)이다 — SDK는 이 필드가 없으면 그 프롬프트를
   * 아예 붙이지 않는다. 터미널에서 같은 Operation을 열면 같은 설정이 CLI 플래그로 나타난다.
   */
  readonly systemPrompt?: ClaudeGatewaySystemPrompt;
  /**
   * Fleet MCP 좌표를 이 세션 수명에 맞춰 발급한다. 값이 아니라 함수인 이유는 발급물이 세션
   * 토큰이기 때문이다 — seed를 만드는 쪽은 세션이 실제로 생겼는지 모르므로, 여기서 발급하면
   * 이미 살아 있는 세션에 대해 발급된 토큰이 주인 없이 남는다.
   *
   * 세션당 한 번만 불리고, 결과는 SDK와 같은 자리에 캐시된다.
   */
  readonly resolveFleetMcpServers?: () => Promise<readonly ClaudeGatewayServedMcpServer[]>;
  /**
   * 이 세션의 Claude 좌표와 능력 표면을 admiral에서 확정해 온다. 세션 id, 플러그인 트리,
   * 스킬 억제, 설정 층, 시스템 프롬프트 정책이 한 핸들에 함께 실린다 — 터미널 세션이
   * `--session-id`·`--plugin-dir`·`--settings`로 받는 것과 같은 값이다.
   */
  readonly resolveClaudeSession?: () => Promise<ClaudeSessionHandle>;
  /** 위에서 발급한 토큰을 되돌린다. 세션 dispose에서만 불린다. */
  readonly releaseFleetMcpServers?: () => void;
  readonly onProviderSessionUpdate: (providerSession: CapturedAgentSession) => void;
  /**
   * 이 세션의 실행 활동을 Operation 활동축에 보고한다. 반환 false는 축이 이 보고를 받지 못했다는
   * 뜻이며, 그때는 턴을 시작하지 않는다 — 배선이 끊긴 채 도는 턴은 화면에 휴면으로 보이고,
   * 그 조용한 거짓말이 이 계약이 존재하는 이유다.
   */
  readonly reportActivity: (working: boolean) => boolean;
  /**
   * 활동축이 이 세션의 보고를 받을 수 있는지 묻기만 한다 — 아무것도 쓰지 않는다.
   * 쓰는 프로브는 진행 중 턴을 유휴로 뒤집고 그 전이를 방송해, 첫 턴이 도는 중에 들어온
   * 두 번째 메시지가 조기 턴 종료 신호를 만든다.
   */
  readonly canReportActivity: () => boolean;
  /**
   * 사용자의 답을 기다리는 구간을 활동축에 보고한다. 진행 중 턴 안에서만 서므로 working 보고를
   * 끄지 않는다 — 이 값을 읽는 쪽이 대기를 작업보다 앞세운다.
   */
  readonly reportAwaiting: (awaiting: boolean) => void;
  /**
   * 턴보다 오래 사는 작업이 지금 이 세션에 남아 있는지 활동축에 보고한다.
   *
   * 절대값이다 — 원장이 바뀔 때마다 다시 계산해 보낸다. 증감으로 두면 한 워크플로가 에이전트
   * 수만큼 결말을 내는 동안 카운터가 먼저 말라, 아직 도는 작업이 유휴로 읽힌다.
   *
   * 이 축은 작업 중임을 주장하지 않는다. 거짓 유휴를 막을 뿐이며, 턴이 도는 동안에는 읽는 쪽이
   * 작업 중을 앞세운다.
   */
  readonly reportBackgroundPending: (pending: boolean) => void;
}

/**
 * 사용자에게 건넨 답변. 한 질문에 하나씩이며, 값은 고른 라벨(다중 선택은 콤마로 이어 붙인 것)
 * 이거나 사용자가 직접 쓴 문장이다 — 도구는 목록 밖 문자열도 그대로 받아들인다(실측).
 */
export interface AgentChatAnswerInput {
  /** 질문 카드: 질문 순서대로의 답. 빈 문자열은 "그 질문은 건너뛴다"가 아니라 거절 사유가 된다. */
  readonly answers?: readonly string[];
  /** 계획 카드: 승인. */
  readonly approve?: boolean;
  /** 질문의 물리기와 계획의 수정 요청이 함께 쓰는 자리 — 자식에게 오류 결과로 전달된다. */
  readonly message?: string;
}

export type AgentChatAnswerResult =
  | { readonly ok: true; readonly outcome: "answered" | "dismissed" | "approved" | "revised" }
  | { readonly ok: false; readonly error: "ask_not_found" | "invalid_answer" | "plan_truncated" };

/** 답을 기다리며 붙들고 있는 도구 호출 하나. */
interface PendingAsk {
  readonly form: "question" | "plan";
  readonly input: Readonly<Record<string, unknown>>;
  readonly questions: readonly AgentChatQuestion[];
  /**
   * 답을 실을 키 — 도구가 받은 **원본** 질문 텍스트다. 카드가 보여 주는 questions[].question은
   * 상한과 trim을 지난 표시용이라, 그것을 키로 쓰면 400자를 넘거나 앞뒤 공백이 있는 질문에서
   * 키가 어긋난다. 그때 라우트는 200을 돌려주고 카드는 접히는데 모델은 답을 못 받는다.
   */
  readonly answerKeys: readonly string[];
  /**
   * 계획이 상한에 잘렸다. 승인 거절은 카드가 아니라 여기서 진다 — 버튼을 감추는 것은 화면의
   * 예의일 뿐이고, 리로드하지 않은 옛 번들은 그 사실을 모른 채 승인을 보낼 수 있다.
   * 보지 못한 것을 승인할 수 없다는 규칙은 그 요청이 닿는 자리에 있어야 규칙이 된다.
   */
  readonly truncated: boolean;
  readonly settle: (permission: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }) => void;
}

/**
 * 테스트가 실 SDK 스폰 없이 레지스트리를 돌리기 위한 주입점. 옵션은 실제 팩토리의 계약을 그대로
 * 쓴다 — 좁혀 두면 홈 정책처럼 뒤에 붙는 옵션이 주입점을 통과하지 못한다.
 */
export type CreateChatSdk = (options: ClaudeGatewaySdkOptions) => Promise<ClaudeGatewaySdk>;

const JOURNAL_CAP = 2_000;
/**
 * 예약 칩이 화면에 세우는 문면의 상한. 전문은 서버가 그대로 들고 있다가 자기 차례에 보내고,
 * 브라우저로는 한 줄에 들어갈 만큼만 나간다 — 6만 자짜리 초안이 큐 스냅숏마다 소켓을 지나면
 * 예약 하나가 대화 전체보다 무거워진다.
 */
const QUEUE_PREVIEW_CHARS = 200;

/**
 * 예약된 지시 하나가 들고 있는 두 문면.
 *
 * `text`는 자식에게 보낼 프롬프트다 — 첨부가 있으면 호스트 절대 경로가 붙어 있다. `display`는
 * 사람이 실제로 쓴 문장이고, 화면으로 나가는 것은 이쪽뿐이다. 둘을 하나로 합치면 예약 칩이
 * 임시 파일 경로를 브라우저로 실어 보낸다.
 */
interface QueuedDispatch {
  readonly text: string;
  readonly display: string;
}

function countReplayedTurns(entries: readonly AgentChatJournalEvent[]): number {
  let count = 0;
  let turnOpen = false;
  let hasContent = false;
  for (const { event } of entries) {
    if (event.kind === "dispatch") {
      count += 1;
      turnOpen = true;
      hasContent = false;
    } else if (event.kind === "turn-start") {
      // dispatch 바로 뒤의 start는 같은 턴의 시작 좌표다. 반면 내용 뒤의 start는 transcript
      // carrier가 여는 다음 bubbleless 턴이고, 열린 턴이 없을 때의 start도 새 턴이다.
      if (!turnOpen || hasContent) count += 1;
      turnOpen = true;
      hasContent = false;
    } else if (event.kind === "text"
      || event.kind === "tool-start"
      || event.kind === "tool"
      || event.kind === "ask") {
      // 상한이 턴 중간을 자르면 첫 retained 이벤트가 내용일 수 있다. 클라이언트 appendItem이
      // 만드는 bubbleless 턴과 같은 한 턴을 여기서도 센다.
      if (!turnOpen) count += 1;
      turnOpen = true;
      hasContent = true;
    } else if (event.kind === "turn-end") {
      turnOpen = false;
      hasContent = false;
    }
  }
  return count;
}

const TOOL_NAME_CAP = 500;
/**
 * 문맥 카테고리 중 **쓴 것이 아닌** 자리의 이름. vendor가 영어 고정으로 붙인다(실측).
 *
 * 이름으로 가르는 것이 취약하다는 것은 안다. 다만 vendor는 이 둘을 구조적으로 구분해 주지
 * 않으며(`isDeferred`는 다른 축이다), 매칭이 어긋나면 미터가 늘 100%를 가리켜 곧바로 눈에
 * 띈다 — 조용히 틀리는 실패가 아니다.
 */
const CONTEXT_RESERVED_NAME = "Autocompact buffer";
const CONTEXT_UNSPENT: ReadonlySet<string> = new Set([CONTEXT_RESERVED_NAME, "Free space"]);
/** 잡 id→종류. 상세 라우트의 첫 문이라 상한이 필요하지만, 잡은 도구 호출보다 훨씬 드물다. */
const JOB_KIND_CAP = 200;
/**
 * 출력 파일에서 실제로 읽어 올리는 바이트. 꼬리 상한(200줄 · 24k자)을 넉넉히 덮으면서, 몇십 MB
 * 짜리 빌드 로그가 카드 한 번 여는 것으로 서버 메모리에 통째로 올라오지 않게 막는 창이다.
 */
const JOB_TAIL_READ_BYTES = 256 * 1024;
/**
 * 서브에이전트 전사록의 창. 같은 이유로 두되 훨씬 넉넉하다 — JSONL 한 줄이 도구 결과를 통째로
 * 실어 셸 출력 한 줄보다 몇 배 무겁고(실측 표본 19줄 126KB), 창이 좁으면 발자국이 200스텝
 * 상한이 아니라 창 때문에 조용히 짧아진다.
 */
const JOB_TRANSCRIPT_READ_BYTES = 4 * 1024 * 1024;

/**
 * 파일의 마지막 `windowBytes`만 읽는다.
 *
 * 창이 파일 중간에서 시작하면 앞머리는 두 가지 의미로 깨져 있다: 줄이 잘렸고, 그 첫 바이트가
 * UTF-8 시퀀스 한가운데일 수 있다. 그래서 **바이트 수준에서** 이어짐 바이트(`10xxxxxx`)를 먼저
 * 걷어내고, 그다음 줄 경계에 맞춘다.
 *
 * 줄 맞춤에는 단서가 하나 붙는다 — 맞춰서 아무것도 남지 않으면 맞추지 않는다. 마지막 한 줄이
 * 창보다 큰 경우(큰 JSON 레코드 하나를 찍는 명령)에 개행이 창의 맨 끝에만 있거나 아예 없어서,
 * 그대로 잘라내면 화면이 **빈 꼬리**를 보인다. 잘린 줄 하나가 빈 화면보다 정직하다.
 */
async function readFileTail(file: string, windowBytes: number): Promise<{ readonly text: string; readonly headCut: boolean } | null> {
  const handle = await fs.open(file, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - windowBytes);
    const length = stat.size - start;
    if (length <= 0) return { text: "", headCut: false };
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, start);
    let slice = buffer.subarray(0, read.bytesRead);
    if (start > 0) {
      let at = 0;
      while (at < slice.length && (slice[at]! & 0xC0) === 0x80) at += 1;
      slice = slice.subarray(at);
      const firstBreak = slice.indexOf(0x0A);
      if (firstBreak >= 0 && firstBreak + 1 < slice.length) slice = slice.subarray(firstBreak + 1);
    }
    return { text: slice.toString("utf8"), headCut: start > 0 };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 닫힌 턴 뒤에 이 이벤트가 오면 모델이 다시 말하기 시작한 것이다. 잡 이벤트는 여기 들지 않는다 —
 * 백그라운드 맥박은 턴이 닫힌 뒤에도 계속 흐르는 것이 정상이고, 그것으로 턴을 열면 아무 말도
 * 없는 빈 턴이 선다.
 */
function opensChatTurn(event: AgentChatStreamEvent): boolean {
  return event.kind === "text" || event.kind === "text-delta" || event.kind === "tool" || event.kind === "tool-start";
}

class AgentChatSession {
  readonly operationId: string;
  private readonly seed: AgentChatSessionSeed;
  private readonly createSdk: CreateChatSdk;
  private sdk: ClaudeGatewaySdk | null = null;
  private sdkFlight: Promise<ClaudeGatewaySdk> | null = null;
  /** admiral이 확정한 이 세션의 좌표. 세션당 한 번 받아 두고 dispose에서 반납한다. */
  private claudeSession: ClaudeSessionHandle | null = null;
  private claudeSessionFlight: Promise<ClaudeSessionHandle> | null = null;
  /**
   * Fleet MCP 좌표. 세션당 한 번 발급하고 dispose에서 되돌린다 — 턴마다 발급하면 반납되지 않은
   * 토큰이 턴 수만큼 쌓인다.
   */
  private fleetMcpServers: readonly ClaudeGatewayServedMcpServer[] | null = null;
  private fleetMcpFlight: Promise<readonly ClaudeGatewayServedMcpServer[]> | null = null;
  /**
   * resume 좌표는 트랜스크립트 파일명이 말하는 세션 id다 — 캡처 id는 드리프트할 수 있다.
   * `fresh`는 아직 세션이 없으므로 null로 출발하고, 첫 SDK 메시지의 session_id가 이 자리를 채운다.
   */
  private latestSessionId: string | null;
  /** 이미 Operation에 심은 세션 id. 같은 좌표를 매 턴 다시 심지 않기 위한 축이다. */
  private reportedSessionId: string | null = null;
  /** 날고 있는 좌표 심기. 리더가 메시지마다 이 자리를 지나므로 겹치지 않게 붙든다. */
  private syncFlight: Promise<void> | null = null;
  /** 그 비행 중에 들어온 요청이 있었다. 착지 후 좌표가 아직 남아 있으면 한 번 더 간다. */
  private syncDirty = false;
  private journal: AgentChatJournalEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(event: AgentChatJournalEvent) => void>();
  private turnFlight: Promise<void> = Promise.resolve();
  private pendingTurns = 0;
  /**
   * 아직 자기 차례가 오지 않은 예약 지시(좌표 → 전문). 취소가 닿는 자리이며, 자기 차례에
   * 이 맵에서 사라지는 것이 곧 "시작했다"는 뜻이다 — 시작한 턴은 더 이상 취소가 아니라 중지의
   * 몫이므로 두 문이 같은 지시를 두고 겹치지 않는다.
   */
  private readonly queuedDispatches = new Map<string, QueuedDispatch>();
  private queueSeq = 0;
  private disposed = false;
  /**
   * 이 세션이 붙들고 있는 자식. 턴마다 세우고 접는 것이 아니라 **Operation이 열려 있는 동안**
   * 살아 있으며, 그 수명이 곧 백그라운드 작업의 수명이다 — 턴 단위 실행은 vendor가 single-turn으로
   * 보고 자식의 입력을 닫아, Claude Code의 wind-down이 백그라운드 셸을 유예 뒤 kill한다.
   */
  private session: ClaudeGatewaySession | null = null;
  private sessionFlight: Promise<ClaudeGatewaySession> | null = null;
  /**
   * 자식이 받아 주는 것들의 목록. 세션이 열린 **직후 한 번만** 읽는다.
   *
   * 폴링하지 않는 이유는 두 가지다. 첫째, 이 목록은 자식의 수명 동안 움직이지 않는다 —
   * 스킬·플러그인이 다시 읽히는 사건은 이 세션을 접고 여는 사건이다. 둘째, 턴이 도는 동안에는
   * control 채널이 닫혀 물어도 `null`만 온다(`getContextUsage`와 같은 벽). 그래서 채널이 확실히
   * 열려 있는 유일한 창 — 열자마자, 첫 턴 전 — 에 한 번 읽고 그 값을 계속 쓴다.
   */
  private rawCatalog: {
    readonly commands: readonly ClaudeGatewayCommand[];
    readonly agents: readonly ClaudeGatewayAgent[];
  } | null = null;
  private catalogFlight: Promise<void> | null = null;
  /**
   * 지금까지 스킬로 확인된 이름들. `supportedCommands()`는 내장 명령과 스킬을 한 레코드 타입으로
   * 섞어 주고 카테고리 필드가 없으므로, 이 집합이 둘을 가르는 유일한 근거다.
   *
   * **두 출처의 합집합**이며 덮어쓰지 않고 쌓는다 — 실측(2026-08-29)에서 둘은 서로를 포함하지
   * 않았다: `reloadSkills()`는 grill-me·doctor·debug를 빼먹고, init은 delegation·eli5·review를
   * 빼먹는다. 어느 한쪽만 믿으면 그쪽이 놓친 스킬이 명령 칸에 선다.
   *
   * 비어 있으면 전부 명령으로 선다 — 틀린 카테고리보다 한 카테고리가 낫다.
   */
  private skillNames: Set<string> = new Set();
  /** 세션 스트림을 소진하는 리더. dispose가 착지를 기다리는 자리다. */
  private readerDone: Promise<void> | null = null;
  /**
   * 지금 화면에 열려 있는 턴이 있는가.
   *
   * 스트림이 턴마다 끝나지 않으므로 이 축이 필요하다. 여는 자리는 둘 — 사용자가 보낸 디스패치와,
   * 백그라운드 작업이 끝나 자식이 모델을 다시 깨운 뒤 흐르기 시작한 내용이다. 닫는 자리는 `result`
   * 하나이고, 중지도 여기를 닫는다.
   */
  private turnOpen = false;
  /** 이 세션이 연 누적 턴 수. 저널이 앞을 버려도 재접속 receipt가 비교할 단조 좌표다. */
  private observedTurns = 0;
  /** 열린 턴의 완주를 기다리는 디스패치. 턴이 닫히면 풀린다. */
  private awaitingTurn: (() => void) | null = null;
  /**
   * 열린 턴이 닫히기를 기다리는 디스패치들.
   *
   * 자식이 백그라운드 완료로 스스로 깨어나 연 턴은 아무도 기다리지 않는다. 그 창에 사용자
   * 메시지가 들어오면 자기 턴을 세우지 못한 채 남의 결말에 실려 나가므로, 여기서 줄을 세운다.
   */
  private readonly turnCloseWaiters = new Set<() => void>();
  /**
   * 중지한 턴이 아직 자기 `result`를 내지 않았다.
   *
   * 자식은 중단을 받아도 그 턴의 결말을 **반드시** 낸다(실측: `interrupt()` 뒤 2ms에
   * `error_during_execution`). 그것은 이미 닫은 턴의 것이므로 새 턴의 결말로 읽으면 안 되고,
   * 그 사이에 들어온 디스패치는 그 한 건이 지나갈 때까지 기다린다.
   */
  private settlingStoppedTurn = false;
  /**
   * 지금 열린 턴의 프롬프트가 자식에 실제로 닿았는가.
   *
   * 닿지 않은 턴에는 자식이 낼 결말도 없다 — 세션을 여는 동안(자식 spawn·플러그인·MCP 발급은
   * 몇 초가 걸린다) 사용자가 중지하면 그 턴은 자식이 존재조차 모른 채 닫힌다. 그때 결말을
   * 기다리기 시작하면 오지 않을 것을 기다리며 세션이 영구히 막힌다.
   */
  private turnReachedChild = false;
  /**
   * 지금 살아 있다고 알려진 잡. 세션이 끊기면 이 잡들은 자식과 함께 사라지므로, 원장에 "도는 중"
   * 으로 남겨 두지 않고 거둬진 것으로 닫는다 — 화면이 없는 작업을 기다리게 두지 않기 위해서다.
   */
  private readonly liveJobs = new Set<string>();
  /**
   * 이미 결말을 낸 잡. 이름 붙은 에이전트는 다음 지시를 기다리며 세션에 상주하므로, 자기 결말을 낸
   * 뒤에도 살아 있는 작업 목록에 계속 실려 온다(PTY 쪽 hook payload에서 실측된 것과 같은 registry다).
   * 그 항목을 목록에 있다는 이유로 다시 살아 있는 작업으로 읽으면, 이 축에는 시한이 없으므로 세션이
   * 끝날 때까지 유휴·입력 대기 전이가 통째로 막힌다. 기억은 목록이 지워 준다 — 더 이상 실리지 않는
   * id는 registry에서 사라진 것이므로 버린다.
   */
  private readonly settledJobs = new Set<string>();
  /**
   * 중지 세대. 중지는 도는 턴 하나가 아니라 **그 시점의 큐 전체**를 끊어야 한다 — 큐에 밀려
   * 있던 턴이 중지 직후 태연히 시작하면, 사용자가 멈춘 것은 화면에서 멈추지 않는다. 각 턴은
   * 자기가 큐에 들어간 세대를 기억하고, 세대가 어긋나면 시작하지 않거나 중지된 것으로 닫힌다.
   */
  private stopEpoch = 0;
  /**
   * tool_use id → 도구 이름. 결과 블록은 자기가 어떤 도구의 결말인지 모르는데, 무엇을 요약해도
   * 되는지는 도구가 정한다(읽기·쓰기 계열의 성공 결과는 내용이라 싣지 않는다). 긴 세션에서
   * 무한히 자라지 않게 상한을 두고 오래된 것부터 버린다 — 결과는 호출 직후에 오므로 잃을 게 없다.
   */
  private readonly toolNames = new Map<string, string>();
  /**
   * tool_use id → 그 도구 입력이 실어 온 `description`. 잡 제목의 원본이다.
   *
   * 알림(`task_started`)도 같은 문장을 싣고 오지만 그것은 자식이 자기 태스크 레코드에서 다시
   * 꺼낸 사본이고, Windows 한국어 환경에서 그 사본만 CJK가 깨진 채 도착하는 것이 보고됐다
   * (2026-08-27). 모델이 쓴 문장 자체는 이 스트림의 assistant 줄에 이미 흘렀으므로 여기서
   * 붙잡아 둔다 — 도구 호출은 언제나 그것이 낳은 잡보다 먼저 온다.
   *
   * `toolNames`와 같은 상한·같은 퇴장 규칙을 쓴다. 잡은 자기를 낳은 호출 직후에 서므로 오래된
   * 항목을 버려서 잃는 제목은 없다.
   */
  private readonly toolTitles = new Map<string, string>();
  /** 잡 id → 종류. 상세를 어디서 읽을지 정하고, 동시에 상세 라우트가 받는 좌표의 화이트리스트다. */
  private readonly jobKinds = new Map<string, AgentChatJobKind>();
  /**
   * 잡 id → 그 작업이 출력을 남긴 파일. `task_notification.output_file`이 알려 주는 절대 경로다.
   *
   * 이벤트에 싣지 않고 여기 두는 이유는 두 가지다. 하나는 보안 — 호스트 절대 경로는 브라우저
   * DTO에 실리지 않는다. 다른 하나는 정확성 — 이 경로는 세션마다 다른 임시 뿌리 아래에 있어
   * (실측: config dir이 아니라 CLI의 temp 뿌리) 우리가 재구성할 수 있는 값이 아니다.
   */
  private readonly jobOutputs = new Map<string, string>();
  /**
   * 답을 기다리는 도구 호출들. 만료는 두지 않는다(제품 결정) — 사용자가 답하거나 물릴 때까지,
   * 아니면 턴이 끊길 때까지 산다. 그래서 이 맵을 비우는 자리는 셋뿐이다: answer(), 턴 중단,
   * dispose(). 어느 경로로도 비워지지 않으면 SDK는 무기한 멈춘다(권한 요청에 park deadline이 없다).
   */
  private readonly pendingAsks = new Map<string, PendingAsk>();
  /**
   * 문맥 스냅숏의 세대. 턴마다 하나씩 오르며, 늦게 도착한 응답이 자기 턴의 것인지 가른다 —
   * 답은 턴이 끝난 뒤에 오므로(실측), 그 사이 새 턴이 시작했다면 그 값은 남의 턴 자리에 앉는다.
   */
  private contextGeneration = 0;
  /**
   * control 요청이 하나 떠 있는가.
   *
   * 겹쳐 던지면 자식이 직렬로 처리한다 — 실측하면 요청 하나에 약 30초가 들고, 셋을 던진 마지막
   * 답은 100초 뒤에 왔다. 그래서 앞선 요청이 살아 있는 동안에는 새로 던지지 않는다. 놓친 창은
   * 다음 경계(턴 시작·턴 종료)가 다시 얻는다.
   */
  private contextInFlight = false;
  /** 턴이 도는 동안 흘러간 라이브 총량. 턴 경계에서 비운다. */
  private liveContextTotal: number | null = null;
  /** 자식이 스냅숏에서 직접 말한 좌표. 도착하기 전에는 모델 id에서 유도한다. */
  private observedClaudeCoordinate: number | null = null;

  constructor(operationId: string, seed: AgentChatSessionSeed, createSdk: CreateChatSdk) {
    this.operationId = operationId;
    this.seed = seed;
    this.createSdk = createSdk;
    this.latestSessionId = seed.origin.kind === "resume"
      ? path.basename(seed.origin.transcriptPath, ".jsonl")
      : null;
  }

  get busy(): boolean {
    return this.pendingTurns > 0;
  }

  async replayTranscript(): Promise<void> {
    // 재생 경계는 과거가 0턴이어도 남긴다. 같은 서버 안에서 브라우저만 다시 연결하면 이 저널이
    // chat-born 세션의 첫 턴들을 되쓰는데, 경계가 없으면 과거 Answer를 새 도착으로 알릴 수 있다.
    this.push({ kind: "replay-start" });
    if (this.seed.origin.kind === "fresh") {
      this.push({ kind: "replay-end", turns: 0 });
      return;
    }
    const transcriptPath = this.seed.origin.transcriptPath;
    let turns = 0;
    // 재생 턴의 소요 시간은 트랜스크립트가 이미 들고 있다 — 디스패치 줄과 그 턴 마지막 줄의
    // 시각 차이다. 이것이 없으면 접힘 줄이 과거 턴에서만 시간을 잃는다.
    let turnAt: number | null = null;
    let lastAt: number | null = null;
    const closeReplayedTurn = (): void => {
      if (turnAt !== null && lastAt !== null && lastAt > turnAt) {
        this.push({ kind: "turn-end", ok: true, durationMs: lastAt - turnAt });
      }
      turnAt = null;
      lastAt = null;
    };
    // 사람 발화로는 서지 않지만 모델을 깨우는 주입 운반체는 말풍선 없는 여는 이벤트로 온다.
    // 그것을 곧바로 발행하지 않고 붙잡아 두는 이유는 두 가지다.
    //   1) 한 번의 주입이 여러 줄로 온다(슬래시 명령은 command-message·command-name·
    //      local-command-stdout이 잇따른다). 줄마다 턴을 열면 한 지시가 턴 서넛으로 쪼개진다.
    //   2) 뒤에 아무 내용도 따라오지 않는 운반체가 있다. 그 자리에 턴을 세우면 화면에는 아무것도
    //      그려지지 않으면서 "이전 턴 N개 재생됨"의 N만 늘어난다.
    // 그래서 여는 이벤트는 **실제 내용이 뒤따를 때** 비로소 발행하고, 연달아 온 운반체는 하나로
    // 접는다. 접힌 턴의 시작 시각은 묶음의 첫 줄이다 — 소요 시간은 그 지점부터 재는 것이 옳다.
    let pendingOpenAt: number | null | undefined;
    const openPendingTurn = (): void => {
      if (pendingOpenAt === undefined) return;
      const at = pendingOpenAt;
      pendingOpenAt = undefined;
      closeReplayedTurn();
      turns += 1;
      turnAt = at;
      this.push(at === null ? { kind: "turn-start" } : { kind: "turn-start", at });
    };
    try {
      const raw = await fs.readFile(transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const mapped = chatReplayFromTranscriptLine(line, { cwd: this.seed.cwd, toolNames: this.toolNames });
        for (const event of mapped.events) {
          if (event.kind === "turn-start") {
            // 묶음의 첫 줄만 시작 시각으로 남긴다.
            if (pendingOpenAt === undefined) pendingOpenAt = mapped.at ?? null;
            continue;
          }
          if (event.kind === "dispatch") {
            // 사람이 친 지시가 왔다 — 앞의 운반체는 응답을 부르지 못한 채 끝났으므로 버린다.
            pendingOpenAt = undefined;
            closeReplayedTurn();
            turns += 1;
            turnAt = mapped.at ?? null;
          } else {
            openPendingTurn();
          }
          this.rememberTool(event);
          this.push(event);
        }
        // 붙잡아 둔 운반체는 아직 턴이 아니다 — 그 줄의 시각으로 앞 턴의 끝을 늘리지 않는다.
        if (mapped.events.length > 0 && mapped.at !== undefined && pendingOpenAt === undefined) lastAt = mapped.at;
      }
      closeReplayedTurn();
    } catch {
      // 트랜스크립트를 읽지 못해도 세션은 계속된다 — 로그가 비어 보일 뿐 새 턴은 돌 수 있다.
      this.push({ kind: "error", code: "chat_replay_unavailable" });
    }
    this.push({ kind: "replay-end", turns });
  }

  /** 저널 전체를 명시적인 재생 경계 안에서 되돌려준 뒤 라이브 이벤트를 흘린다. 반환값은 구독 해제다. */
  subscribe(listener: (event: AgentChatJournalEvent) => void): () => void {
    const snapshot = this.journal;
    const retainedStart = snapshot.findIndex((entry) => entry.event.kind === "replay-start");
    const retainedEnd = snapshot.findIndex((entry) => entry.event.kind === "replay-end");
    const boundaryCoversSnapshot = retainedStart === 0 && retainedEnd === snapshot.length - 1;
    if (!boundaryCoversSnapshot) {
      // 원래 경계가 상한에 밀렸거나 그 뒤로 live 턴이 쌓였더라도, 이 접속에서 되쓰는 snapshot은
      // 과거다 — 단 하나, 지금 도는 턴만은 예외다. Quick Launch 관찰자는 첫 턴이 이미 시작된 뒤에야
      // 붙으므로, 그 진행 중 턴까지 경계 안에 넣으면 클라이언트가 그것을 재생된 과거로 읽어
      // "작업 중"이 아니라 "작업함"으로 굳힌다(재생 turn-start는 done으로 세운다). 진행 중 턴의
      // 시작부터는 경계 밖으로 흘려, 그 turn-start가 live로 도착해 working으로 서게 한다.
      // 여는 좌표(dispatch/turn-start)를 찾으면 거기서부터가 live다. 상한이 그 좌표까지 밀어냈으면
      // (-1) 마지막 turn-end 뒤 꼬리 전체가 진행 중 턴이지만 여는 이벤트가 없다 — 그 꼬리를 그대로
      // 경계 안에 두면 클라이언트가 done으로 닫고, 서버는 여전히 열린 것으로 알아 새 turn-start를
      // 내지 않으므로 이후 델타가 무시되어 정확히 이 수정이 없애려는 "끝난 척" 상태로 굳는다.
      // 그래서 꼬리를 live로 흘리되 앞에 합성 turn-start를 세워 working 턴을 열어 받게 한다.
      const split = this.turnOpen ? this.inFlightLiveSplit(snapshot) : null;
      const liveFrom = split ? split.from : -1;
      const syntheticStart = split?.synthetic ?? false;
      const replayEnd = liveFrom === -1 ? snapshot.length : liveFrom;
      const replayed = snapshot.slice(0, replayEnd);
      const live = snapshot.slice(replayEnd);
      if (replayed.length === 0) {
        // 재생할 정착 이벤트가 없다 — 상한이 원래 경계까지 밀어낸 것이다(FIFO 소거라 여는 좌표가
        // 밀렸으면 그 앞도 다 밀린다: syntheticStart는 곧 여기다). 앞세우는 합성 프레임은 저널
        // seq가 없으므로, 첫 live seq 바로 아래에 **서로 다른 오름차순** 값을 준다. 같은 seq를
        // 겹쳐 주면 seq<=lastSeq로 중복을 거르는 소비자가 경계·opener·첫 내용을 버린다(빈 replayed는
        // 상한 소거뿐이라 첫 live seq가 커서 음수로 내려가지 않는다).
        const firstLiveSeq = live[0]?.seq ?? this.seq;
        const lead = syntheticStart ? 3 : 2;
        let seq = firstLiveSeq - lead;
        listener({ seq, event: { kind: "replay-start" } });
        listener({ seq: seq += 1, event: { kind: "replay-end", turns: 0 } });
        if (syntheticStart) listener({ seq: seq += 1, event: { kind: "turn-start" } });
      } else {
        // 남아 있는 원래 경계는 snapshot 전체의 바깥 경계가 아니다. 그대로 보내면 원래 replay-end
        // 뒤에 쌓인 과거 live 턴이 새 도착으로 읽히므로, 합성한 바깥 경계만 전달한다. replayed가
        // 비지 않으면 여는 좌표가 살아 있어 live 쪽에 있으므로 합성 turn-start는 필요 없다.
        listener({ seq: snapshot[0]?.seq ?? this.seq, event: { kind: "replay-start" } });
        for (const entry of replayed) {
          if (entry.event.kind !== "replay-start" && entry.event.kind !== "replay-end") listener(entry);
        }
        listener({ seq: replayed.at(-1)?.seq ?? this.seq, event: { kind: "replay-end", turns: countReplayedTurns(replayed) } });
      }
      // 경계 밖: 지금 도는 턴의 이벤트를 live로 흘린다 — 클라이언트가 새로 여는 working 턴이 된다.
      for (const entry of live) {
        if (entry.event.kind !== "replay-start" && entry.event.kind !== "replay-end") listener(entry);
      }
    } else {
      for (const entry of snapshot) listener(entry);
    }
    // 예약은 저널에 없다(라이브 전용). 재접속한 화면이 자기 힘으로 되찾을 길이 없으므로 여기서
    // 한 번 실어 준다 — 재생 경계 **뒤**여야 한다. 앞에 두면 replay-start가 그 자리를 곧바로 비운다.
    // snapshot-end **앞**이기도 하다: 예약은 이번 접속이 발견한 사정이지 새 도착이 아니다.
    if (this.queuedDispatches.size > 0) {
      listener({ seq: this.seq, event: { kind: "queue", entries: this.queueEntries() } });
    }
    // 이 접속이 보유하던 snapshot의 끝. replay-end 뒤에 live로 복원한 진행 중 턴도 여기까지는
    // 새 도착이 아니다. 이후 push()가 보내는 이벤트만 이번 접속의 진짜 live tail이다.
    listener({ seq: this.seq + 0.5, event: { kind: "snapshot-end", turns: this.observedTurns } });
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 지금 도는 턴을 재생 경계 밖으로 가르는 자리. 진행 중 턴은 (a) 마지막 turn-end 뒤이면서
   * (b) 원래 재생 경계(replayTranscript가 남긴 replay-end) 뒤에 있다 — 두 조건을 함께 봐야 한다.
   * resume 트랜스크립트의 마지막 턴은 소요 시간 좌표가 없으면 turn-end 없이 남으므로(closeReplayedTurn),
   * turn-end만 기준으로 잡으면 그 **과거** 턴의 여는 좌표를 골라 live로 흘려 버린다 — 그러면 지난 턴이
   * 새 도착·working으로 읽혀 재접속마다 미확인·예약 집계가 흔들린다. 두 경계의 더 뒤에서부터 찾는다.
   * 여는 좌표가 상한에 밀려 없으면 `synthetic`으로, 꼬리를 live로 흘리며 합성 turn-start를 앞세운다.
   */
  private inFlightLiveSplit(snapshot: readonly AgentChatJournalEvent[]): { readonly from: number; readonly synthetic: boolean } {
    let lastEnd = -1;
    let lastReplayEnd = -1;
    for (let i = snapshot.length - 1; i >= 0; i -= 1) {
      const kind = snapshot[i]?.event.kind;
      if (kind === "turn-end" && lastEnd === -1) lastEnd = i;
      if (kind === "replay-end" && lastReplayEnd === -1) lastReplayEnd = i;
      if (lastEnd !== -1 && lastReplayEnd !== -1) break;
    }
    const floor = Math.max(lastEnd, lastReplayEnd);
    for (let i = floor + 1; i < snapshot.length; i += 1) {
      const kind = snapshot[i]?.event.kind;
      if (kind === "dispatch" || kind === "turn-start") return { from: i, synthetic: false };
    }
    return { from: floor + 1, synthetic: true };
  }

  /**
   * 턴을 직렬화해 실행한다. 반환은 큐 등록 시점이다 — 진행·실패는 저널 이벤트로 전달된다.
   * 실패한 턴은 반드시 run.close()로 슬롯을 반납한다(스파이크에서 실증한 함정).
   */
  /**
   * 활동축이 이 세션의 턴을 받을 수 있는지 미리 확인한다. 큐에 넣은 뒤에는 HTTP 응답이 이미
   * 떠났으므로, 거절은 요청 경계에서만 시끄러울 수 있다.
   */
  canReportActivity(): boolean {
    return this.seed.canReportActivity();
  }

  send(text: string, display: string = text): void {
    if (this.disposed) return;
    const id = `q${++this.queueSeq}`;
    this.pendingTurns += 1;
    this.queuedDispatches.set(id, { text, display });
    // 접수를 곧바로 말한다. HTTP 응답보다 이 알림이 먼저 닿을 수 있고, 그것이 이 축을 서버가
    // 소유하는 이유다 — 화면이 자기 카운터를 세면 취소가 무엇을 지웠는지 둘이 따로 말하게 된다.
    this.pushQueue();
    this.turnFlight = this.turnFlight
      // 이 메시지는 사용자가 별도로 예약한 다음 턴이다. 현재 턴의 중지는 지금 도는 일만 닫으며,
      // 이미 접수된 다음 지시까지 취소하지 않는다 — 그 문은 `cancelQueued`가 따로 연다.
      // dispatch는 앞 턴이 닫힐 때까지 기다린 뒤 자기 세대를 잡으므로 중단 result가 늦게 와도
      // 새 지시의 결말로 읽히지 않는다.
      .then(() => {
        // 자기 차례에 자리가 비어 있으면 그 사이 취소된 것이다. 취소는 좌표를 지우는 것이
        // 전부이고, 판정은 이 한 줄이 진다 — 별도의 취소 집합을 두면 그것이 영원히 자란다.
        if (!this.queuedDispatches.delete(id)) return;
        // 시작한 지시는 더 이상 예약이 아니다. 화면의 칩은 여기서 내려가고, 그 자리는 도는 턴이 잇는다.
        this.pushQueue();
        return this.dispatch(text);
      })
      .catch(() => undefined)
      .finally(() => {
        this.pendingTurns -= 1;
      });
  }

  /**
   * 아직 시작하지 않은 예약 지시 하나를 사용자가 거둔다.
   *
   * 이 문이 닿는 것은 **시작 전**의 지시뿐이다. 이미 도는 턴은 `stopTurn`의 몫이고, 자기 차례에
   * 좌표가 사라진 예약은 조용히 건너뛴다 — 자식은 그 문면을 본 적이 없으므로 되돌릴 것도 없다.
   *
   * 돌려주는 값은 "거둘 것이 있었는가"다. 없는데 true를 돌려주면 화면이 칩을 지우고, 그 지시는
   * 잠시 뒤 태연히 시작한다.
   */
  cancelQueued(id: string): boolean {
    if (this.disposed) return false;
    if (!this.queuedDispatches.delete(id)) return false;
    this.pushQueue();
    return true;
  }

  /**
   * 지금 예약된 지시들. 화면에 나가는 것은 **사람이 쓴 문면**이지 자식에게 보낼 프롬프트가 아니다 —
   * 후자에는 첨부의 호스트 절대 경로가 붙어 있고(`composeLaunchPromptWithAttachments`), 호스트 경로는
   * 브라우저 DTO에 실리지 않는다는 것이 이 저장소의 규약이다. 길이는 한 줄에 들어갈 만큼만 자른다.
   */
  private queueEntries(): readonly AgentChatQueueEntry[] {
    return [...this.queuedDispatches].map(([id, queued]) => ({ id, text: queued.display.slice(0, QUEUE_PREVIEW_CHARS) }));
  }

  /**
   * 예약 전량을 라이브 구독자에게 흘린다. `jobs`와 같은 REPLACE 시맨틱이고, 같은 이유로 저널에
   * 남기지 않는다 — 큐는 지나간 사실이 아니라 지금의 사정이라 재생할 것이 없다.
   */
  private pushQueue(): void {
    this.pushEphemeral({ kind: "queue", entries: this.queueEntries() });
  }

  /**
   * 도는 턴을 사용자가 끊는다.
   *
   * 이 자리가 여는 문은 **턴 하나**다. 자식은 죽지 않으며, 이미 태어난 백그라운드 작업도 계속
   * 산다 — 그것을 멈추는 문은 `stopJob`이 따로 연다. 턴만 끊는 것이 CLI의 Esc와 같은 자리다.
   *
   * 돌려주는 값은 "끊을 것이 있었는가"다. 없는데 true를 돌려주면 화면이 멈춤을 그리고 아무 일도
   * 일어나지 않는다.
   */
  stopTurn(): boolean {
    if (this.disposed) return false;
    if (this.pendingTurns === 0 && !this.turnOpen) return false;
    this.stopEpoch += 1;
    // 붙들린 권한 응답을 먼저 푼다. 남겨 두면 응답을 기다리는 promise 하나가 남아 자식이 그
    // 도구 호출에서 영영 멈춘다 — 턴 종료 경로가 비우는 그 맵을 여기서도 비워야 한다.
    this.abandonAsks("The turn was stopped before the question was answered.");
    // 자식에게 중단을 알린다. 응답을 기다리지 않는 이유는 이 자리가 HTTP 요청 경계이기 때문이고,
    // 실패해도 아래에서 턴은 이미 닫힌 것으로 그린다 — 그 뒤 도착하는 result는 닫힌 턴에 붙지
    // 않는다(turnOpen이 false다).
    void this.session?.interrupt().catch(() => undefined);
    // 자식은 이 턴의 결말을 곧 낸다. 화면은 지금 닫지만, 그 한 건이 다음 턴의 결말로 읽히지
    // 않도록 표시해 둔다 — 중지 직후의 새 메시지가 그것에 실려 나가는 것이 그 결함이다.
    //
    // 프롬프트가 아직 자식에 닿지 않았다면 기다릴 결말도 없다. 그때 표시를 세우면 오지 않을
    // 것을 기다리며 이후 모든 메시지가 막힌다.
    if (this.turnOpen && this.turnReachedChild) this.settlingStoppedTurn = true;
    this.closeTurn({ stopped: true });
    return true;
  }

  /**
   * 백그라운드 작업 하나를 사용자가 멈춘다.
   *
   * 좌표는 SDK가 발급한 `task_id`이며, 우리가 그 잡을 실제로 본 적이 있어야 한다(`jobKinds`가
   * 그 문이다) — 브라우저가 지어낸 id는 자식에 닿지 않는다. 결말은 자식이 내는 `stopped` 알림이
   * 말하므로, 여기서 원장을 미리 고쳐 쓰지 않는다.
   */
  async stopJob(jobId: string): Promise<boolean> {
    if (this.disposed) return false;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return false;
    if (!this.jobKinds.has(jobId)) return false;
    const session = this.session;
    if (!session) return false;
    try {
      await session.stopTask(jobId);
      return true;
    } catch {
      return false;
    }
  }

  /** 지금 답을 기다리는 도구 호출이 있는가. 라우트가 대기 유무를 묻는 자리. */
  get awaiting(): boolean {
    return this.pendingAsks.size > 0;
  }

  /**
   * 대기 중인 질문 하나를 사용자의 답으로 푼다.
   *
   * 답변이 자식에게 닿는 통로는 권한 응답 하나다: 질문은 `updatedInput.answers`(질문 텍스트 → 답)로,
   * 계획은 allow 자체가 승인이 되고, 거절 메시지는 계획 쪽에서 곧 수정 요청이 되어 모델이 계획을
   * 고쳐 다시 낸다(실측).
   */
  answer(id: string, input: AgentChatAnswerInput): AgentChatAnswerResult {
    const pending = this.pendingAsks.get(id);
    if (!pending) return { ok: false, error: "ask_not_found" };
    const message = typeof input.message === "string" ? input.message.trim() : "";

    if (pending.form === "plan") {
      // 잘린 계획은 승인만 막는다. 수정 요청은 그대로 열려 있어 더 짧은 계획을 받을 수 있고,
      // 대기도 유지된다 — 여기서 대기를 풀면 사용자는 답할 자리를 잃는다.
      if (pending.truncated && input.approve === true) return { ok: false, error: "plan_truncated" };
      this.pendingAsks.delete(id);
      if (input.approve === true) {
        pending.settle({ behavior: "allow", updatedInput: { ...pending.input } });
        this.settleAsk(id, "approved");
        return { ok: true, outcome: "approved" };
      }
      if (message.length === 0) {
        this.pendingAsks.set(id, pending);
        return { ok: false, error: "invalid_answer" };
      }
      pending.settle({ behavior: "deny", message });
      this.settleAsk(id, "revised");
      return { ok: true, outcome: "revised" };
    }

    // 물리기 — 답을 주지 않고 나간다. 07번 실측대로 턴은 깨지지 않고 모델이 그 사실을 알고 계속한다.
    if (!Array.isArray(input.answers)) {
      this.pendingAsks.delete(id);
      pending.settle({
        behavior: "deny",
        message: message.length > 0 ? message : "The user dismissed the question without answering.",
      });
      this.settleAsk(id, "dismissed");
      return { ok: true, outcome: "dismissed" };
    }

    const values = input.answers.map((value) => (typeof value === "string" ? value.trim() : ""));
    if (values.length !== pending.questions.length || values.some((value) => value.length === 0)) {
      return { ok: false, error: "invalid_answer" };
    }
    const answers: Record<string, string> = {};
    pending.answerKeys.forEach((key, index) => {
      answers[key] = values[index] ?? "";
    });
    this.pendingAsks.delete(id);
    pending.settle({ behavior: "allow", updatedInput: { ...pending.input, answers } });
    this.settleAsk(id, "answered", pending.questions.map((question, index) => ({
      header: question.header,
      value: values[index] ?? "",
    })));
    return { ok: true, outcome: "answered" };
  }

  /** 결말을 저널에 남기고, 남은 대기가 없으면 활동축의 대기 표시를 거둔다. */
  private settleAsk(
    id: string,
    outcome: "answered" | "dismissed" | "approved" | "revised",
    answers?: readonly { readonly header: string; readonly value: string }[],
  ): void {
    this.push({ kind: "ask-settled", id, outcome, ...(answers ? { answers } : {}) });
    if (this.pendingAsks.size === 0) this.seed.reportAwaiting(false);
  }

  /**
   * 남은 대기를 전부 거절로 접는다. 턴이 끊기거나 세션이 사라지는 자리에서 부른다 — 풀리지 않은
   * promise 하나가 SDK 스트림을 영원히 붙들기 때문이다.
   */
  private abandonAsks(reason: string): void {
    if (this.pendingAsks.size === 0) return;
    for (const [id, pending] of this.pendingAsks) {
      this.pendingAsks.delete(id);
      pending.settle({ behavior: "deny", message: reason });
      this.push({ kind: "ask-settled", id, outcome: "dismissed" });
    }
    this.seed.reportAwaiting(false);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 아직 시작하지 않은 예약은 여기서 거둔다. 남겨 두면 접는 도중에 자기 차례가 와 새 턴을
    // 세우고, dispose는 그 턴의 완주를 기다리며 Operation 삭제·셧다운을 그만큼 붙든다.
    this.queuedDispatches.clear();
    this.abandonAsks("The chat session closed before the question was answered.");
    // 세션과 SDK를 먼저 접는다 — 자식이 죽어야 리더 스트림이 끝나고 대기 중인 디스패치가 풀린다.
    // 순서를 뒤집어 턴 완주를 먼저 기다리면, 멈춘 턴 하나가 Operation 삭제·Console 셧다운을
    // 무기한 막는다. 살아 있던 백그라운드 작업도 자식과 함께 거둬진다 — 터미널 세션을 닫는 것과
    // 같은 결말이며, 원장은 아래 리더 종료 경로가 정직하게 닫는다.
    const session = this.session;
    this.session = null;
    session?.close();
    const sdk = this.sdk;
    this.sdk = null;
    if (sdk) await sdk.dispose().catch(() => undefined);
    if (this.readerDone) await this.readerDone.catch(() => undefined);
    // 줄 서 있던 디스패치를 깨운다. 닫을 턴이 없어 closeTurn이 그냥 돌아가는 경로에서도 이들을
    // 남겨 두면 turnFlight가 영영 착지하지 않아 dispose가 그 자리에서 멈춘다.
    this.releaseTurnCloseWaiters();
    await this.turnFlight.catch(() => undefined);
    // 날고 있는 좌표 심기를 착지시킨다 — 끝난 세션이 뒤늦게 Operation을 고쳐 쓰지 않게.
    if (this.syncFlight) await this.syncFlight.catch(() => undefined);
    // 발급이 아직 날고 있으면 그것부터 착지시킨다 — 먼저 반납하면 뒤늦게 도착한 토큰이 주인
    // 없이 남는다. 반납 자체는 라벨로 지우므로 발급된 적 없는 세션에서도 무해하다.
    if (this.fleetMcpFlight) await this.fleetMcpFlight.catch(() => undefined);
    this.seed.releaseFleetMcpServers?.();
    // 발급이 아직 날고 있으면 착지시킨다 — 트리 자체는 세션의 것이라 여기서 걷지 않는다.
    if (this.claudeSessionFlight) await this.claudeSessionFlight.catch(() => undefined);
    this.claudeSession = null;
    this.listeners.clear();
  }

  /** 도구 이벤트가 지나갈 때 id→이름을 적어 둔다. 결과 요약 정책이 이 축 위에서 결정된다. */
  private rememberTool(event: AgentChatStreamEvent): void {
    // 잡의 종류는 상세를 어디서 읽어야 하는지를 정한다 — 서브에이전트는 전사록, 셸은 출력 파일.
    // 그리고 이 맵이 곧 상세 라우트의 첫 번째 문이다: 여기 없는 id는 파일 시스템에 닿기 전에
    // 거절된다. task_id는 SDK만 발급하므로 브라우저가 지어낸 좌표는 이 문을 통과할 수 없다.
    if (event.kind === "job") {
      this.rememberJobKind(event.id, event.jobKind);
      return;
    }
    if (event.kind !== "tool" && event.kind !== "tool-start") return;
    if (event.id === undefined) return;
    this.toolNames.set(event.id, event.name);
    if (this.toolNames.size > TOOL_NAME_CAP) {
      const oldest = this.toolNames.keys().next();
      if (!oldest.done) this.toolNames.delete(oldest.value);
    }
  }

  /**
   * 잡 하나의 종류를 적는다. 긴 세션에서 무한히 자라지 않게 상한을 두고 오래된 것부터 버리되, 아직
   * 살아 있는 잡은 건너뛴다 — 그 종류는 활동축이 지금 읽고 있고, 잃으면 축이 무의견으로 굳는다.
   */
  private rememberJobKind(jobId: string, kind: AgentChatJobKind, incoming?: ReadonlySet<string>): void {
    this.jobKinds.set(jobId, kind);
    if (this.jobKinds.size <= JOB_KIND_CAP) return;
    for (const oldest of this.jobKinds.keys()) {
      if (this.liveJobs.has(oldest) || incoming?.has(oldest) === true) continue;
      this.jobKinds.delete(oldest);
      return;
    }
  }

  /**
   * 살아 있는 작업 목록이 알려 준 종류를 적어 둔다.
   *
   * `background_tasks_changed`는 `task_type`을 싣고 오지만 스트림 이벤트(`jobs`)는 id만 나른다 —
   * 화면은 종류를 이미 첫 등장(`job`)에서 받았기 때문이다. 활동축은 사정이 다르다: 셸을 세지
   * 않으려면 이 목록에서 처음 본 잡의 종류도 알아야 하고, 그 값은 원본 메시지에만 있다.
   */
  private rememberJobKinds(message: ClaudeGatewayMessage): void {
    if (message.type !== "system" || message.subtype !== "background_tasks_changed") return;
    const tasks = (message as { readonly tasks?: unknown }).tasks;
    if (!Array.isArray(tasks)) return;
    // 이 목록은 `trackJob`이 `liveJobs`를 갈아 끼우기 전에 도착한다 — 그래서 상한을 넘길 때
    // 살아 있는 잡만 지키면 지금 막 실려 온 잡의 종류가 그 자리에서 버려진다. 이번 목록도 함께 지킨다.
    const incoming = new Set<string>();
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      const id = (task as { readonly task_id?: unknown }).task_id;
      if (typeof id !== "string" || id.length === 0) continue;
      incoming.add(id);
    }
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      const id = (task as { readonly task_id?: unknown }).task_id;
      if (typeof id !== "string" || id.length === 0) continue;
      // 종류를 싣지 않은 행은 종류에 대해 아무 말도 하지 않은 것이다. 그것을 `other`로 적으면 첫 등장이
      // 알려 준 종류를 지워, 도는 워크플로가 그 자리에서 축에서 사라진다.
      const rawKind = (task as { readonly task_type?: unknown }).task_type;
      if (typeof rawKind !== "string") continue;
      this.rememberJobKind(id, readJobKind(rawKind), incoming);
    }
  }

  /**
   * 이번 assistant 줄이 낸 도구 호출들의 `description`을 붙잡아 둔다.
   *
   * 여기가 그 문장이 서버에 닿는 첫 자리이고, 그래서 잡 제목의 원본이다. 뒤따라 오는
   * `task_started`도 같은 문장을 싣지만 그것은 자식의 태스크 레코드를 지나온 사본이며,
   * 그 경로에서만 CJK가 깨지는 것이 보고됐다(`toolTitles` 참조).
   *
   * 도구 이름과 달리 이벤트를 거치지 않고 원본 메시지에서 직접 읽는다 — 스텝 이벤트는
   * description을 나르지 않고, 나르게 만들면 브라우저로 가는 어휘에 쓰이지 않는 필드가 하나
   * 늘어난다. 이 값은 서버 안에서만 산다.
   */
  private rememberToolTitles(message: ClaudeGatewayMessage): void {
    if (message.type !== "assistant") return;
    const content = (message as { readonly message?: { readonly content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as { readonly type?: unknown; readonly id?: unknown; readonly input?: unknown };
      if (record.type !== "tool_use") continue;
      if (typeof record.id !== "string" || record.id.length === 0) continue;
      const input = record.input;
      if (!input || typeof input !== "object" || Array.isArray(input)) continue;
      const description = (input as { readonly description?: unknown }).description;
      if (typeof description !== "string" || description.length === 0) continue;
      this.toolTitles.set(record.id, description);
      if (this.toolTitles.size > TOOL_NAME_CAP) {
        const oldest = this.toolTitles.keys().next();
        if (!oldest.done) this.toolTitles.delete(oldest.value);
      }
    }
  }

  /**
   * init이 실어 온 스킬 이름을 적어 둔다.
   *
   * `supportedCommands()`가 내장 명령과 스킬을 한 타입으로 섞어 주고 카테고리를 말하지 않으므로,
   * 이 이름 집합이 둘을 가르는 유일한 근거다. init은 세션당 한 번 오고, 못 받으면 집합은 비어
   * 있다 — 그때 덱은 전부 명령으로 세운다(틀린 카테고리보다 한 카테고리가 낫다).
   */
  private rememberSkillNames(message: ClaudeGatewayMessage): void {
    if (message.type !== "system" || message.subtype !== "init") return;
    const skills = (message as { skills?: unknown }).skills;
    if (!Array.isArray(skills)) return;
    // 더한다 — reloadSkills가 이미 채워 둔 이름을 지우면 그쪽만 아는 스킬이 명령으로 되돌아간다.
    for (const name of skills) if (typeof name === "string") this.skillNames.add(name);
  }

  /**
   * 결말 알림이 알려 준 출력 파일 경로를 적어 둔다.
   *
   * 이 경로를 우리가 재구성하지 않는 이유는 실측이다: 셸 출력은 격리 config dir이 아니라 CLI가
   * 고른 **별개의 임시 뿌리** 아래 `<slug>/<sessionId>/tasks/<taskId>.output`에 앉는다. 그 뿌리는
   * 우리가 정하지도, 알 수도 없다 — SDK가 말해 주는 좌표가 유일한 권위다.
   */
  private rememberJobOutput(message: ClaudeGatewayMessage): void {
    if (message.type !== "system" || message.subtype !== "task_notification") return;
    const id = (message as { readonly task_id?: unknown }).task_id;
    const file = (message as { readonly output_file?: unknown }).output_file;
    if (typeof id !== "string" || id.length === 0) return;
    if (typeof file !== "string" || !path.isAbsolute(file)) return;
    this.jobOutputs.set(id, file);
    if (this.jobOutputs.size > JOB_KIND_CAP) {
      const oldest = this.jobOutputs.keys().next();
      if (!oldest.done) this.jobOutputs.delete(oldest.value);
    }
  }

  /**
   * 잡 하나의 상세를 읽는다 — 서브에이전트의 도구 발자국, 또는 셸 출력의 꼬리.
   *
   * 워크플로는 여기서 답하지 않는다: 단계 트리가 이미 맥박으로 흐르고 있어 그것이 곧 상세다.
   *
   * 두 좌표의 출처가 다르다. 셸 출력은 **SDK가 알려 준 경로**를 그대로 쓴다(재구성 불가 — 위 참조).
   * 서브에이전트 전사록은 이 세션의 격리 config dir 아래 부모 트랜스크립트와 나란한 자리에서
   * 읽는다. SDK의 `getSubagentMessages`를 쓸 수 없어서다: 그 함수는 config dir을 인자로 받지 않고
   * 프로세스 환경에서 찾는데(0.3.212 확인) Chat Mode 세션은 저마다 격리된 dir을 쓰므로, Console
   * 프로세스에서 부르면 언제나 남의 뿌리를 뒤진다.
   *
   * 어느 쪽도 못 찾으면 null을 돌려 화면이 "없다"고 말하게 둔다 — 배치가 바뀌는 날 조용히 틀린
   * 것을 보이는 것보다 낫다.
   */
  async readJobDetail(jobId: string): Promise<AgentChatJobDetail | null> {
    if (this.disposed) return null;
    // 파일 이름의 일부가 될 값이다. 맵 조회가 이미 막지만, 경로를 짓는 자리에서 한 번 더 본다.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return null;
    const kind = this.jobKinds.get(jobId);
    if (kind !== "agent" && kind !== "shell") return null;
    if (kind === "shell") {
      const file = this.jobOutputs.get(jobId);
      if (file === undefined) return null;
      return await this.readShellTail(file);
    }
    const dir = await this.resolveJobSessionDir();
    if (dir === null) return null;
    // 전사록도 같은 이유로 창을 둔다 — 도구 결과가 큰 에이전트의 전사록은 작업 길이에 비례해
    // 자라고, 발자국이 최근 200스텝만 남기는 것과 무관하게 파일 전체가 메모리에 올라온다.
    // 창을 셸보다 넉넉히 잡는 이유는 한 줄이 훨씬 무겁기 때문이다(실측 표본 19줄 126KB).
    const window = await readFileTail(path.join(dir, "subagents", `agent-${jobId}.jsonl`), JOB_TRANSCRIPT_READ_BYTES);
    if (window === null) return null;
    const trail = chatSubagentTrailFromTranscript(window.text, { cwd: this.seed.cwd });
    return { kind: "agent", steps: trail.steps, truncated: trail.truncated || window.headCut };
  }

  private async readShellTail(file: string): Promise<AgentChatJobDetail | null> {
    const window = await readFileTail(file, JOB_TAIL_READ_BYTES);
    if (window === null) return null;
    const tail = chatShellTailFromOutput(window.text, { cwd: this.seed.cwd });
    return { kind: "shell", tail: tail.tail, truncated: tail.truncated || window.headCut };
  }

  /**
   * 이 세션의 부산물(서브에이전트 전사록·도구 결과)이 앉은 디렉터리.
   *
   * 트랜스크립트가 앉은 자리를 그대로 따라간다 — 공유 홈에는 남의 세션도 함께 살아서
   * "projects 아래 디렉터리가 하나뿐"이라는 지름길이 성립하지 않기 때문이다.
   */
  private async resolveJobSessionDir(): Promise<string | null> {
    const sessionId = this.latestSessionId;
    if (!sessionId) return null;
    const transcriptPath = await this.locateTranscript(sessionId);
    if (!transcriptPath) return null;
    return path.join(path.dirname(transcriptPath), sessionId);
  }

  /**
   * 자식이 도구를 쓰기 전에 부르는 자리. 대화형 도구 둘만 여기서 멈춰 사용자를 기다리고,
   * 나머지는 즉시 통과한다.
   *
   * 반환 promise는 answer()가 풀 때까지 열려 있고, 그동안 SDK 스트림도 함께 멈춘다 — 그것이
   * 이 기능의 작동 방식이자 위험이다. 그래서 푸는 자리를 셋으로 못 박고(answer·중단·dispose),
   * 형태를 못 읽은 입력은 카드를 세우지 않고 그냥 통과시킨다.
   */
  private async askUser(
    name: string,
    input: Readonly<Record<string, unknown>>,
    context: { readonly toolUseId: string; readonly signal: AbortSignal },
  ): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    if (!AGENT_CHAT_ASK_TOOLS.has(name)) return { behavior: "allow" };
    const id = context.toolUseId.length > 0 ? context.toolUseId : `ask-${this.seq + 1}`;
    const parsed = agentChatAskFromToolInput(name, id, input);
    if (!parsed) return { behavior: "allow" };
    const ask = parsed.event;
    if (this.disposed) return { behavior: "deny", message: "The chat session is closing." };

    // 이미 끊긴 턴에는 카드를 세우지 않는다. AbortSignal은 지나간 abort를 재생하지 않으므로,
    // 등록 전에 끊겼다면 아래 리스너는 영영 불리지 않는다 — 턴 종료의 abandonAsks가 결국
    // 거두긴 하지만, 그 사이 이미 끝난 턴의 질문이 화면에 서고 사이드바가 대기라고 말한다.
    if (context.signal.aborted) {
      return { behavior: "deny", message: "The turn ended before the question was answered." };
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (permission: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }): void => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", onAbort);
        resolve(permission);
      };
      function onAbort(): void {
        settle({ behavior: "deny", message: "The turn ended before the question was answered." });
      }
      // 턴이 끊기면 카드도 끝난다. 이 배선이 없으면 중단된 턴의 질문이 맵에 남아, 다음 턴이
      // 시작될 때까지 사이드바가 대기라고 말한다.
      context.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingAsks.set(id, {
        form: ask.form,
        input,
        questions: ask.questions ?? [],
        answerKeys: parsed.answerKeys,
        truncated: ask.truncated === true,
        settle: (permission) => {
          settle(permission);
          this.pendingAsks.delete(id);
        },
      });
      this.push(ask);
      this.seed.reportAwaiting(true);
    });
  }

  /**
   * 자식에게 문맥 **내역**을 묻고, 답이 오면 저널에 싣는다. 두 경계에서 불린다 — 턴을 보내기
   * 직전(`"start"`)과 턴이 닫힌 직후(`"end"`).
   *
   * 왕복이 느리다는 것이 이 배선의 전제다(실측 21~88초, 요청 하나에 약 30초, 직렬 큐). 그래서
   * 총량은 이 채널에 맡기지 않고 `message_delta` usage가 진다. 여기서 얻는 것은 카테고리 분해 —
   * 그것만은 control 채널이 유일한 출처다.
   *
   * 턴 중에는 아예 묻지 않는다. 자식이 턴이 시작되면 control을 닫아 +0ms의 요청만 답을 받고
   * 그 뒤는 전부 "Query closed before response received"로 끝난다(실측). 유휴 폴링도 하지 않는다 —
   * 답은 오지만 요청마다 30초를 태우고 큐만 밀린다.
   *
   * 응답을 기다리지 않는 이유는 스트림 때문이다: 여기서 await하면 첫 메시지 소비가 그만큼 늦다.
   */
  private requestContextSnapshot(session: ClaudeGatewaySession, asOf: "start" | "end"): void {
    // 앞선 요청이 떠 있으면 던지지 않는다. 겹쳐 던진 만큼 자식이 직렬로 밀어내므로, 두 번째 답은
    // 첫 번째보다 30초 늦게 오고 그 사이 경계는 이미 지나가 있다.
    if (this.contextInFlight) return;
    // 응답은 이 턴이 **끝난 뒤에** 도착한다(실측: turn-end → context). 그래서 어느 턴의 값인지를
    // 세대로 붙들어 둔다 — 다음 턴이 이미 시작했다면 이 값은 그 턴의 것이 아니고, 그대로 실으면
    // 리듀서가 남의 턴에 붙여 증가분을 한 턴씩 밀어 버린다. 새 턴은 자기 스냅숏을 따로 받는다.
    const generation = ++this.contextGeneration;
    this.contextInFlight = true;
    const settle = (usage: ClaudeGatewayContextUsage | null): void => {
      this.contextInFlight = false;
      if (usage && generation === this.contextGeneration) this.pushContext(usage, asOf);
    };
    // 이 표시 하나 때문에 턴이 죽어서는 안 된다. 계약상 이 메서드는 있어야 하지만, 없거나 동기로
    // 던지는 런이 오면 그 예외는 턴 루프까지 올라가 대화 전체를 실패로 닫는다(실측: 계약을
    // 따르지 않는 대역 하나가 세션 테스트 10건을 그렇게 무너뜨렸다).
    try {
      void session.getContextUsage().then(settle, () => {
        this.contextInFlight = false;
      });
    } catch {
      // 문맥 표시가 없는 턴은 여전히 온전한 턴이다.
      this.contextInFlight = false;
    }
  }

  /**
   * 턴 시작 시점의 문맥을 저널에 심는다.
   *
   * 총량을 vendor의 `total`이 아니라 **카테고리 합으로 다시 세는** 이유는 실측이다: 게이트웨이
   * 세션에서 그 값(24,948)은 카테고리 합(129,670)과 크게 어긋났다 — 전자는 게이트웨이가 실제로
   * 읽은 토큰이고 후자는 CLI가 센 로컬 배분이다. 화면은 내역과 총량을 나란히 세우므로 둘이
   * 다른 셈을 쓰면 사용자가 보는 자리에서 모순이 드러난다. 내역이 곧 총량이어야 한다.
   *
   * 예약분(자동 압축 여유)과 남은 자리는 **쓴 것이 아니다**. 같은 목록에 두면 합이 언제나 창
   * 전체가 되어 미터가 항상 100%를 가리킨다.
   */
  private pushContext(usage: ClaudeGatewayContextUsage, asOf: "start" | "end"): void {
    // 자식이 직접 말한 좌표가 유도값을 대신한다. 이 뒤의 라이브 총량은 같은 자를 쓴다.
    this.observedClaudeCoordinate = usage.max;
    const spent = usage.categories.filter((category) =>
      !category.deferred && category.tokens > 0 && !CONTEXT_UNSPENT.has(category.name));
    const reserved = usage.categories.find((category) => category.name === CONTEXT_RESERVED_NAME);
    const window = this.realWindow(usage.max);
    const slices = spent.map((category) => ({
      name: category.name,
      tokens: window ? window.unproject(category.tokens) : category.tokens,
    }));
    this.push({
      kind: "context",
      asOf,
      total: slices.reduce((sum, slice) => sum + slice.tokens, 0),
      max: window ? window.max : usage.max,
      // 예약분은 되돌리지 않고 **갈아 끼운다**. 자식의 값은 자기 좌표의 여유(max − compactAt)이고
      // 실제 여유는 정책이 정하는 다른 수다 — 같은 비율로 늘리면 있지도 않은 자리를 예약해 둔다.
      ...(window
        ? (window.max > window.compactAt ? { reserved: window.max - window.compactAt } : {})
        : (reserved && reserved.tokens > 0 ? { reserved: reserved.tokens } : {})),
      ...(window
        ? (usage.compactAt === null ? {} : { compactAt: window.compactAt })
        : (usage.compactAt === null ? {} : { compactAt: usage.compactAt })),
      slices,
      ...(usage.memoryFiles.length > 0
        ? {
            memoryFiles: usage.memoryFiles.map((file) => ({
              name: file.path,
              tokens: window ? window.unproject(file.tokens) : file.tokens,
            })),
          }
        : {}),
      ...(usage.mcpTools.length > 0
        ? {
            mcpTools: usage.mcpTools.map((tool) => ({
              name: tool.server ? `${tool.server} · ${tool.name}` : tool.name,
              tokens: window ? window.unproject(tool.tokens) : tool.tokens,
            })),
          }
        : {}),
    });
  }

  /**
   * 턴이 도는 동안 총량을 흘린다. 미터가 이 턴을 따라 움직이는 유일한 경로다.
   *
   * 읽는 것은 `message_delta`의 usage **하나뿐**이며, 그것은 소거로 남은 결과다(실측):
   * `message_start`와 완성 `assistant`의 usage는 언제나 0으로 오고, `result.usage`는 그 턴의 모든
   * 모델 호출을 **합산한** 값이어서 창 점유가 아니다 — 도구를 다섯 번 돈 턴에서 61,630이었고 같은
   * 순간의 실제 점유는 15,785였다. 그것을 총량으로 쓰면 미터가 네 배로 뛴다.
   *
   * 서브에이전트의 usage도 제외한다. 그 창은 부모의 창이 아니다.
   */
  private trackLiveContext(message: ClaudeGatewayMessage): void {
    if (message.type !== "stream_event") return;
    if (typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0) return;
    const event = message.event;
    if (!isRecord(event) || event.type !== "message_delta") return;
    const total = readClaudeOccupiedInputTokens(event.usage);
    if (total === null) return;
    // 자식 좌표의 총량이므로 스냅숏과 같은 자로 되돌린다.
    const claudeCoordinate = this.claudeCoordinate();
    const window = this.realWindow(claudeCoordinate);
    const live = window ? window.unproject(total) : total;
    // 같은 수를 다시 실으면 구독자가 같은 렌더를 한 번 더 한다. 델타는 모델 호출마다 오므로
    // 도구 하나가 아무것도 더하지 않은 호출에서 그런 일이 실제로 생긴다.
    if (this.liveContextTotal === live) return;
    this.liveContextTotal = live;
    this.pushEphemeral({
      kind: "context-live",
      total: live,
      max: window ? window.max : claudeCoordinate,
    });
  }

  /**
   * 자식이 이 세션을 재는 좌표.
   *
   * 스냅숏이 한 번이라도 왔으면 자식이 직접 말한 값이 권위다. 그 전에는 유도한다 — 좌표를 정하는
   * 것은 모델 id의 `[1m]` 마커이고, 그 마커를 붙이는 규칙이 곧 카탈로그 창이 1M에 닿는지 여부다.
   * 유도가 필요한 이유는 라이브 총량이 첫 스냅숏(왕복 30초)을 기다릴 수 없기 때문이다.
   */
  private claudeCoordinate(): number {
    if (this.observedClaudeCoordinate !== null) return this.observedClaudeCoordinate;
    const window = this.seed.contextWindow;
    const oneMillion = typeof window === "number" && Number.isFinite(window) && window > 0
      ? window >= CLAUDE_COMPAT_CONTEXT_WINDOW
      : hasClaudeOneMillionMarker(this.seed.model);
    return oneMillion ? CLAUDE_COMPAT_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * 자식이 보고한 좌표를 이 모델의 실제 창으로 되돌리는 자.
   *
   * `null`은 되돌릴 것이 없다는 뜻이며 세 경우가 여기로 온다: 시드에 카탈로그 창이 없는 세션
   * (네이티브 Claude 모델·카탈로그 밖 id), 그리고 자식이 자기 두 좌표가 아닌 값을 말한 세션 —
   * 후자는 역함수가 스스로 항등으로 접는다. 어느 경우든 오늘의 숫자가 그대로 나간다.
   */
  private realWindow(claudeCoordinate: number): {
    readonly max: number;
    readonly compactAt: number;
    readonly unproject: (tokens: number) => number;
  } | null {
    const max = this.seed.contextWindow;
    if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return null;
    // 창만 바꿔 싣고 점유는 자식 좌표에 남겨 두는 것이 이 결함의 가장 나쁜 형태다 — 분모는 500k인데
    // 분자는 200k 자의 값이어서 점유율이 실제의 1/3로 보인다. 되돌릴 수 없는 좌표면 둘 다 놓아둔다.
    if (claudeCoordinate !== CLAUDE_DEFAULT_CONTEXT_WINDOW
      && claudeCoordinate !== CLAUDE_COMPAT_CONTEXT_WINDOW) {
      return null;
    }
    const ceiling = this.seed.compactCeiling ?? null;
    return {
      max,
      compactAt: compactThresholdTokens(max, ceiling),
      unproject: (tokens) => unprojectClaudeContextInputTokens(tokens, max, claudeCoordinate, ceiling),
    };
  }

  private push(event: AgentChatStreamEvent): void {
    const entry: AgentChatJournalEvent = { seq: ++this.seq, event };
    // 잡의 맥박은 누적이 아니라 스냅숏이다 — 매번 그 잡의 단계 트리 전체를 다시 실어 오고,
    // 리듀서도 통째로 갈아 끼운다. 저널에 겹겹이 쌓으면 재접속이 이미 지나간 트리를 수십 번
    // 되재생하고, 상한(JOURNAL_CAP)에 걸린 세션에서는 그 무게가 디스패치·응답·잡 시작 같은
    // 되돌릴 수 없는 이력을 앞에서부터 밀어낸다. 같은 잡의 이전 맥박은 자리를 비켜 준다.
    if (event.kind === "job-progress") {
      const at = this.journal.findIndex((held) => held.event.kind === "job-progress" && held.event.id === event.id);
      if (at >= 0) this.journal.splice(at, 1);
    }
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_CAP) this.journal.splice(0, this.journal.length - JOURNAL_CAP);
    for (const listener of this.listeners) listener(entry);
  }

  /**
   * 라이브 구독자에게만 흘리고 저널에는 남기지 않는다 — 글자 단위 델타를 저널(cap 2000)에
   * 쌓으면 즉시 소진된다. 재접속 리플레이는 완성 text 이벤트(병합본)로 같은 내용을 복원하고,
   * 그 완성 이벤트가 델타 유실의 정정 앵커를 겸한다. seq는 저널과 한 축을 공유한다.
   */
  private pushEphemeral(event: AgentChatStreamEvent): void {
    const entry: AgentChatJournalEvent = { seq: ++this.seq, event };
    for (const listener of this.listeners) listener(entry);
  }

  /**
   * admiral이 확정한 이 세션의 좌표를 한 번만 받아 둔다.
   *
   * 두 번 받으면 안 된다 — 두 번째 호출은 같은 트리에 홀더를 하나 더 세우고, dispose가 반납하는
   * 것은 마지막 것뿐이라 첫 홀더가 영원히 남는다. 발급자가 없는 seed(테스트·구세대 배선)는
   * 여기서 실패하고, 그 실패가 곧 `chat_fleet_plugin_unavailable`이다.
   */
  private async resolveClaudeSession(): Promise<ClaudeSessionHandle> {
    if (this.claudeSession) return this.claudeSession;
    if (!this.claudeSessionFlight) {
      this.claudeSessionFlight = (async () => {
        const resolve = this.seed.resolveClaudeSession;
        if (!resolve) throw new Error("Fleet plugin session resolver is unavailable");
        const handle = await resolve();
        this.claudeSession = handle;
        return handle;
      })().finally(() => {
        this.claudeSessionFlight = null;
      });
    }
    return this.claudeSessionFlight;
  }

  private async ensureSdk(): Promise<ClaudeGatewaySdk> {
    if (this.sdk) return this.sdk;
    if (!this.sdkFlight) {
      this.sdkFlight = (async () => {
        // 플러그인을 못 실으면 스킬도 게이트웨이 정체성도 정책 훅도 없는 세션이 된다. 그런 세션을
        // 조용히 계속 돌리면 같은 Operation을 터미널로 열었을 때와 다른, 특히 위임 가드가 없는
        // 능력을 갖게 되고 그 차이는 화면 어디에도 드러나지 않는다 — 구체 코드를 저널에 남기고
        // 턴을 실패시킨다. 실패한 턴이 무장 해제된 세션보다 낫다.
        const claudeSession = await this.resolveClaudeSession()
          .catch((error: unknown) => {
            this.push({ kind: "error", code: "chat_fleet_plugin_unavailable" });
            throw error instanceof Error ? error : new Error("Fleet plugin session unavailable");
          });
        try {
          const sdk = await this.createSdk({
            baseUrl: this.seed.baseUrl,
            models: [this.seed.model],
            // 공유 홈이다 — 이 세션의 트랜스크립트는 터미널이 읽는 그 파일이고, 옮겨 올 사본이 없다.
            home: { kind: "shared", configDir: this.seed.claudeConfigDir },
            // 플러그인 트리·스킬 억제·설정 층은 admiral이 확정해 준 그대로 싣는다. 여기서 다시
            // 조립하면 PTY 런치와 갈리고, 그 차이는 화면 어디에도 드러나지 않는다.
            ...claudeSession.sdk.options,
            ...(this.seed.ultracode ? { ultracode: true } : {}),
            // 플러그인이 실은 훅은 세션 식별자로 자기 축을 찾는다. 이 자식에게는 그 식별자가
            // 없어야 한다 — 상속된 값이 남으면 남의 세션 축에 보고한다.
            env: chatChildEnv(process.env),
          });
          if (this.disposed) {
            await sdk.dispose().catch(() => undefined);
            throw new Error("chat session disposed");
          }
          this.sdk = sdk;
          return sdk;
        } catch (error) {
          // 트리는 그대로 둔다 — 이 세션의 것이고, 다음 시도가 같은 자리를 다시 쓴다.
          this.claudeSession = null;
          throw error;
        }
      })().finally(() => {
        this.sdkFlight = null;
      });
    }
    return this.sdkFlight;
  }

  /**
   * Fleet MCP 좌표를 세션당 한 번 발급해 캐시한다. 발급자가 없는 seed(테스트·구세대 배선)는
   * 빈 목록으로 내려가고, 그 세션은 Fleet 도구 없이 돈다.
   */
  private async ensureFleetMcpServers(): Promise<readonly ClaudeGatewayServedMcpServer[]> {
    if (this.fleetMcpServers) return this.fleetMcpServers;
    const resolve = this.seed.resolveFleetMcpServers;
    if (!resolve) return [];
    if (!this.fleetMcpFlight) {
      this.fleetMcpFlight = (async () => {
        const servers = await resolve();
        this.fleetMcpServers = servers;
        return servers;
      })().finally(() => {
        this.fleetMcpFlight = null;
      });
    }
    return this.fleetMcpFlight;
  }

  /**
   * 자식 하나를 열고, 그 스트림을 끝까지 소진하는 리더를 세운다. 세션당 한 번이다.
   *
   * 턴이 아니라 세션이 실행 정책을 소유한다 — 모델·강도·doctrine·도구 좌표·cwd는 자식이 사는
   * 동안 바뀌지 않고, 바뀌어야 한다면 그것은 이 세션을 접고 새로 여는 사건이다.
   */
  private async ensureSession(): Promise<ClaudeGatewaySession> {
    if (this.session) return this.session;
    if (!this.sessionFlight) {
      this.sessionFlight = (async () => {
        const sdk = await this.ensureSdk();
        // Fleet 도구를 못 붙이는 것은 세션을 죽일 사유가 아니지만 조용히 넘길 사유도 아니다 —
        // 도구 없이 도는 세션은 게이트웨이 로스터를 읽지 못한 채 위임을 판단한다.
        const fleetMcpServers = await this.ensureFleetMcpServers().catch(() => {
          this.push({ kind: "error", code: "chat_fleet_tools_unavailable" });
          return [] as readonly ClaudeGatewayServedMcpServer[];
        });
        const claudeSession = await this.resolveClaudeSession();
        const session = await sdk.openSession({
          model: this.seed.model,
          ...(this.seed.effort ? { effort: this.seed.effort } : {}),
          ...(fleetMcpServers.length > 0 ? { servedMcpServers: fleetMcpServers } : {}),
          cwd: this.seed.cwd,
          // 이어붙일 좌표는 admiral이 세션을 준비할 때 이미 확정했다. 채팅으로 태어난 세션도
          // 마찬가지다 — 자식이 만든 id를 받아 적는 대신 우리가 못박았으므로, 첫 턴을 기다리지
          // 않고도 이 세션의 좌표를 안다. 시스템 프롬프트 정책도 같은 자리에서 나온다.
          ...claudeSession.sdk.request,
          // 이 콜백은 권한 게이트가 아니다. 모드는 그대로 bypass이고 평범한 도구는 여기서 그냥
          // 통과한다 — 콜백을 주는 이유는 그래야 자식이 대화형 도구를 갖기 때문이다(실측: 29→32).
          canUseTool: (name, input, context) => this.askUser(name, input, context),
          // 스트리밍 감각의 근거 — 글자 단위 text_delta를 받으려면 부분 메시지가 필요하다.
          includePartialMessages: true,
        });
        if (this.disposed) {
          session.close();
          throw new Error("chat session disposed");
        }
        this.session = session;
        this.readerDone = this.readSession(session);
        this.primeCatalog(session);
        return session;
      })().finally(() => {
        this.sessionFlight = null;
      });
    }
    return this.sessionFlight;
  }

  /**
   * 컴포저 덱이 세울 목록을 읽어 캐시에 눕힌다. 세션이 열린 직후 한 번만 부른다.
   *
   * await하지 않는다 — 여기서 기다리면 첫 디스패치가 control 왕복만큼 늦다. 덱을 여는 쪽이
   * `readCatalog()`에서 이 비행을 기다리므로, 늦는 것은 덱뿐이고 대화는 늦지 않는다.
   *
   * `null`(못 물었다)과 빈 배열(물었는데 없다)을 가른다: `null`이면 캐시를 세우지 않아 다음
   * 요청이 다시 시도하고, 빈 배열이면 "이 세션엔 없다"를 캐시한다.
   */
  /**
   * 디스크에 스킬로 놓여 있는 이름들. 분류의 **셋째 출처**다.
   *
   * SDK의 두 출처가 서로를 포함하지 않고, init은 첫 턴 전에는 오지 않는다 — 그래서 `/`만 눌러
   * 연 세션에서는 사용자가 자기 손으로 만든 스킬(`~/.claude/skills/<이름>`)마저 명령 칸에 섰다.
   * 디렉터리 이름이 곧 스킬 이름이라는 규약은 Skills 플러그인이 이미 쓰고 있는 것과 같다.
   *
   * 여기서 읽은 이름은 **분류에만** 쓴다 — 목록에 무엇이 있는지는 여전히 SDK가 정한다. 그래서
   * 디스크에만 있고 세션이 싣지 않은 이름은 애초에 행이 되지 않는다.
   */
  private async readSkillDirNames(): Promise<readonly string[]> {
    const roots = [
      path.join(this.seed.claudeConfigDir, "skills"),
      path.join(this.seed.cwd, ".claude", "skills"),
    ];
    const names: string[] = [];
    for (const root of roots) {
      try {
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
          // 심볼릭 링크도 센다. `Dirent.isDirectory()`는 **링크 자신**을 보고하므로 링크로 걸어 둔
          // 스킬은 전부 false가 된다 — 실측한 홈에서는 9개 중 8개가 링크였고, 그래서 사용자가
          // 자기 손으로 만든 스킬이 명령 칸에 섰다. 링크가 가리키는 곳까지 따라가 확인한다.
          if (entry.isDirectory()) { names.push(entry.name); continue; }
          if (!entry.isSymbolicLink()) continue;
          try {
            if ((await fs.stat(path.join(root, entry.name))).isDirectory()) names.push(entry.name);
          } catch {
            // 끊긴 링크는 스킬이 아니다.
          }
        }
      } catch {
        // 없는 디렉터리는 결함이 아니다 — 그 층에 스킬이 없다는 뜻일 뿐이다.
      }
    }
    return names;
  }

  private primeCatalog(session: ClaudeGatewaySession): void {
    if (this.catalogFlight) return;
    this.catalogFlight = (async () => {
      try {
        const [commands, agents, skills, onDisk] = await Promise.all([
          session.supportedCommands(),
          session.supportedAgents(),
          // 스킬 이름의 **주 출처**다. init 메시지의 `skills`는 첫 턴과 함께 오므로(실측),
          // `/`만 눌러 연 세션에서는 오지 않는다 — 그것에 기대면 그 세션 내내 스킬 전부가
          // 명령 칸에 선다. 이 요청은 턴과 무관하게 답한다.
          session.reloadSkills(),
          this.readSkillDirNames(),
        ]);
        if (commands === null && agents === null) return;
        if (skills !== null) for (const entry of skills) this.skillNames.add(entry.name);
        for (const name of onDisk) this.skillNames.add(name);
        // 분류는 여기서 굳히지 않는다 — init은 control 왕복과 경쟁하므로 이 시점에 스킬 이름이
        // 아직 없을 수 있고, 그러면 스킬이 영영 명령 칸에 선다. 원본만 들고 읽을 때 가른다.
        this.rawCatalog = { commands: commands ?? [], agents: agents ?? [] };
      } catch {
        // 카탈로그가 없는 세션도 온전한 세션이다 — 덱만 비고 대화는 그대로 돈다.
      } finally {
        this.catalogFlight = null;
      }
    })();
  }

  /**
   * 덱이 세울 목록. 세션이 아직 없으면 **연다** — 사용자가 `/`나 `@`를 친 것이 곧 이 세션의
   * 능력을 묻는 행위이므로, 그 순간이 자식을 열 이유로 충분하다(첫 턴을 기다리면 갓 연 채팅의
   * 첫 덱은 반드시 비어 있다).
   *
   * 못 읽었으면 `null`이다. 화면은 그것을 빈 목록이 아니라 "아직 모른다"로 그려야 한다.
   */
  async readCatalog(): Promise<AgentChatCatalog | null> {
    if (this.disposed) return null;
    if (!this.rawCatalog) {
      try {
        await this.ensureSession();
      } catch {
        return null;
      }
      await this.catalogFlight;
    }
    const raw = this.rawCatalog;
    if (!raw) return null;
    // 분류는 매 읽기마다 지금의 스킬 이름으로 다시 센다 — init이 카탈로그 왕복보다 늦게
    // 도착해도 다음 읽기에서 스킬 칸이 제대로 선다.
    const toEntry = (entry: { readonly name: string; readonly description: string; readonly argumentHint: string }): AgentChatCatalogEntry => ({
      name: entry.name,
      description: entry.description,
      argumentHint: entry.argumentHint,
    });
    // 같은 이름이 둘 이상 올 수 있다(실측: 플러그인 스킬과 평범한 스킬이 같은 `frontend-design`
    // 으로 왔다). 두 행은 **같은 텍스트를 보내므로** 사용자에게는 고를 수 없는 중복이고, 설명이
    // 덜 꾸며진 쪽을 남긴다(플러그인 쪽은 `(이름) `이 앞에 붙는다).
    const dedupe = (entries: readonly AgentChatCatalogEntry[]): readonly AgentChatCatalogEntry[] => {
      const byName = new Map<string, AgentChatCatalogEntry>();
      for (const entry of entries) {
        const seen = byName.get(entry.name);
        if (!seen) { byName.set(entry.name, entry); continue; }
        if (seen.description.startsWith("(") && !entry.description.startsWith("(")) byName.set(entry.name, entry);
      }
      return [...byName.values()];
    };
    return {
      commands: dedupe(raw.commands.filter((entry) => !this.skillNames.has(entry.name)).map(toEntry)),
      skills: dedupe(raw.commands.filter((entry) => this.skillNames.has(entry.name)).map(toEntry)),
      agents: dedupe(raw.agents.map((entry) => ({ name: entry.name, description: entry.description, argumentHint: "" }))),
    };
  }

  /**
   * 세션 스트림을 끝까지 읽는다. 이 루프가 사는 동안 자식은 "사용자가 아직 있다"고 보므로,
   * 백그라운드 작업이 턴을 넘어 살고 그 결말 알림도 받을 자리가 있다.
   *
   * 여기서 끝나는 것은 턴이 아니라 세션이다 — 자식이 죽거나 우리가 접었을 때만 빠져나온다.
   */
  private async readSession(session: ClaudeGatewaySession): Promise<void> {
    try {
      for await (const message of session as AsyncIterable<ClaudeGatewayMessage>) {
        if (typeof message.session_id === "string" && message.session_id.length > 0) {
          this.latestSessionId = message.session_id;
          // 아직 심지 않은 좌표가 있으면 심는다. 판정을 "id가 바뀌었는가"로 두면 이어받은 세션의
          // **첫** 좌표가 영영 심기지 않는다 — 그 id는 처음부터 알고 있었으므로 바뀌지 않는다.
          if (this.latestSessionId !== this.reportedSessionId) this.syncProviderSessionOnce();
        }
        this.rememberSkillNames(message);
        this.rememberJobOutput(message);
        this.rememberJobKinds(message);
        this.rememberToolTitles(message);
        this.trackLiveContext(message);
        for (const event of chatEventsFromSdkMessage(message, {
          cwd: this.seed.cwd,
          toolNames: this.toolNames,
          toolTitles: this.toolTitles,
        })) {
          this.ingest(event);
        }
      }
    } catch {
      // 자식이 끊겼다. 다음 디스패치가 새 자식을 세우고 마지막 좌표로 이어붙인다.
      if (!this.disposed) this.push({ kind: "error", code: "chat_session_lost" });
    } finally {
      this.retireSession(session);
    }
  }

  /**
   * 리더가 만든 이벤트 하나를 원장에 반영한다. 턴 경계도 여기서 결정된다.
   *
   * 스트림이 턴마다 끝나지 않으므로 경계는 내용이 말한다: `result`가 열린 턴을 닫고, 닫힌 뒤에
   * 다시 흐르기 시작한 내용이 새 턴을 연다. 후자가 백그라운드 작업이 끝나 자식이 모델을 다시
   * 깨운 자리이며, 그것을 앞 턴에 이어 붙이면 사용자가 읽은 답이 갈아치워진다.
   */
  private ingest(event: AgentChatStreamEvent): void {
    if (event.kind === "turn-end") {
      // 중지가 표시해 둔 결말은 여기서 소진된다. 열린 턴이 있으면 그 턴이 이 결말의 주인이고,
      // 없으면 이미 닫은 턴의 것이므로 그리지 않고 줄 서 있던 디스패치만 깨운다.
      const settling = this.settlingStoppedTurn;
      this.settlingStoppedTurn = false;
      if (this.turnOpen) {
        this.closeTurn({ ok: event.ok, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }), ...(event.answer === undefined ? {} : { answer: event.answer }) });
      } else if (settling) {
        this.releaseTurnCloseWaiters();
      }
      return;
    }
    if (!this.turnOpen && opensChatTurn(event)) this.openTurn({ dispatched: false });
    this.rememberTool(event);
    this.trackJob(event);
    // 대화형 도구는 스텝을 세우지 않는다 — 카드가 이미 그 자리에 서 있고, 그 옆에 "질문함"
    // 한 줄을 더 세우면 같은 사건이 두 번 읽힌다. 결과 줄은 짝을 못 찾아 스스로 버려진다.
    if ((event.kind === "tool" || event.kind === "tool-start") && AGENT_CHAT_ASK_TOOLS.has(event.name)) return;
    // tool-start는 완성 tool 이벤트가 같은 스텝을 다시 세우므로 저널에 남기지 않는다 —
    // 남기면 재접속 리플레이에서 좌표 없는 빈 스텝이 한 줄 더 선다.
    if (event.kind === "text-delta" || event.kind === "tool-start") this.pushEphemeral(event);
    else this.push(event);
  }

  /** 살아 있는 잡의 집합을 이벤트대로 따라간다. `jobs`는 세는 것이 아니라 통째로 갈아 끼운다. */
  private trackJob(event: AgentChatStreamEvent): void {
    if (event.kind === "job") {
      this.liveJobs.add(event.id);
      // 같은 좌표가 다시 시작을 알렸다면 그것은 더 이상 끝난 잡이 아니다. 기억을 남겨 두면 바로
      // 다음 목록이 지금 일하고 있는 에이전트를 상주 항목으로 오인해 축에서 지운다.
      this.settledJobs.delete(event.id);
    } else if (event.kind === "job-end") {
      this.liveJobs.delete(event.id);
      this.settledJobs.add(event.id);
    } else if (event.kind === "jobs") {
      this.liveJobs.clear();
      for (const id of event.ids) {
        if (!this.settledJobs.has(id)) this.liveJobs.add(id);
      }
      const listed = new Set(event.ids);
      for (const id of [...this.settledJobs]) {
        if (!listed.has(id)) this.settledJobs.delete(id);
      }
    } else return;
    this.syncBackgroundPending();
  }

  /**
   * 살아 있는 잡 목록을 활동축의 백그라운드 대기값으로 접는다.
   *
   * 세는 것은 에이전트 작업뿐이다 — 서브에이전트(이름 붙은 팀메이트 포함)와 워크플로우. PTY 어댑터가
   * hook 목록에서 셸과 MCP 감시 작업을 빼는 것과 같은 계약이며, 이유도 같다: 사람이 기다리는 것은
   * 자기 일을 대신 하는 에이전트이지 그 에이전트가 남긴 명령이 아니고, 그것까지 세면 긴 백그라운드
   * 명령 하나가 세션을 유휴 밖에 세워 둔 채 유휴 휴면까지 막는다.
   *
   * 처음 보는 종류는 세지 않는다. PTY 쪽은 같은 자리에서 무의견으로 물러나지만 그 축에는 시한이
   * 있어 무의견이 영원하지 않다 — 이 축에는 시한이 없으므로, 여기서 물러나면 상주하는 미지 잡 하나가
   * 에이전트 작업이 다 끝난 뒤에도 배지를 영영 켜 둔다. 새 종류를 놓치는 쪽은 이 기능이 없던 상태로
   * 돌아갈 뿐이고, 그 종류는 화면의 잡 목록에 `other`로 서서 눈에 띈다.
   *
   * 턴 경계는 여기서 보지 않는다. 턴이 도는 동안에도 값은 서지만, 읽는 쪽이 작업 중을 앞세우므로
   * 화면에 나타나는 것은 턴이 닫힌 뒤부터다 — 그 순간이 곧 "남은 것은 백그라운드뿐"인 순간이다.
   */
  private syncBackgroundPending(): void {
    let pending = false;
    for (const id of this.liveJobs) {
      const kind = this.jobKinds.get(id);
      if (kind === "agent" || kind === "workflow") {
        pending = true;
        break;
      }
    }
    // 마지막으로 보낸 값을 여기 기억해 두지 않는다. 표면이 바뀌면 축은 스스로 비워지는데(인수·해제
    // 모두), 이쪽 기억은 그 사실을 모른 채 "이미 보냈다"며 다음 보고를 삼킨다. 원장이 바뀔 때마다
    // 절대값을 다시 보내고, 같은 값인지는 축을 가진 쪽이 판단하게 둔다.
    this.seed.reportBackgroundPending(pending);
  }

  /**
   * 턴 하나를 연다. 화면의 스피너와 활동축이 같은 순간에 켜지는 자리다.
   *
   * 이미 열려 있으면 다시 열지 않는다. 자식은 자기 큐를 갖고 있어 도는 중에도 메시지를 받는데
   * (백그라운드가 끝나 모델이 다시 깨어난 턴이 그 상태다), 그때 두 번째 `turn-start`를 세우면
   * 원장에 닫히지 않는 턴이 겹쳐 남는다 — 결말은 하나뿐이기 때문이다.
   */
  private openTurn(options: { readonly dispatched: boolean }): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.observedTurns += 1;
    // 자식이 스스로 연 턴은 자식이 이미 알고 있다. 디스패치가 연 턴은 `send()`가 닿아야 그렇다.
    this.turnReachedChild = !options.dispatched;
    this.push({ kind: "turn-start", at: Date.now() });
    // 디스패치 경로는 이미 축을 켜고 들어온다 — 실패하면 턴을 시작하지 않기 때문이다.
    if (!options.dispatched) this.seed.reportActivity(true);
  }

  /**
   * 열린 턴을 닫는다. 부르는 자리는 셋 — 자식의 `result`, 사용자의 중지, 세션의 소멸.
   *
   * 대기 중인 디스패치를 여기서 푼다. 그것이 풀려야 큐에 있던 다음 메시지가 시작하고, 풀리지
   * 않으면 세션은 조용히 멈춘 채 사용자의 다음 문장을 영영 받지 않는다.
   */
  private closeTurn(end: { readonly ok?: boolean; readonly stopped?: boolean; readonly durationMs?: number; readonly answer?: string }): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.turnReachedChild = false;
    this.push({
      kind: "turn-end",
      ok: end.ok ?? end.stopped !== true,
      ...(end.stopped === true ? { stopped: true } : {}),
      ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs }),
      ...(end.answer === undefined ? {} : { answer: end.answer }),
    });
    // 답이 풀리지 않은 채 턴이 닫히면 자식은 그 도구 호출에서 멈춘 채 남는다.
    this.abandonAsks("The turn ended before the question was answered.");
    // 남은 작업을 여기서 한 번 더 절대값으로 말한다. 이 축은 두 어댑터가 같은 필드에 쓰므로, 죽어가는
    // PTY의 마지막 정리나 뒤늦은 hook 하나가 채팅이 세운 값을 지울 수 있다 — 그리고 잡 원장은 다음
    // 잡이 뜨거나 끝날 때까지 다시 말하지 않는다. 작업 중 보고보다 **먼저** 말하는 것이 중요하다:
    // 순서를 뒤집으면 그 사이 한 프레임이 남은 작업을 잊은 채 유휴로 그려진다.
    this.syncBackgroundPending();
    this.seed.reportActivity(false);
    // 라이브 총량은 이 턴의 것이었다. 다음 턴의 첫 delta가 자기 값을 세울 때까지, 화면은 방금
    // 실린 총량을 그대로 들고 있는다 — 여기서 비우면 턴이 끝나는 순간 미터가 뒤로 간다.
    this.liveContextTotal = null;
    const awaiting = this.awaitingTurn;
    this.awaitingTurn = null;
    awaiting?.();
    this.releaseTurnCloseWaiters();
    // 방금 끝난 턴이 더한 몫의 **내역**은 여기서만 얻는다. 총량은 이미 delta가 실어 주었고,
    // 이 답은 30초쯤 뒤에 도착해 카테고리를 정정한다(실측). 세션이 없으면 물어볼 상대도 없다.
    const session = this.session;
    if (session) this.requestContextSnapshot(session, "end");
  }

  /** 자리가 비었음을 줄 서 있던 디스패치들에게 알린다. 결말 하나가 전부를 깨운다. */
  private releaseTurnCloseWaiters(): void {
    if (this.turnCloseWaiters.size === 0) return;
    const waiters = [...this.turnCloseWaiters];
    this.turnCloseWaiters.clear();
    for (const wake of waiters) wake();
  }

  /**
   * 열린 턴이 닫힐 때까지 기다린다.
   *
   * 억제가 아니라 대기여야 하는 이유: 열린 턴에 그냥 올라타면 그 턴의 `result`가 이 디스패치를
   * 풀어 버린다. 사용자의 프롬프트는 아직 자식 안에서 도는데 원장은 끝났다고 말하고, 큐의 다음
   * 메시지가 그 위에서 조기에 시작한다.
   */
  private async awaitTurnClose(): Promise<void> {
    if (!this.turnOpen && !this.settlingStoppedTurn) return;
    await new Promise<void>((resolve) => {
      this.turnCloseWaiters.add(resolve);
    });
  }

  /**
   * 자식이 사라졌다. 열린 턴과 살아 있던 잡을 정직하게 닫고, 다음 디스패치가 새 자식을 세우도록
   * 자리를 비운다.
   *
   * 잡을 `stopped`로 닫는 이유: 그 작업들은 자식과 함께 사라졌다. 원장에 "도는 중"으로 남겨 두면
   * 화면은 오지 않을 결말을 기다리고, 그 조용한 거짓말이 이 원장이 고치려던 바로 그것이다.
   */
  private retireSession(session: ClaudeGatewaySession): void {
    if (this.session === session) this.session = null;
    this.readerDone = null;
    // 스트림이 끝났다고 슬롯이 돌아오지는 않는다 — SDK 인스턴스는 `close()`를 받아야 자리를
    // 비운다. 부르지 않으면 다음 메시지의 openSession이 "이미 세션이 돈다"로 거절되고, 그때부터
    // 이 Operation은 dispose될 때까지 한 마디도 받지 못한다.
    try {
      session.close();
    } catch {
      // 이미 접힌 세션을 다시 닫는 것은 무해하다(계약상 멱등).
    }
    for (const id of [...this.liveJobs]) this.push({ kind: "job-end", id, status: "stopped" });
    this.liveJobs.clear();
    this.settledJobs.clear();
    // 원장이 비었으니 축도 비어야 한다. 여기서 걷지 않으면 자식과 함께 사라진 작업이 TTL이
    // 만료될 때까지 이 Operation을 백그라운드로 세워 둔다.
    this.syncBackgroundPending();
    // 자식이 사라졌으니 기다리던 결말은 오지 않는다. 표시를 걷고 줄을 풀어 준다 — 그러지 않으면
    // 다음 디스패치가 오지 않을 result를 영원히 기다린다.
    this.settlingStoppedTurn = false;
    this.closeTurn({ ok: false });
    this.releaseTurnCloseWaiters();
  }

  /**
   * 사용자의 메시지 하나를 자식에게 보내고 그 턴이 닫힐 때까지 기다린다.
   *
   * 기다리는 이유는 자식의 사정이 아니라 화면의 사정이다 — 자식은 자기 큐를 갖고 있어 턴 중에
   * 받아도 잃지 않지만, 원장은 턴 하나씩 그리므로 앞 턴이 닫힌 뒤 다음 디스패치를 세운다.
   */
  private async dispatch(text: string): Promise<void> {
    if (this.disposed) return;
    // 이 턴이 자기 세대를 기억한다. 도중에 중지가 눌리면 세대가 어긋나고, 그 어긋남이 곧
    // "실패가 아니라 중지"라는 판정이다.
    const epoch = this.stopEpoch;
    const stopped = (): boolean => epoch !== this.stopEpoch;
    // 자식이 스스로 깨어나 연 턴이 아직 돌고 있으면 그것이 닫힌 뒤에 선다. 그 턴에 올라타면
    // 남의 결말이 이 디스패치를 풀어, 아직 답하지도 않은 프롬프트가 끝난 것으로 그려진다.
    await this.awaitTurnClose();
    // 기다리는 동안 세션이 접혔거나 중지가 눌렸다면 이 턴은 시작하지 않는다.
    if (this.disposed || stopped()) return;
    this.push({ kind: "dispatch", text, at: Date.now() });
    // 활동 보고가 먼저다. 실패하면 자식을 부르지 않는다 — 턴이 도는데 축이 휴면이라고 말하는
    // 상태를 만들지 않기 위해, 여기서는 일을 시작하지 않는 쪽을 고른다.
    if (!this.seed.reportActivity(true)) {
      this.push({ kind: "error", code: "chat_activity_unavailable" });
      this.push({ kind: "turn-end", ok: false });
      return;
    }
    this.openTurn({ dispatched: true });
    try {
      const session = await this.ensureSession();
      // 세션을 여는 동안 중지가 눌렸다면 이 턴은 이미 아무도 기다리지 않는다. 자식은 그대로 두고
      // 턴만 접는다 — 세션은 다음 메시지의 것이다.
      if (stopped()) {
        this.closeTurn({ stopped: true });
        return;
      }
      // 세션을 얻은 뒤 이 자리에 닿기까지 자식이 죽었을 수 있다(startup 실패는 리더를 곧바로
      // 끝낸다). 폐기된 세션의 `send()`는 조용히 버려지므로 기다릴 결말도 생기지 않는다 —
      // 그 자리에 대기를 걸면 이 세션의 큐 전체가 영영 풀리지 않는다.
      if (this.session !== session) {
        this.closeTurn({ ok: false });
        return;
      }
      const settled = new Promise<void>((resolve) => {
        this.awaitingTurn = resolve;
      });
      // 문맥 내역은 보내기 **직전**에 묻는다. 턴이 돌기 시작하면 자식이 control 채널을 닫는다.
      this.requestContextSnapshot(session, "start");
      session.send(text);
      // 이제부터 이 턴은 자식의 것이기도 하다 — 중지해도 자식이 결말을 낸다.
      this.turnReachedChild = true;
      await settled;
    } catch {
      // 중지는 실패가 아니다 — 오류 줄을 세우면 사용자가 스스로 한 일을 고장으로 읽는다.
      if (stopped()) this.closeTurn({ stopped: true });
      else {
        this.push({ kind: "error", code: "chat_turn_failed" });
        this.closeTurn({ ok: false });
      }
    }
  }

  /**
   * 이 세션의 트랜스크립트 좌표를 Operation에 심는다.
   *
   * 공유 홈에서는 옮길 파일이 없다 — 트랜스크립트는 이미 정본 자리에서 자라고 있다. 남는 일은
   * 좌표를 확정하는 것뿐이며, 세션 id가 바뀌지 않는 한 다시 할 일도 없다(resume이 새 id를 낳는
   * 경우에만 다시 확정한다).
   */
  /**
   * 좌표 심기를 한 번에 하나만 날린다.
   *
   * 리더는 메시지마다 이 자리를 지난다. 첫 시도가 파일을 못 찾아 실패하는 것은 정상이므로
   * (자식이 아직 트랜스크립트를 만들지 않았다) 다음 메시지가 다시 시도해야 하는데, 가드가 없으면
   * 그 사이 도착한 메시지들이 같은 좌표를 겹쳐 심어 Operation write-back이 여러 번 인다.
   */
  private syncProviderSessionOnce(): void {
    // 날고 있는 동안 들어온 요청은 버리지 않고 기억한다. 첫 조회가 파일을 못 찾는 것은 정상
    // 경로이고(자식이 아직 트랜스크립트를 만들지 않았다), 그 재시도를 삼키면 마지막 프레임에서
    // 요청된 좌표가 영영 심기지 않는다.
    if (this.syncFlight) {
      this.syncDirty = true;
      return;
    }
    this.syncDirty = false;
    this.syncFlight = this.syncProviderSession()
      .catch(() => undefined)
      .finally(() => {
        this.syncFlight = null;
        // 아직 심지 못한 좌표가 남아 있을 때만 한 번 더 간다 — 심었다면 다시 갈 이유가 없다.
        if (this.disposed || !this.syncDirty) return;
        if (this.latestSessionId !== this.reportedSessionId) this.syncProviderSessionOnce();
      });
  }

  private async syncProviderSession(): Promise<void> {
    const sessionId = this.latestSessionId;
    if (!sessionId || sessionId === this.reportedSessionId) return;
    const transcriptPath = await this.locateTranscript(sessionId);
    // 좌표를 못 찾으면 심지 않는다 — 없는 파일을 durable 권위로 가리키면 터미널 복귀·재시작·
    // Analyst가 조용히 세션을 잃는다. 다음 턴이 다시 시도한다.
    if (!transcriptPath) return;
    this.reportedSessionId = sessionId;
    this.seed.onProviderSessionUpdate({
      harness: "claude-code",
      id: sessionId,
      transcriptPath,
      source: "chat-mode",
      capturedAt: new Date().toISOString(),
    });
  }

  /**
   * 세션 id가 앉은 트랜스크립트 파일. resume은 원 경로의 이웃을 먼저 보고, 없으면 projects
   * 아래를 훑는다 — cwd → 디렉터리 이름 인코딩 규칙을 재구현하지 않기 위해서이고, 세션 id가
   * 고유하므로 훑어서 찾은 것은 우리 것이 맞다.
   *
   * 공유 홈에는 남의 세션도 함께 산다. 격리 dir 시절의 "디렉터리가 하나뿐"이라는 지름길은
   * 여기서 성립하지 않는다.
   */
  private async locateTranscript(sessionId: string): Promise<string | null> {
    if (this.seed.origin.kind === "resume") {
      const sibling = path.join(path.dirname(this.seed.origin.transcriptPath), `${sessionId}.jsonl`);
      if (await isExistingFile(sibling)) return sibling;
    }
    const projectsRoot = path.join(this.seed.claudeConfigDir, "projects");
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => null);
    if (!entries) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
      if (await isExistingFile(candidate)) return candidate;
    }
    return null;
  }
}

async function isExistingFile(candidate: string): Promise<boolean> {
  const stat = await fs.stat(candidate).catch(() => null);
  return stat?.isFile() === true;
}

export class AgentChatRegistry {
  private readonly sessions = new Map<string, AgentChatSession>();
  private readonly ensureFlights = new Map<string, Promise<AgentChatSession>>();
  /** dispose 진행 중 tombstone — 이 창에서의 ensure 재진입이 두 번째 필자를 만든다. */
  private readonly disposals = new Map<string, Promise<void>>();
  private readonly createSdk: CreateChatSdk;

  constructor(createSdk: CreateChatSdk = (options) => createClaudeGatewaySdk(options)) {
    this.createSdk = createSdk;
  }

  has(operationId: string): boolean {
    return this.sessions.has(operationId);
  }

  isBusy(operationId: string): boolean {
    return this.sessions.get(operationId)?.busy === true;
  }

  /** 세션이 없으면 만들고 트랜스크립트를 재생한다. 동시 진입은 한 생성으로 수렴한다. */
  async ensure(operationId: string, seed: () => AgentChatSessionSeed): Promise<AgentChatSession> {
    // dispose가 진행 중이면 새 세션을 만들지 않는다 — 터미널 복귀와 경합해 같은 Claude 세션의
    // 이중 필자가 되는 창이다. 호출자(스트림·메시지 라우트)는 chat_unavailable로 답한다.
    if (this.disposals.has(operationId)) throw new Error("chat_session_disposing");
    const existing = this.sessions.get(operationId);
    if (existing) return existing;
    const inFlight = this.ensureFlights.get(operationId);
    if (inFlight) return inFlight;
    const flight = (async () => {
      const session = new AgentChatSession(operationId, seed(), this.createSdk);
      await session.replayTranscript();
      this.sessions.set(operationId, session);
      return session;
    })().finally(() => {
      this.ensureFlights.delete(operationId);
    });
    this.ensureFlights.set(operationId, flight);
    return flight;
  }

  get(operationId: string): AgentChatSession | undefined {
    return this.sessions.get(operationId);
  }

  async dispose(operationId: string): Promise<void> {
    const pending = this.disposals.get(operationId);
    if (pending) return pending;
    // tombstone은 동기로 먼저 세운다 — 이후 도착하는 ensure는 전부 거부되고, 이미 in-flight인
    // 생성은 완주를 기다린 뒤 접는다. 그냥 돌아가면 DELETE가 터미널을 되살린 뒤에 pending
    // ensure가 chat 세션을 등록해 같은 Claude 세션의 이중 필자가 된다.
    const disposal = (async () => {
      const flight = this.ensureFlights.get(operationId);
      if (flight) await flight.then(() => undefined, () => undefined);
      const session = this.sessions.get(operationId);
      if (!session) return;
      this.sessions.delete(operationId);
      await session.dispose();
    })();
    this.disposals.set(operationId, disposal);
    try {
      await disposal;
    } finally {
      this.disposals.delete(operationId);
    }
  }

  async disposeAll(): Promise<void> {
    const operationIds = new Set([...this.sessions.keys(), ...this.ensureFlights.keys()]);
    await Promise.all([...operationIds].map((operationId) => this.dispose(operationId)));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Anthropic usage에서 **창을 점유한** 입력 토큰을 읽는다.
 *
 * 세 자리를 더하는 이유는 캐시가 점유를 줄이지 않기 때문이다 — 캐시로 읽은 토큰도 창에는 그대로
 * 앉아 있다. 실측하면 이 합이 자식이 세는 spent 총량과 같은 수였다(도구를 다섯 번 돈 턴에서
 * 50+14,795 · 539+14,839 · 250+15,372 · 190+15,595, 마지막 값이 턴 종료 스냅숏과 일치).
 *
 * `output_tokens`는 더하지 않는다. 그것은 다음 호출의 입력이 되어 그때 위 세 자리에 나타난다.
 * 한 자리도 못 읽으면 `null`이며, 그 프레임은 침묵한다 — 0은 사실이 아니라 빈칸이다.
 */
function readClaudeOccupiedInputTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  let total = 0;
  let found = false;
  for (const field of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    const tokens = usage[field];
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) continue;
    total += tokens;
    found = true;
  }
  return found ? total : null;
}
