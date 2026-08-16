import { promises as fs } from "node:fs";
import path from "node:path";

import {
  createClaudeGatewaySdk,
  type ClaudeGatewayEffort,
  type ClaudeGatewayMessage,
  type ClaudeGatewayRun,
  type ClaudeGatewaySdk,
  type ClaudeGatewaySdkOptions,
  type ClaudeGatewayServedMcpServer,
  type ClaudeGatewaySystemPrompt,
} from "@dotobokuri/core-agent/claude";

import {
  AGENT_CHAT_ASK_TOOLS,
  agentChatAskFromToolInput,
  chatEventsFromSdkMessage,
  chatReplayFromTranscriptLine,
  chatShellTailFromOutput,
  chatSubagentTrailFromTranscript,
  type AgentChatJobDetail,
  type AgentChatJobKind,
  type AgentChatJournalEvent,
  type AgentChatQuestion,
  type AgentChatStreamEvent,
} from "./chat-events.js";
import { chatChildEnv } from "../shared/launch-env.js";
import type { AgentProviderSession } from "./types.js";

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
  readonly effort?: ClaudeGatewayEffort;
  readonly cwd: string;
  /**
   * 사용자의 실제 Claude 홈(`CLAUDE_CONFIG_DIR` 또는 `~/.claude`). 터미널로 띄운 CLI가 쓰는
   * 바로 그 홈이며, 트랜스크립트가 한 자리에서 자라는 근거다.
   */
  readonly claudeConfigDir: string;
  readonly origin: AgentChatSessionOrigin;
  /**
   * Fleet Admiral 지시. 같은 Operation을 터미널에서 열면 CLI가 `--append-system-prompt`로 받는
   * 그 문서이며, Chat Mode가 없으면 doctrine 없이 도는 맨 Claude 세션이 된다 — 표면만 다른
   * 같은 세션이 표면에 따라 다른 규율로 답하는 것이 이 필드가 있는 이유다.
   *
   * `undefined`는 결함이 아니라 사용자의 prompt 모드 설정(`off`)이다.
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
   * Fleet 플러그인 루트를 렌더하고 그 경로를 돌려준다. 스킬·게이트웨이 정체성·정책 훅이 전부
   * 이 디렉터리 한 벌로 실린다 — 터미널 세션이 `--plugin-dir`로 받는 것과 같은 것이다.
   */
  readonly resolveFleetPluginRoots?: () => Promise<readonly string[]>;
  /** 위에서 발급한 토큰을 되돌린다. 세션 dispose에서만 불린다. */
  readonly releaseFleetMcpServers?: () => void;
  readonly onProviderSessionUpdate: (providerSession: AgentProviderSession) => void;
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
const TOOL_NAME_CAP = 500;
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
  private journal: AgentChatJournalEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(event: AgentChatJournalEvent) => void>();
  private turnFlight: Promise<void> = Promise.resolve();
  private pendingTurns = 0;
  private disposed = false;
  /**
   * 지금 도는 턴의 런. `runTurn`의 지역 변수로 두면 밖에서 닿을 수 없어 중지가 불가능하다 —
   * 이 필드가 곧 중지 레버이며, 턴이 끝나면 반드시 null로 돌아간다(스스로 close된 런을 들고
   * 있으면 다음 중지가 이미 죽은 런을 닫고 성공했다고 답한다).
   */
  private activeRun: ClaudeGatewayRun | null = null;
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
    // 채팅으로 태어난 세션에는 되돌려줄 과거가 없다 — 빈 리플레이는 "읽지 못했다"와 다르므로
    // 오류 이벤트도 내지 않고, 로그는 첫 턴부터 자란다.
    if (this.seed.origin.kind === "fresh") return;
    const transcriptPath = this.seed.origin.transcriptPath;
    this.push({ kind: "replay-start" });
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
    try {
      const raw = await fs.readFile(transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const mapped = chatReplayFromTranscriptLine(line, { cwd: this.seed.cwd, toolNames: this.toolNames });
        for (const event of mapped.events) {
          if (event.kind === "dispatch") {
            closeReplayedTurn();
            turns += 1;
            turnAt = mapped.at ?? null;
          }
          this.rememberTool(event);
          this.push(event);
        }
        if (mapped.events.length > 0 && mapped.at !== undefined) lastAt = mapped.at;
      }
      closeReplayedTurn();
    } catch {
      // 트랜스크립트를 읽지 못해도 세션은 계속된다 — 로그가 비어 보일 뿐 새 턴은 돌 수 있다.
      this.push({ kind: "error", code: "chat_replay_unavailable" });
    }
    this.push({ kind: "replay-end", turns });
  }

  /** 저널 전체를 되돌려준 뒤 라이브 이벤트를 흘린다. 반환값은 구독 해제다. */
  subscribe(listener: (event: AgentChatJournalEvent) => void): () => void {
    for (const entry of this.journal) listener(entry);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

  send(text: string): void {
    if (this.disposed) return;
    const epoch = this.stopEpoch;
    this.pendingTurns += 1;
    this.turnFlight = this.turnFlight
      // 큐에서 기다리는 동안 중지가 눌렸다면 이 턴은 시작하지 않는다. 시작한 뒤 끊으면 모델을
      // 한 번 깨우고 그 대가를 치른 다음 버리는 셈이라, 사용자가 멈춘 것을 그대로 실행한 것이 된다.
      .then(() => (epoch === this.stopEpoch ? this.runTurn(text) : undefined))
      .catch(() => undefined)
      .finally(() => {
        this.pendingTurns -= 1;
      });
  }

  /**
   * 도는 턴을 사용자가 끊는다.
   *
   * 이 자리가 여는 문은 **턴 하나**다. 잡 하나만 멈추는 길은 `TaskStop`뿐인데 그것은 모델이
   * 부르는 도구이고 호스트에게는 그 제어 경로가 없다(SDK 0.3.212 실측). 그래서 여기서 잡을
   * 멈추는 척하지 않는다 — 턴을 끊어도 이미 태어난 백그라운드 작업은 계속 살고, 원장의 잡
   * 표면이 그것을 그대로 말한다.
   *
   * 돌려주는 값은 "끊을 것이 있었는가"다. 없는데 true를 돌려주면 화면이 멈춤을 그리고 아무 일도
   * 일어나지 않는다.
   */
  stopTurn(): boolean {
    if (this.disposed) return false;
    if (this.pendingTurns === 0) return false;
    this.stopEpoch += 1;
    const run = this.activeRun;
    this.activeRun = null;
    // 붙들린 권한 응답을 먼저 푼다. 남겨 두면 close된 스트림을 기다리는 promise 하나가 남아
    // 다음 턴이 영영 시작하지 못한다 — 턴 종료 경로가 비우는 그 맵을 여기서도 비워야 한다.
    this.abandonAsks("The turn was stopped before the question was answered.");
    run?.close();
    return true;
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
    this.abandonAsks("The chat session closed before the question was answered.");
    // SDK를 먼저 접는다 — dispose가 활성 런을 close해 진행 중 턴을 끊는다. 순서를 뒤집어
    // 턴 완주를 먼저 기다리면, 멈춘 턴 하나가 Operation 삭제·Console 셧다운을 무기한 막는다.
    const sdk = this.sdk;
    this.sdk = null;
    if (sdk) await sdk.dispose().catch(() => undefined);
    await this.turnFlight.catch(() => undefined);
    // 발급이 아직 날고 있으면 그것부터 착지시킨다 — 먼저 반납하면 뒤늦게 도착한 토큰이 주인
    // 없이 남는다. 반납 자체는 라벨로 지우므로 발급된 적 없는 세션에서도 무해하다.
    if (this.fleetMcpFlight) await this.fleetMcpFlight.catch(() => undefined);
    this.seed.releaseFleetMcpServers?.();
    this.listeners.clear();
  }

  /** 도구 이벤트가 지나갈 때 id→이름을 적어 둔다. 결과 요약 정책이 이 축 위에서 결정된다. */
  private rememberTool(event: AgentChatStreamEvent): void {
    // 잡의 종류는 상세를 어디서 읽어야 하는지를 정한다 — 서브에이전트는 전사록, 셸은 출력 파일.
    // 그리고 이 맵이 곧 상세 라우트의 첫 번째 문이다: 여기 없는 id는 파일 시스템에 닿기 전에
    // 거절된다. task_id는 SDK만 발급하므로 브라우저가 지어낸 좌표는 이 문을 통과할 수 없다.
    if (event.kind === "job") {
      this.jobKinds.set(event.id, event.jobKind);
      if (this.jobKinds.size > JOB_KIND_CAP) {
        const oldest = this.jobKinds.keys().next();
        if (!oldest.done) this.jobKinds.delete(oldest.value);
      }
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

  private async ensureSdk(): Promise<ClaudeGatewaySdk> {
    if (this.sdk) return this.sdk;
    if (!this.sdkFlight) {
      this.sdkFlight = (async () => {
        // 플러그인을 못 실으면 스킬도 게이트웨이 정체성도 정책 훅도 없는 세션이 된다. 세션을
        // 죽일 사유는 아니지만 조용히 넘길 사유도 아니다 — 같은 Operation을 터미널로 열었을
        // 때와 다른 능력을 갖게 되고, 그 차이는 화면 어디에도 드러나지 않는다.
        const pluginRoots = await (this.seed.resolveFleetPluginRoots?.() ?? Promise.resolve([]))
          .catch(() => {
            this.push({ kind: "error", code: "chat_fleet_plugin_unavailable" });
            return [] as readonly string[];
          });
        const sdk = await this.createSdk({
          baseUrl: this.seed.baseUrl,
          models: [this.seed.model],
          // 공유 홈이다 — 이 세션의 트랜스크립트는 터미널이 읽는 그 파일이고, 옮겨 올 사본이 없다.
          home: { kind: "shared", configDir: this.seed.claudeConfigDir },
          // Chat Mode는 같은 세션의 다른 얼굴이다. 터미널로 열었을 때 CLI가 읽는 층을 그대로
          // 읽어야 리포의 `CLAUDE.md`와 사용자 설정을 같은 세션이 표면에 따라 잃지 않는다.
          settingSources: ["user", "project", "local"],
          allowAmbientMcpServers: true,
          // 플러그인이 실은 훅은 세션 식별자로 자기 축을 찾는다. 이 자식에게는 그 식별자가
          // 없어야 한다 — 상속된 값이 남으면 남의 세션 축에 보고한다.
          env: chatChildEnv(process.env),
          ...(pluginRoots.length > 0 ? { plugins: pluginRoots.map((root) => ({ path: root })) } : {}),
        });
        if (this.disposed) {
          await sdk.dispose().catch(() => undefined);
          throw new Error("chat session disposed");
        }
        this.sdk = sdk;
        return sdk;
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

  private async runTurn(text: string): Promise<void> {
    if (this.disposed) return;
    // 이 턴이 자기 세대를 기억한다. 도중에 중지가 눌리면 세대가 어긋나고, 그 어긋남이 곧
    // "실패가 아니라 중지"라는 판정이다 — close된 스트림은 조용히 끝날 수도, 던질 수도 있어서
    // 예외 유무로는 두 결말을 가를 수 없다.
    const epoch = this.stopEpoch;
    const stopped = (): boolean => epoch !== this.stopEpoch;
    this.push({ kind: "dispatch", text, at: Date.now() });
    this.push({ kind: "turn-start", at: Date.now() });
    // 활동 보고가 먼저다. 실패하면 SDK를 부르지 않는다 — 턴이 도는데 축이 휴면이라고 말하는
    // 상태를 만들지 않기 위해, 여기서는 일을 시작하지 않는 쪽을 고른다.
    if (!this.seed.reportActivity(true)) {
      this.push({ kind: "error", code: "chat_activity_unavailable" });
      this.push({ kind: "turn-end", ok: false });
      return;
    }
    // 하나의 startTurn이 result를 여러 번 낸다. 백그라운드 작업이 끝나면 SDK가 새 system/init과
    // 함께 모델을 다시 깨우고, 그 응답이 두 번째 result로 닫힌다(2026-08-16 실측). 닫힌 턴에
    // 그 응답을 이어 붙이면 앞 턴의 Answer가 갈아치워지므로, 내용이 다시 흐르기 시작하면
    // 디스패치 없는 새 턴을 연다.
    //
    // 그래서 이 축은 "result를 본 적 있는가"가 아니라 "지금 열려 있는 턴이 닫혔는가"다. 전자로
    // 정리 경로를 판단하면, 후속 턴이 열린 뒤 스트림이 두 번째 result 없이 끝나거나 던질 때
    // 아무도 그 턴을 닫지 않아 원장에 영원히 도는 스피너가 남는다.
    let turnClosed = false;
    try {
      const sdk = await this.ensureSdk();
      // Fleet 도구를 못 붙이는 것은 세션을 죽일 사유가 아니지만 조용히 넘길 사유도 아니다 —
      // 도구 없이 도는 턴은 게이트웨이 로스터를 읽지 못한 채 위임을 판단한다.
      const fleetMcpServers = await this.ensureFleetMcpServers().catch(() => {
        this.push({ kind: "error", code: "chat_fleet_tools_unavailable" });
        return [] as readonly ClaudeGatewayServedMcpServer[];
      });
      const run = await sdk.startTurn({
        prompt: text,
        model: this.seed.model,
        ...(this.seed.effort ? { effort: this.seed.effort } : {}),
        ...(this.seed.systemPrompt ? { systemPrompt: this.seed.systemPrompt } : {}),
        ...(fleetMcpServers.length > 0 ? { servedMcpServers: fleetMcpServers } : {}),
        cwd: this.seed.cwd,
        // 채팅으로 태어난 세션의 첫 턴에는 이어붙일 좌표가 없다 — resume 없이 시작하고,
        // SDK가 돌려주는 session_id가 그 자리를 채운다(그다음 턴부터는 resume이 선다).
        ...(this.latestSessionId ? { resume: this.latestSessionId } : {}),
        permissionMode: "bypassPermissions",
        // 이 콜백은 권한 게이트가 아니다. 모드는 그대로 bypass이고 평범한 도구는 여기서 그냥
        // 통과한다 — 콜백을 주는 이유는 그래야 자식이 대화형 도구를 갖기 때문이다(실측: 29→32).
        canUseTool: (name, input, context) => this.askUser(name, input, context),
        // 스트리밍 감각의 근거 — 글자 단위 text_delta를 받으려면 부분 메시지가 필요하다.
        includePartialMessages: true,
      });
      // 중지 레버를 여기서 건다. startTurn을 기다리는 동안 중지가 눌렸다면 이 런은 이미 아무도
      // 기다리지 않는 턴의 것이므로, 붙잡아 두지 않고 곧바로 접는다.
      if (stopped()) {
        run.close();
        this.push({ kind: "turn-end", ok: false, stopped: true });
        return;
      }
      this.activeRun = run;
      try {
        for await (const message of run as AsyncIterable<ClaudeGatewayMessage>) {
          if (typeof message.session_id === "string" && message.session_id.length > 0) {
            this.latestSessionId = message.session_id;
          }
          this.rememberJobOutput(message);
          for (const event of chatEventsFromSdkMessage(message, { cwd: this.seed.cwd, toolNames: this.toolNames })) {
            if (event.kind === "turn-end") {
              turnClosed = true;
            } else if (turnClosed && opensChatTurn(event)) {
              this.push({ kind: "turn-start", at: Date.now() });
              turnClosed = false;
            }
            this.rememberTool(event);
            // 대화형 도구는 스텝을 세우지 않는다 — 카드가 이미 그 자리에 서 있고, 그 옆에 "질문함"
            // 한 줄을 더 세우면 같은 사건이 두 번 읽힌다. 결과 줄은 짝을 못 찾아 스스로 버려진다.
            if ((event.kind === "tool" || event.kind === "tool-start") && AGENT_CHAT_ASK_TOOLS.has(event.name)) continue;
            // tool-start는 완성 tool 이벤트가 같은 스텝을 다시 세우므로 저널에 남기지 않는다 —
            // 남기면 재접속 리플레이에서 좌표 없는 빈 스텝이 한 줄 더 선다.
            if (event.kind === "text-delta" || event.kind === "tool-start") this.pushEphemeral(event);
            else this.push(event);
          }
        }
      } finally {
        // 정상 소진이면 no-op, 도중 이탈이면 슬롯 반납 — 없으면 다음 턴이 영영 막힌다.
        this.activeRun = null;
        run.close();
      }
      // 끊긴 스트림은 던지지 않고 조용히 끝나기도 한다 — 그래서 성공 경로에서도 세대를 본다.
      if (!turnClosed) {
        if (stopped()) this.push({ kind: "turn-end", ok: false, stopped: true });
        else this.push({ kind: "turn-end", ok: true });
      }
      // 중지된 턴에서도 좌표를 심는다. 그때까지 실제로 오간 대화는 파일에 남았고, 좌표를 심지
      // 않으면 다음 턴의 resume이 사용자가 본 것보다 짧은 과거 위에 선다.
      await this.syncProviderSession();
    } catch {
      this.activeRun = null;
      // 중지는 실패가 아니다 — 오류 줄을 세우면 사용자가 스스로 한 일을 고장으로 읽는다.
      if (stopped()) {
        if (!turnClosed) this.push({ kind: "turn-end", ok: false, stopped: true });
        await this.syncProviderSession().catch(() => undefined);
      } else {
        this.push({ kind: "error", code: "chat_turn_failed" });
        if (!turnClosed) this.push({ kind: "turn-end", ok: false });
      }
    } finally {
      // 정상 경로에서는 이미 비어 있다(답이 풀려야 스트림이 끝난다). 중단된 턴에서만 일이 있다.
      this.abandonAsks("The turn ended before the question was answered.");
      this.seed.reportActivity(false);
    }
  }

  /**
   * 이 세션의 트랜스크립트 좌표를 Operation에 심는다.
   *
   * 공유 홈에서는 옮길 파일이 없다 — 트랜스크립트는 이미 정본 자리에서 자라고 있다. 남는 일은
   * 좌표를 확정하는 것뿐이며, 세션 id가 바뀌지 않는 한 다시 할 일도 없다(resume이 새 id를 낳는
   * 경우에만 다시 확정한다).
   */
  private async syncProviderSession(): Promise<void> {
    const sessionId = this.latestSessionId;
    if (!sessionId || sessionId === this.reportedSessionId) return;
    const transcriptPath = await this.locateTranscript(sessionId);
    // 좌표를 못 찾으면 심지 않는다 — 없는 파일을 durable 권위로 가리키면 터미널 복귀·재시작·
    // Analyst가 조용히 세션을 잃는다. 다음 턴이 다시 시도한다.
    if (!transcriptPath) return;
    this.reportedSessionId = sessionId;
    this.seed.onProviderSessionUpdate({
      provider: "claude",
      sessionId,
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
