import { homedir } from "node:os";

/**
 * Chat Mode의 브라우저行 이벤트 어휘와, 두 원천(트랜스크립트 JSONL·SDK 메시지 스트림)을
 * 같은 어휘로 옮기는 매퍼.
 *
 * 이벤트에는 텍스트·도구 요약·도구 결과 요약만 싣는다 — providerSession 식별자·트랜스크립트
 * 경로·원문 파일 경로는 서버 상태로만 남는다(Console 보안 계약). 도구 결과는 첫 줄만, 상한
 * 아래로, 경로 정규화와 자격 증명 마스킹을 통과한 뒤에야 나간다. thinking 블록은 두 원천
 * 모두에서 버린다 — thought 내용은 공개 출력 꼬리가 되어선 안 된다(Terminal 플러그인 불변식).
 */

/** 쓰기 계열 도구가 남긴 파일 변경 — 도구 입력에서 접는다(원문 본문은 싣지 않는다). */
export interface AgentChatChange {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
}

export interface AgentChatQuestionOption {
  readonly label: string;
  readonly description: string;
}

/**
 * 모델이 사용자에게 내민 질문 하나. 다른 도구 입력과 달리 본문을 그대로 싣는다 — 이 문장들은
 * 모델이 **사용자에게 보여주려고** 쓴 것이라, 실행 결과가 새는 경로가 아니다. 대신 상한은 진다.
 */
export interface AgentChatQuestion {
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: readonly AgentChatQuestionOption[];
}

/** 답을 기다리는 두 형태. 통로(canUseTool)는 하나지만 화면에서 하는 말이 다르다. */
export type AgentChatAskForm = "question" | "plan";

/**
 * 턴보다 오래 사는 작업의 종류. SDK의 `task_type`을 제품 어휘로 접는다 —
 * `local_agent`/`local_bash`/`local_workflow`가 오늘 실제로 도착하는 값이고,
 * 새 종류는 `other`로 떨어져 조용히 사라지지 않는다.
 */
export type AgentChatJobKind = "agent" | "shell" | "workflow" | "other";

/** 잡의 결말. SDK `task_notification.status`를 그대로 옮긴 축이다. */
export type AgentChatJobStatus = "completed" | "failed" | "stopped";

/** 워크플로 한 단계 안에서 돈 에이전트 하나. 값은 전부 `task_progress`가 실어 온다. */
export interface AgentChatJobAgent {
  readonly label: string;
  /** 이 에이전트가 핀된 신원. Fleet이 이 표면을 만드는 이유다. */
  readonly model?: string;
  readonly state: string;
  readonly tokens?: number;
  readonly tools?: number;
  readonly durationMs?: number;
  /** 에이전트가 돌려준 값의 첫 줄 — 도구 결과와 같은 문(캡·마스킹·경로 정규화)을 지난다. */
  readonly result?: string;
}

/** 워크플로 단계 하나와 그 아래에서 돈 에이전트들. */
export interface AgentChatJobStage {
  readonly title: string;
  readonly agents: readonly AgentChatJobAgent[];
}

/** 문맥 창을 나눠 쓰는 한 덩어리. */
export interface AgentChatContextSlice {
  readonly name: string;
  readonly tokens: number;
}

export type AgentChatStreamEvent =
  | { readonly kind: "replay-start" }
  /** 접속 시점의 snapshot이 모두 도착했다. 이 앞의 live opener는 복원이지 새 도착이 아니다. */
  | { readonly kind: "snapshot-end"; readonly turns: number }
  /**
   * 이 턴이 **시작될 때까지의** 문맥 창 내역.
   *
   * 종료 시점이 아닌 이유는 실측이다: 자식은 턴이 시작되면 control 채널을 닫아, 턴이 시작하는
   * 그 순간의 요청만 답을 받는다(+0ms 성공, +250ms부터 턴이 끝날 때까지 전부 거절). 그래서 방금
   * 끝난 턴이 더한 몫은 다음 턴이 시작될 때 비로소 드러나고, 화면은 그 지연을 감추지 않는다.
   *
   * 저널에 남는 이유는 두 가지다: 재접속한 브라우저가 지금 총량을 되찾고, 지나간 턴이 각자
   * 자기 시작 시점의 총량을 간직해 턴별 증가분이 재생에서도 같은 값으로 읽힌다.
   */
  | {
      readonly kind: "context";
      /** 실제로 쓰인 몫의 합. 예약분과 남은 자리는 여기 들어가지 않는다. */
      readonly total: number;
      readonly max: number;
      /** 자동 압축을 위해 미리 비워 둔 자리. 쓴 것이 아니지만 쓸 수도 없다. */
      readonly reserved?: number;
      /** 자동 압축이 걸리는 지점. 꺼져 있으면 생략한다 — 없는 임계선을 그리지 않기 위해서다. */
      readonly compactAt?: number;
      readonly slices: readonly AgentChatContextSlice[];
      readonly memoryFiles?: readonly AgentChatContextSlice[];
      readonly mcpTools?: readonly AgentChatContextSlice[];
      /**
       * 이 내역이 언제의 것인가. 부재는 `"start"`이며 그것이 옛 저널의 뜻이기도 하다.
       *
       * 두 값이 갈리는 자리는 총량이다. `"start"`는 이 턴이 **시작될 때**의 값이라 턴이 도는 동안
       * 흐른 라이브 총량보다 작을 수 있고, 그때 총량까지 갈아 끼우면 화면의 숫자가 뒤로 간다.
       * `"end"`는 턴이 닫힌 뒤 다시 물어 받은 값이므로 무조건 권위다.
       */
      readonly asOf?: "start" | "end";
    }
  /**
   * 턴이 도는 동안의 총량. **라이브 전용이며 저널에 싣지 않는다.**
   *
   * control 채널로는 이 값을 얻을 수 없다 — 실측하면 그 왕복이 21~88초이고 요청이 직렬로 줄을
   * 서므로, 턴 중에 물어 봐야 답은 턴이 끝난 뒤에 온다. 대신 SDK가 모델 호출마다 흘리는
   * `message_delta`의 usage를 읽는다. 그 합(`input_tokens` + 캐시 읽기/쓰기)은 자식이 세는
   * spent 총량과 **같은 수**였고(실측 5건 일대일), 그래서 이것은 추정이 아니라 측정이다.
   *
   * 내역은 실리지 않는다. 카테고리 분해는 control 채널만 알고, 그것은 턴이 닫힌 뒤에 온다.
   */
  | { readonly kind: "context-live"; readonly total: number; readonly max: number }
  | { readonly kind: "replay-end"; readonly turns: number }
  | { readonly kind: "dispatch"; readonly text: string; readonly at?: number }
  | { readonly kind: "turn-start"; readonly at?: number }
  | { readonly kind: "text"; readonly text: string }
  /** 라이브 전용 글자 단위 델타 — 저널에는 싣지 않는다. 완성 text 이벤트가 정정 앵커다. */
  | { readonly kind: "text-delta"; readonly text: string }
  /**
   * 도구 이름이 인자보다 먼저 알려지는 경로. 프로바이더는 이름을 올린 뒤 인자 JSON을 몇 초에
   * 걸쳐 흘리고(실측 8.5s), 게이트웨이는 그 자리에서 content_block_start를 낸다
   * (core-ai-gateway anthropic/protocol.ts).
   *
   * 다만 **오늘 이 이벤트는 실제로 도착하지 않는다**: Agent SDK 0.3.212의 `stream_event`는
   * 타입상 BetaRawMessageStreamEvent 전부를 실을 수 있지만, 실측(2026-08-16, 34초짜리 Write
   * 한 건)에서 tool_use 블록의 시작은 한 번도 넘어오지 않았고 완성 assistant 메시지가 올 때에야
   * 스텝이 섰다. 매핑을 남겨 두는 이유는 그 경로가 열리는 즉시 8.5초가 회수되기 때문이고,
   * 그때까지 그 공백은 원장 꼬리의 "생각 중" 한 줄이 진다.
   *
   * 라이브 전용이다 — 재생 때는 완성 tool 이벤트가 같은 스텝을 세운다.
   */
  | { readonly kind: "tool-start"; readonly id: string; readonly name: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly detail: string;
      /** tool-start·tool-result와 같은 스텝임을 잇는 축. 트랜스크립트 재생에도 실린다. */
      readonly id?: string;
      /** 좌표가 Operation cwd 밖을 가리킨다 — 표시형으로 접히면 구별되지 않으므로 따로 싣는다. */
      readonly outside?: boolean;
      readonly change?: AgentChatChange;
    }
  /** 스텝의 결말. ok는 도구가 돌려준 사실이지 턴의 성패가 아니다. */
  | { readonly kind: "tool-result"; readonly id: string; readonly ok: boolean; readonly summary: string }
  /**
   * 모델이 멈춰 서서 사용자를 기다린다. 저널에 남는 이벤트여야 하는 이유는 만료가 없기 때문이다 —
   * 재접속한 브라우저가 이 이벤트로 같은 카드를 다시 세우지 못하면, 대기는 영영 보이지 않는 채로
   * 세션 하나를 붙든다.
   */
  | {
      readonly kind: "ask";
      /** tool_use id. 답변 라우트가 이 좌표로 대기 중인 질문을 찾는다. */
      readonly id: string;
      readonly form: AgentChatAskForm;
      /** form="question"일 때의 질문들. */
      readonly questions?: readonly AgentChatQuestion[];
      /** form="plan"일 때의 계획 본문(마크다운). */
      readonly plan?: string;
      /**
       * 계획이 상한에 잘렸다. 승인은 "본 것에 동의한다"는 뜻이라, 보여 주지 못한 단계가 있으면
       * 카드는 승인을 열지 않는다 — 잘린 앞부분만 보고 누른 승인은 전문을 통과시킨다.
       */
      readonly truncated?: true;
    }
  /** 그 대기의 결말. answered/dismissed는 질문, approved/revised는 계획이 쓴다. */
  | {
      readonly kind: "ask-settled";
      readonly id: string;
      readonly outcome: "answered" | "dismissed" | "approved" | "revised";
      /** 접힌 줄이 보일 값 — header → 사용자가 고른 것. */
      readonly answers?: readonly { readonly header: string; readonly value: string }[];
    }
  /** answer는 SDK result가 말한 최종 응답 텍스트다 — 클라이언트가 마지막 text를 Answer로 승격할 때의 서버 권위. */
  /**
   * `stopped`는 사용자가 끊은 턴이다 — 실패와 같은 자리에 두지 않는 이유는 결말이 다르기 때문이다.
   * 실패는 "하려던 일이 안 됐다"이고 중지는 "하려던 일을 그만두게 했다"이며, 후자에는 고칠 것이 없다.
   */
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number; readonly answer?: string; readonly stopped?: boolean }
  /**
   * 턴보다 오래 사는 작업 하나가 등록됐다. 이 축이 원장의 턴 시계와 별개로 존재해야 하는
   * 이유는 단순하다 — 백그라운드 작업은 정의상 턴을 넘겨서 살고, 턴 시계 하나로는 그것을
   * 참되게 말할 수 없다. `id`는 SDK의 `task_id`이며 잡의 유일한 좌표다.
   */
  | {
      readonly kind: "job";
      readonly id: string;
      readonly jobKind: AgentChatJobKind;
      readonly title: string;
      /** 이 잡을 낳은 도구 스텝. 원장의 그 줄과 잡을 잇는다. */
      readonly toolUseId?: string;
      /** 서브에이전트 유형 또는 워크플로 이름 — "누구의 작업인가"의 답. */
      readonly who?: string;
      readonly at?: number;
    }
  /** 도는 동안의 맥박. 값이 없는 필드는 싣지 않는다(0과 미상은 다르다). */
  | {
      readonly kind: "job-progress";
      readonly id: string;
      readonly note?: string;
      readonly tokens?: number;
      readonly tools?: number;
      readonly durationMs?: number;
      readonly lastTool?: string;
      readonly stages?: readonly AgentChatJobStage[];
    }
  /**
   * 잡의 결말. `stopped`는 실패가 아니라 끝나기 전에 거둬진 것이다.
   * `status`가 없으면 **끝났다는 사실만** 아는 것이다 — 알아보지 못한 결말에 성공을 적는 것이
   * 이 원장이 고치려는 바로 그 거짓말이므로, 모르면 비워 둔다.
   */
  | {
      readonly kind: "job-end";
      readonly id: string;
      readonly status?: AgentChatJobStatus;
      readonly summary?: string;
      readonly tokens?: number;
      readonly tools?: number;
      readonly durationMs?: number;
    }
  /**
   * 지금 살아 있는 잡의 전량. REPLACE 시맨틱이다 — 세는 것이 아니라 통째로 갈아 끼운다.
   * 워크플로 1건은 spawn 1회에 stop N회를 내므로 가감산 카운터는 반드시 어긋난다.
   */
  | { readonly kind: "jobs"; readonly ids: readonly string[] }
  /**
   * 아직 시작하지 않은 예약 지시의 전량. `jobs`와 같은 REPLACE 시맨틱이며, 라이브 전용이다 —
   * 큐는 지나간 사실이 아니라 지금의 사정이라 저널에 쌓을 것이 없고, 재접속은 구독 시점의
   * 스냅숏 하나로 자리를 되찾는다.
   *
   * 서버가 권위인 이유는 취소 때문이다. 화면이 자기 카운터를 들고 있으면 취소가 무엇을 지웠는지
   * 서버와 화면이 각자 말하게 되고, 그 둘이 어긋나는 순간 사용자는 취소되지 않은 지시를 취소된
   * 것으로 읽는다.
   */
  | { readonly kind: "queue"; readonly entries: readonly AgentChatQueueEntry[] }
  | { readonly kind: "error"; readonly code: string };

/** 예약된 지시 하나 — 좌표와 사용자가 쓴 문면. 취소는 이 좌표로만 닿는다. */
export interface AgentChatQueueEntry {
  readonly id: string;
  readonly text: string;
}

/** 저널에 실리는 형태 — seq는 재접속 클라이언트가 중복 반영을 걸러내는 단조 축이다. */
export interface AgentChatJournalEvent {
  readonly seq: number;
  readonly event: AgentChatStreamEvent;
}

const MAX_TOOL_DETAIL_CHARS = 160;
const MAX_TOOL_RESULT_CHARS = 120;
const MAX_TEXT_CHARS = 60_000;
/** 질문 본문의 상한. 모델이 쓴 문장이라 실어도 되지만, 카드가 패널을 삼키지 않을 만큼만 싣는다. */
const MAX_QUESTION_CHARS = 400;
/** header 전용 상한. 옵션 라벨은 자르지 않는다 — 아래 주석 참조. */
const MAX_HEADER_CHARS = 120;
const MAX_OPTION_DESC_CHARS = 400;
/** 계획 본문 상한 — 텍스트 이벤트와 같다. 넘으면 잘린 사실을 이벤트가 함께 말한다. */
const MAX_PLAN_CHARS = 60_000;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

/**
 * 답을 기다리며 멈추는 두 도구. 통로는 `canUseTool` 하나이고, 이 집합 밖의 도구는 그 콜백을
 * 그냥 통과한다 — 채팅 세션은 권한 게이트를 새로 세우지 않는다(모드는 그대로 bypass다).
 */
export const AGENT_CHAT_ASK_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** 쓰기 계열 — 이 도구들만 변경 장부에 오른다. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * 성공했을 때의 결과가 곧 내용인 도구들. 이쪽 결과의 첫 줄은 파일 본문·검색 히트·가져온
 * 페이지의 첫 줄이라, 요약으로 실으면 스텝 칩이 내용 유출 경로가 된다. 쓰기 계열도 같은
 * 이유로 비운다 — 그쪽은 변경 줄 수가 이미 결말을 말한다. 실패는 예외다: 무엇이 잘못됐는지는
 * 내용이 아니라 판단에 필요한 사실이므로 첫 줄을 그대로 싣는다.
 */
const CONTENT_RESULT_TOOLS = new Set([
  "Read", "NotebookRead", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent",
]);

/**
 * 좌표가 파일을 가리키는 입력 필드. NotebookEdit만 `notebook_path`를 쓰므로 이 목록에서 빠지면
 * 노트북 편집은 대상도 변경 장부도 Theater 밖 표식도 없이 지나간다.
 */
const PATH_KEYS = ["file_path", "path", "notebook_path"];

interface TranscriptContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
}

interface TranscriptLine {
  readonly type?: unknown;
  readonly isMeta?: unknown;
  readonly isSidechain?: unknown;
  readonly isCompactSummary?: unknown;
  readonly timestamp?: unknown;
  /**
   * 이 줄을 누가 만들었는가. CLI가 출처를 아는 줄에만 실린다 — 관측된 값은 `human`(사람 입력),
   * `task-notification`(백그라운드 작업 결말), `peer`(다른 세션)다. 사람 발화에 `human` 아닌
   * kind가 붙을 이유가 없으므로, **필드가 있는데 human이 아니면** 주입으로 읽는다.
   *
   * 반대로 **부재는 아무것도 뜻하지 않는다.** 이 필드가 없는 사람 발화가 실제로 있다(구버전 CLI가
   * 남긴 줄, Quick Launch가 보낸 `promptSource:"sdk"` 줄). 부재를 "사람 아님"으로 읽으면 지시가
   * 조용히 사라진다.
   */
  readonly origin?: { readonly kind?: unknown };
  readonly message?: {
    readonly role?: unknown;
    readonly content?: unknown;
  };
}

/** 경로 표시를 cwd 기준으로 상대화하기 위한 매퍼 옵션. */
export interface ChatEventMapOptions {
  readonly cwd?: string;
  /**
   * tool_use id → 도구 이름. 결과 블록은 자기가 어떤 도구의 결말인지 모르므로, 무엇을 요약해도
   * 되는지 판단하려면 이 축이 필요하다. 세션이 소유하고 매퍼는 읽기만 한다.
   */
  readonly toolNames?: ReadonlyMap<string, string>;
  /**
   * tool_use id → 그 도구 입력이 실어 온 `description` 원문. 세션이 소유하고 매퍼는 읽기만 한다.
   *
   * 잡 제목에는 같은 문장의 사본이 둘 있고, 권위는 이쪽이다. 알림이 싣는 값은 자식이 자기
   * 태스크 레코드에서 다시 꺼낸 사본이고 그 레코드는 디스크를 왕복하는데, Windows 한국어
   * 환경에서 그 사본만 ANSI 코드페이지(CP949)를 지나 CJK가 깨진 채 도착하는 것이 보고됐다
   * (2026-08-27). 모델이 실제로 쓴 그 문장은 같은 스트림의 tool_use 입력으로 이미 한 번
   * 흘렀으므로, 사본을 받아 적는 대신 원본을 되찾는다.
   */
  readonly toolTitles?: ReadonlyMap<string, string>;
}

/**
 * 트랜스크립트 한 줄을 이벤트 목록으로 옮긴다. 대화가 아닌 줄(mode/snapshot/attachment 등),
 * meta 줄, sidechain(서브에이전트) 줄은 빈 목록이다.
 */
export function chatEventsFromTranscriptLine(raw: string, options: ChatEventMapOptions = {}): readonly AgentChatStreamEvent[] {
  return chatReplayFromTranscriptLine(raw, options).events;
}

/**
 * 재생이 쓰는 형태 — 이벤트와 함께 그 줄의 시각을 돌려준다. 재생 턴에는 turn-end가 없어
 * 소요 시간을 말할 수 없는데, 트랜스크립트가 이미 그 값을 들고 있다: 디스패치 줄의 시각과
 * 그 턴 마지막 줄의 시각 차이다. 한 번의 파싱으로 둘 다 얻으려고 매핑과 같은 문을 쓴다.
 */
export function chatReplayFromTranscriptLine(
  raw: string,
  options: ChatEventMapOptions = {},
): { readonly at?: number; readonly events: readonly AgentChatStreamEvent[] } {
  let line: TranscriptLine;
  try {
    line = JSON.parse(raw) as TranscriptLine;
  } catch {
    return { events: [] };
  }
  const parsedAt = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  const events = eventsFromTranscriptLine(line, options);
  return Number.isFinite(parsedAt) ? { at: parsedAt, events } : { events };
}

function eventsFromTranscriptLine(line: TranscriptLine, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  // auto-compact가 남긴 이어짐 요약은 런타임 메타다 — 사람이 친 지시처럼 재생하면
  // "전환이 세션을 summarize했다"로 읽힌다. isMeta가 없는 별도 플래그라 따로 거른다.
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true) return [];
  const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  const atField = Number.isFinite(at) ? { at } : {};
  if (line.type === "user") {
    // 도구 응답을 실은 user 줄은 사람이 친 지시가 아니다 — 재생에서도 스텝의 결말로 옮긴다.
    const results = toolResultsFrom(line.message?.content, options);
    if (results.length > 0) return results;
    const text = readUserText(line.message?.content);
    if (text === null) return [];
    // 사람이 친 것이 아닌 운반체는 지휘 로그에 사용자 발화로 서지 않는다. 다만 본문만 걷고 턴
    // 경계까지 지우면 뒤따르는 응답이 앞 턴에 얹혀 앞 턴의 Answer를 갈아치우므로, 말풍선 없는
    // 여는 이벤트만 남긴다. 그 이벤트가 실제로 턴이 될지는 재생 루프가 정한다(지연 발행).
    if (isInjectedCarrier(line, text)) return [{ kind: "turn-start", ...atField }];
    return [{ kind: "dispatch", text, ...atField }];
  }
  if (line.type === "assistant") {
    return eventsFromAssistantContent(line.message?.content, options);
  }
  return [];
}

/**
 * SDK가 흘려보내는 메시지 하나를 이벤트 목록으로 옮긴다. 사용자 프롬프트는 send 시점에
 * 이미 dispatch로 저널에 올랐으므로 여기서는 assistant·user(도구 응답)·result만 본다.
 */
export function chatEventsFromSdkMessage(message: {
  readonly type: string;
  readonly [key: string]: unknown;
}, options: ChatEventMapOptions = {}): readonly AgentChatStreamEvent[] {
  // 중첩 서브에이전트 프레임. SDK는 기본값에서도 서브에이전트의 tool_use/tool_result를
  // parent_tool_use_id와 함께 부모 스트림에 흘린다(forwardSubagentText는 텍스트·thinking까지
  // 연다). 재생 경로가 isSidechain을 버리듯이, 라이브도 그 프레임을 메인 원장에 세우지 않는다 —
  // 세우면 서브에이전트가 읽은 파일·쓴 글이 호스트 Answer·원장에 한 번 더 선다. 잡 원장
  // (task_started 등)은 system 축이라 이 문에 닿지 않는다.
  if (typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0) {
    return [];
  }
  if (message.type === "stream_event") {
    // 모양은 fleet-analyst가 실측으로 고정한 것과 동일하다. text_delta와 tool_use 블록의
    // 시작만 취한다 — thinking_delta는 공개 출력 금지 불변식에 따라 버리고, input_json_delta는
    // 부분 인자라 좌표로 쓸 수 없다(완성 tool 이벤트가 그 자리를 채운다).
    const inner = (message as { readonly event?: unknown }).event;
    if (!inner || typeof inner !== "object") return [];
    const innerType = (inner as { readonly type?: unknown }).type;
    if (innerType === "content_block_start") {
      const block = (inner as { readonly content_block?: unknown }).content_block;
      if (!block || typeof block !== "object") return [];
      const start = block as { readonly type?: unknown; readonly id?: unknown; readonly name?: unknown };
      if (start.type !== "tool_use") return [];
      if (typeof start.id !== "string" || start.id.length === 0) return [];
      if (typeof start.name !== "string" || start.name.length === 0) return [];
      return [{ kind: "tool-start", id: start.id, name: start.name }];
    }
    if (innerType !== "content_block_delta") return [];
    const delta = (inner as { readonly delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") return [];
    const text = (delta as { readonly type?: unknown; readonly text?: unknown });
    if (text.type === "text_delta" && typeof text.text === "string" && text.text.length > 0) {
      return [{ kind: "text-delta", text: capText(text.text) }];
    }
    return [];
  }
  // 백그라운드 작업 축. 이 다섯 subtype은 오늘도 도착하고 있었고(2026-08-16 실측), 여기서
  // 집어내지 않으면 아래 `return []`로 조용히 사라진다 — 턴 시계가 유일한 시계가 되는 지점이다.
  if (message.type === "system") {
    switch (message.subtype) {
      case "task_started":
        return jobStartedEvent(message, options);
      case "task_progress":
        return jobProgressEvent(message, options);
      case "task_updated":
        return jobUpdatedEvent(message);
      case "task_notification":
        return jobEndEvent(message, options);
      case "background_tasks_changed":
        return jobsChangedEvent(message);
      default:
        return [];
    }
  }
  if (message.type === "assistant") {
    const body = (message as { readonly message?: { readonly content?: unknown } }).message;
    return eventsFromAssistantContent(body?.content, options);
  }
  if (message.type === "user") {
    const body = (message as { readonly message?: { readonly content?: unknown } }).message;
    return toolResultsFrom(body?.content, options);
  }
  if (message.type === "result") {
    const durationMs = (message as { readonly duration_ms?: unknown }).duration_ms;
    const ok = (message as { readonly is_error?: unknown }).is_error !== true;
    const result = (message as { readonly result?: unknown }).result;
    return [{
      kind: "turn-end",
      ok,
      ...(typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs } : {}),
      ...(ok && typeof result === "string" && result.trim().length > 0 ? { answer: capText(result) } : {}),
    }];
  }
  return [];
}

// ── 백그라운드 잡 매핑 ────────────────────────────────────────────────────────

const MAX_JOB_TITLE_CHARS = 120;
/**
 * 서브에이전트의 보고는 칩이 아니라 본문이다 — 마크다운 구조를 지닌 채 상세 화면에 펼쳐지므로
 * 한 줄짜리 상한으로는 문단이 잘린다. 저널 한 항목이 지는 무게로는 넉넉하되 무한하지는 않게 둔다.
 */
const MAX_JOB_SUMMARY_CHARS = 8_000;
const MAX_JOB_AGENT_LABEL_CHARS = 80;
const MAX_JOB_STAGES = 24;
const MAX_JOB_AGENTS_PER_STAGE = 64;
/** 발자국은 "일했는가"에 답하는 목록이지 읽을거리가 아니다 — 넘치면 앞을 잘라 최근을 남긴다. */
const MAX_JOB_TRAIL_STEPS = 200;
/** 셸 출력은 실측 438KB까지 자란다. 꼬리만 싣고, 전체가 필요하면 터미널이 제 집이다. */
const MAX_JOB_TAIL_LINES = 200;
const MAX_JOB_TAIL_CHARS = 24_000;

/** 잡 하나의 스텝 한 줄. 원장의 스텝과 같은 어휘를 쓴다 — 같은 것을 두 번 발명하지 않는다. */
export interface AgentChatJobStep {
  readonly name: string;
  readonly detail?: string;
  readonly failed?: boolean;
  readonly outcome?: string;
}

/**
 * 잡을 열었을 때 한 번 읽어 오는 상세.
 *
 * 저널에 싣지 않는 이유는 크기다. 전사록과 명령 출력은 잡 하나당 수백 KB까지 자라고, 저널에
 * 들어가면 재접속마다 전량이 다시 흐른다. 사용자가 그 잡을 연 그때만 잘라서 읽는다.
 */
export type AgentChatJobDetail =
  | { readonly kind: "agent"; readonly steps: readonly AgentChatJobStep[]; readonly truncated: boolean }
  | { readonly kind: "shell"; readonly tail: string; readonly truncated: boolean };

/**
 * 서브에이전트 전사록에서 도구 발자국을 뽑는다.
 *
 * 전문이 아니라 발자국인 이유는, 사용자가 카드 앞에서 묻는 것이 "무엇을 읽었나"가 아니라
 * **"정말 일했나"**이기 때문이다. 도구 이름과 좌표 한 줄이면 3초 안에 답이 나오고, 원문이
 * 브라우저로 흐르지 않으니 정화기가 지켜야 할 문도 좁다.
 *
 * 재생 경로(`chatReplayFromTranscriptLine`)를 그대로 쓸 수 없다: 그쪽은 `isSidechain`을 버리는데
 * 서브에이전트 전사록은 **전부** 사이드체인이다. 그것이 이 함수가 따로 있는 유일한 이유다.
 */
export function chatSubagentTrailFromTranscript(
  raw: string,
  options: ChatEventMapOptions = {},
): { readonly steps: readonly AgentChatJobStep[]; readonly truncated: boolean } {
  const toolNames = new Map<string, string>();
  const steps: AgentChatJobStep[] = [];
  const indexById = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.type === "assistant") {
      for (const event of eventsFromAssistantContent(parsed.message?.content, { ...options, toolNames })) {
        if (event.kind !== "tool") continue;
        if (event.id !== undefined) {
          toolNames.set(event.id, event.name);
          indexById.set(event.id, steps.length);
        }
        steps.push({
          name: event.name,
          ...(event.detail !== undefined && event.detail.length > 0 ? { detail: event.detail } : {}),
        });
      }
      continue;
    }
    if (parsed.type !== "user") continue;
    for (const event of toolResultsFrom(parsed.message?.content, { ...options, toolNames })) {
      if (event.kind !== "tool-result" || event.id === undefined) continue;
      const at = indexById.get(event.id);
      // 짝 없는 결말은 버린다 — 좌표 없는 결말은 어느 줄의 결말인지 말할 수 없다.
      if (at === undefined) continue;
      const step = steps[at];
      if (step === undefined) continue;
      steps[at] = {
        ...step,
        ...(event.ok ? {} : { failed: true }),
        ...(event.summary.length > 0 ? { outcome: event.summary } : {}),
      };
    }
  }
  // 넘치면 **앞을** 자른다. 뒤를 자르면 그 에이전트가 마지막에 무엇을 했는지가 사라지는데,
  // 발자국을 여는 사람이 보려는 것은 대개 결말 쪽이다.
  const truncated = steps.length > MAX_JOB_TRAIL_STEPS;
  return { steps: truncated ? steps.slice(-MAX_JOB_TRAIL_STEPS) : steps, truncated };
}

/**
 * 셸이 남긴 출력의 꼬리.
 *
 * 원시 명령 출력이므로 잡 본문과 같은 문(경로 정규화·축약·자격증명 마스킹)을 지나되, 줄 구조는
 * 지킨다 — 로그는 줄이 곧 의미라 여기서 접으면 읽을 수 없는 한 문단이 된다.
 *
 * 글자 상한도 **끝에서** 자른다. 앞에서 자르면 마지막 200줄 중 가장 오래된 부분만 남는데,
 * 그것은 꼬리가 아니라 머리다 — 화면이 "마지막 부분만 표시합니다"라고 말하는 동안 정반대를
 * 보이게 된다(긴 JSON 한 줄을 찍는 명령에서 바로 걸린다).
 */
export function chatShellTailFromOutput(raw: string, options: ChatEventMapOptions = {}): { readonly tail: string; readonly truncated: boolean } {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  // 파일 끝의 개행 하나가 만든 빈 줄은 출력이 아니다.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const cutLines = lines.length > MAX_JOB_TAIL_LINES;
  const joined = (cutLines ? lines.slice(-MAX_JOB_TAIL_LINES) : lines).join("\n");
  const cutChars = joined.length > MAX_JOB_TAIL_CHARS;
  // 정화는 길이를 늘리지 않는다(경로 축약·마스킹 모두 줄인다) — 그래서 먼저 끝에서 자르면
  // safeJobBody의 앞자르기 상한에 다시 걸리지 않는다.
  const text = safeJobBody(cutChars ? joined.slice(-MAX_JOB_TAIL_CHARS) : joined, options, MAX_JOB_TAIL_CHARS);
  return { tail: text, truncated: cutLines || cutChars };
}

/**
 * SDK `task_type`을 제품 어휘로 접는다. 모르는 값은 `other`로 남긴다 — 새 종류가 생겼을 때
 * 목록에서 조용히 빠지는 것보다, 이름 없는 잡으로 서서 눈에 띄는 쪽이 낫다.
 *
 * 세션이 REPLACE 목록에서 직접 종류를 읽을 때도 같은 표를 쓴다 — 스트림 이벤트와 활동축이
 * 서로 다른 어휘로 셸을 가르면, 화면에 셸로 선 잡이 축에서는 에이전트 작업으로 세어진다.
 */
export function readJobKind(value: unknown): AgentChatJobKind {
  if (value === "local_agent") return "agent";
  if (value === "local_bash") return "shell";
  if (value === "local_workflow") return "workflow";
  return "other";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function capTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 잡 표면의 한 줄 텍스트는 도구 결과와 같은 문을 지난다 — 경로 정규화·축약·자격증명 마스킹. */
function safeJobText(raw: string, options: ChatEventMapOptions, max: number): string {
  const flat = normalizePathTokens(raw.replace(/\s+/g, " ").trim(), options.cwd);
  return capTo(maskSecrets(abbreviateAbsolutePaths(flat)), max);
}

/**
 * 본문으로 펼쳐지는 잡 텍스트. 같은 문을 지나되 줄 구조는 지킨다 — 여기서 공백을 한 칸으로
 * 접으면 마크다운 보고가 통째로 한 문단이 되어, 제목·목록·코드 블록이 전부 원문 기호로 남는다.
 */
function safeJobBody(raw: string, options: ChatEventMapOptions, max: number): string {
  // 줄 끝 공백과 줄바꿈 표기만 고른다. 줄 안의 공백은 건드리지 않는다 — 여기서 접으면 중첩
  // 목록의 들여쓰기, 들여쓴 코드 블록, 펜스 안의 Python·YAML이 전부 무너진 채 렌더러에 닿는다.
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  const normalized = normalizePathTokens(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), options.cwd);
  return capTo(maskSecrets(abbreviateAbsolutePaths(normalized)), max);
}

function jobStartedEvent(message: Readonly<Record<string, unknown>>, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  const id = readString(message.task_id);
  if (id === undefined) return [];
  // 서브에이전트는 유형이, 워크플로는 이름이 "누구의 작업인가"를 말한다. 셸에는 둘 다 없다.
  // 워크플로 이름은 모델이 쓴 스크립트의 meta.name이므로 자유 텍스트와 같은 문을 지나야 한다.
  const who = readString(message.subagent_type) ?? readString(message.workflow_name);
  // 제목은 도구 입력의 description — 모델이 쓴 자유 텍스트다. 절대 경로나 자격증명 모양이
  // 들어올 수 있고, 이 값은 저널에 실려 스트립·카드·상세 세 곳에 그대로 그려진다. 다른 잡
  // 텍스트와 같은 문(경로 정규화·축약·마스킹)을 지나지 않으면 이 표면이 유출 경로가 된다.
  //
  // 원본을 먼저 보는 이유는 사본만 깨져 도착하는 경로가 있기 때문이다(`toolTitles`). 원본이
  // 없으면 — 도구 호출 없이 선 잡이거나 원장 상한이 그 호출을 이미 밀어냈으면 — 알림이 아는
  // 유일한 값으로 되돌아간다. 아는 것이 사본뿐일 때 제목을 비우는 쪽이 더 나쁘다.
  const toolUseId = readString(message.tool_use_id);
  const description = (toolUseId === undefined ? undefined : options.toolTitles?.get(toolUseId))
    ?? readString(message.description);
  return [{
    kind: "job",
    id,
    jobKind: readJobKind(message.task_type),
    title: description === undefined ? id : safeJobText(description, options, MAX_JOB_TITLE_CHARS),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(who !== undefined ? { who: safeJobText(who, options, MAX_JOB_TITLE_CHARS) } : {}),
    at: Date.now(),
  }];
}

function jobProgressEvent(message: Readonly<Record<string, unknown>>, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  const id = readString(message.task_id);
  if (id === undefined) return [];
  const usage = message.usage as { readonly total_tokens?: unknown; readonly tool_uses?: unknown; readonly duration_ms?: unknown } | undefined;
  const stages = readWorkflowStages(message.workflow_progress, options);
  const note = readString(message.description);
  const lastTool = readString(message.last_tool_name);
  return [{
    kind: "job-progress",
    id,
    ...(note !== undefined ? { note: safeJobText(note, options, MAX_JOB_TITLE_CHARS) } : {}),
    ...(readCount(usage?.total_tokens) !== undefined ? { tokens: readCount(usage?.total_tokens) as number } : {}),
    ...(readCount(usage?.tool_uses) !== undefined ? { tools: readCount(usage?.tool_uses) as number } : {}),
    ...(readCount(usage?.duration_ms) !== undefined ? { durationMs: readCount(usage?.duration_ms) as number } : {}),
    ...(lastTool !== undefined ? { lastTool: safeJobText(lastTool, options, MAX_JOB_AGENT_LABEL_CHARS) } : {}),
    ...(stages.length > 0 ? { stages } : {}),
  }];
}

/**
 * 상태 패치. 결말의 권위는 `task_notification`이지만, 그것이 오기 전에 `killed`가 먼저 도착하는
 * 경우가 있다(실측: 셸 백그라운드는 턴 종료 직후 killed → stopped 순서). 여기서는 종결 상태만
 * 옮기고, 진행 중 상태 변화는 맥박이 이미 말하므로 싣지 않는다.
 */
function jobUpdatedEvent(message: Readonly<Record<string, unknown>>): readonly AgentChatStreamEvent[] {
  const id = readString(message.task_id);
  if (id === undefined) return [];
  const patch = message.patch as { readonly status?: unknown } | undefined;
  const status = patch?.status;
  if (status === "completed") return [{ kind: "job-end", id, status: "completed" }];
  if (status === "failed") return [{ kind: "job-end", id, status: "failed" }];
  if (status === "killed") return [{ kind: "job-end", id, status: "stopped" }];
  return [];
}

function jobEndEvent(message: Readonly<Record<string, unknown>>, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  const id = readString(message.task_id);
  if (id === undefined) return [];
  // 아는 세 값만 결말로 옮긴다. 값이 없거나 처음 보는 값이면 결말을 주장하지 않는다 —
  // 기본값을 completed로 두면 SDK가 새 상태를 하나 추가하는 날 원장이 조용히 거짓 완료를 그린다.
  const raw = message.status;
  const status: AgentChatJobStatus | undefined =
    raw === "completed" ? "completed" : raw === "failed" ? "failed" : raw === "stopped" ? "stopped" : undefined;
  const usage = message.usage as { readonly total_tokens?: unknown; readonly tool_uses?: unknown; readonly duration_ms?: unknown } | undefined;
  // 서브에이전트의 summary는 그 에이전트가 돌려준 보고 그 자체다 — 실행 출력이 그대로 흐르는
  // 경로이므로 도구 결과와 같은 문을 지난다.
  const summary = readString(message.summary);
  return [{
    kind: "job-end",
    id,
    ...(status !== undefined ? { status } : {}),
    ...(summary !== undefined ? { summary: safeJobBody(summary, options, MAX_JOB_SUMMARY_CHARS) } : {}),
    ...(readCount(usage?.total_tokens) !== undefined ? { tokens: readCount(usage?.total_tokens) as number } : {}),
    ...(readCount(usage?.tool_uses) !== undefined ? { tools: readCount(usage?.tool_uses) as number } : {}),
    ...(readCount(usage?.duration_ms) !== undefined ? { durationMs: readCount(usage?.duration_ms) as number } : {}),
  }];
}

function jobsChangedEvent(message: Readonly<Record<string, unknown>>): readonly AgentChatStreamEvent[] {
  const tasks = message.tasks;
  if (!Array.isArray(tasks)) return [];
  const ids: string[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const id = readString((task as { readonly task_id?: unknown }).task_id);
    if (id !== undefined) ids.push(id);
  }
  return [{ kind: "jobs", ids }];
}

/**
 * `task_progress.workflow_progress`를 단계 트리로 접는다. 이 배열은 SDK 타입 선언에는 없고
 * 전선에서만 관측된다(2026-08-16 실측) — 그래서 읽어낸 만큼만 쓰고, 못 읽으면 빈 배열을 돌려
 * 워크플로 카드가 단계 없이도 완결되게 둔다. 여기서 던지면 맥박 하나가 통째로 사라진다.
 */
function readWorkflowStages(value: unknown, options: ChatEventMapOptions): readonly AgentChatJobStage[] {
  if (!Array.isArray(value)) return [];
  const order: string[] = [];
  const byTitle = new Map<string, AgentChatJobAgent[]>();
  const ensure = (title: string): AgentChatJobAgent[] => {
    let bucket = byTitle.get(title);
    if (!bucket) {
      bucket = [];
      byTitle.set(title, bucket);
      order.push(title);
    }
    return bucket;
  };
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.type === "workflow_phase") {
      const title = readString(row.title);
      // 단계 제목도 모델이 쓴 스크립트의 meta.phases[].title이다 — 제목과 같은 문을 지난다.
      if (title !== undefined) ensure(safeJobText(title, options, MAX_JOB_AGENT_LABEL_CHARS));
      continue;
    }
    if (row.type !== "workflow_agent") continue;
    const phaseTitle = readString(row.phaseTitle);
    const title = phaseTitle === undefined ? "" : safeJobText(phaseTitle, options, MAX_JOB_AGENT_LABEL_CHARS);
    const bucket = ensure(title);
    if (bucket.length >= MAX_JOB_AGENTS_PER_STAGE) continue;
    const label = readString(row.label);
    const result = readString(row.resultPreview);
    bucket.push({
      label: label === undefined ? "" : safeJobText(label, options, MAX_JOB_AGENT_LABEL_CHARS),
      ...(readString(row.model) !== undefined ? { model: capTo(readString(row.model) as string, MAX_JOB_AGENT_LABEL_CHARS) } : {}),
      state: readString(row.state) ?? "unknown",
      ...(readCount(row.tokens) !== undefined ? { tokens: readCount(row.tokens) as number } : {}),
      ...(readCount(row.toolCalls) !== undefined ? { tools: readCount(row.toolCalls) as number } : {}),
      ...(readCount(row.durationMs) !== undefined ? { durationMs: readCount(row.durationMs) as number } : {}),
      ...(result !== undefined ? { result: safeJobText(result, options, MAX_TOOL_RESULT_CHARS) } : {}),
    });
  }
  return order.slice(0, MAX_JOB_STAGES).map((title) => ({ title, agents: byTitle.get(title) ?? [] }));
}

function eventsFromAssistantContent(content: unknown, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  if (!Array.isArray(content)) return [];
  const events: AgentChatStreamEvent[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      events.push({ kind: "text", text: capText(block.text) });
      continue;
    }
    if (block.type === "tool_use" && typeof block.name === "string" && block.name.length > 0) {
      const change = changeFromToolInput(block.name, block.input, options);
      events.push({
        kind: "tool",
        name: block.name,
        detail: summarizeToolInput(block.input, options),
        ...(typeof block.id === "string" && block.id.length > 0 ? { id: block.id } : {}),
        ...(pathIsOutsideCwd(block.input, options.cwd) ? { outside: true } : {}),
        ...(change ? { change } : {}),
      });
    }
    // thinking·redacted_thinking은 의도적으로 버린다.
  }
  return events;
}

/** user 줄에 실린 tool_result 블록들을 스텝의 결말로 옮긴다. */
function toolResultsFrom(content: unknown, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  if (!Array.isArray(content)) return [];
  const events: AgentChatStreamEvent[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
    if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) continue;
    const ok = block.is_error !== true;
    const tool = options.toolNames?.get(block.tool_use_id);
    const quiet = ok && tool !== undefined && (CONTENT_RESULT_TOOLS.has(tool) || WRITE_TOOLS.has(tool));
    events.push({
      kind: "tool-result",
      id: block.tool_use_id,
      ok,
      summary: quiet ? "" : summarizeToolResult(block.content, options),
    });
  }
  return events;
}

function readUserText(content: unknown): string | null {
  if (typeof content === "string") return normalizeDispatchText(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    // tool_result가 섞인 user 줄은 도구 응답 운반체다 — 사람이 친 지시가 아니다.
    if (block?.type === "tool_result") return null;
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return normalizeDispatchText(parts.join("\n"));
}

/**
 * CLI가 user 줄로 남기지만 사람이 친 것이 아닌 운반체들. 이 목록은 **지목형**이다 — 아는 것만
 * 버리고 모르는 것은 통과시킨다. 반대로 하면(모르는 것을 버리면) 새 형태의 사람 발화가 조용히
 * 사라지는데, 노이즈 한 줄보다 지시 한 줄을 잃는 쪽이 훨씬 비싸다.
 *
 * `local-command-caveat`·`system-reminder`는 대개 `isMeta`로도 걸리지만, 그 플래그를 달지 않는
 * 판본이 있어 여기서도 지목한다.
 *
 * 목록은 **종류를 더 가르지 않는다.** 어느 운반체가 모델을 깨우는지를 여기서 미리 나누려던 판본이
 * 있었으나 그 분류는 실물에서 틀렸다 — `/clean-code` 같은 슬래시 명령은 `<command-message>` 줄로
 * 시작해 뒤에 응답을 달고 온다(실측 14건). 부산물로 분류해 침묵시키면 그 응답이 앞 턴에 얹혀
 * 앞 턴의 Answer를 갈아치운다. "내용 없는 턴은 열지 않는다"는 판정은 재생 루프가 진다: 여는
 * 이벤트는 실제 내용이 뒤따를 때 비로소 발행되고 연속된 운반체는 턴 하나로 접힌다
 * (`chat-session.ts`의 지연 발행). 그래서 이 목록은 종류를 몰라도 되고, 새 운반체가 생겨도
 * 같은 규칙으로 옳게 동작한다.
 */
const INJECTED_TRANSCRIPT_TAGS: ReadonlySet<string> = new Set([
  "task-notification",
  "local-command-stdout",
  "local-command-caveat",
  "command-name",
  "command-message",
  "system-reminder",
  "bash-input",
  "bash-stdout",
]);

/**
 * 선두 태그의 **이름만** 뽑는다. 접두 문자열 비교로는 속성 있는 태그를 놓친다 —
 * `"<system-reminder source=\"carrier-completion\">".startsWith("<system-reminder>")`는 false이고,
 * Fleet 자신이 CLI에 붙여넣는 캐리어 완료 신호가 정확히 그 형태다.
 */
const LEADING_TAG_NAME = /^<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>])/;

/**
 * `origin.kind`가 실렸는데 사람이 아니라고 말하는가. 부재는 판정하지 않는다 —
 * 그 이유는 `TranscriptLine.origin` 주석에 있다.
 */
function isInjectedOrigin(origin: TranscriptLine["origin"]): boolean {
  const kind = origin?.kind;
  return typeof kind === "string" && kind.length > 0 && kind !== "human";
}

/**
 * 이 user 줄이 사람이 친 지시가 아니라 주입 운반체인가.
 *
 * 두 축을 함께 본다. `origin.kind`는 CLI가 출처를 아는 줄에만 실리므로 있으면 권위이고, 그 필드가
 * 없는 판본과 `origin.kind==="human"`으로 오는 붙여넣기(Fleet의 캐리어 완료 신호)는 본문 태그로만
 * 갈린다. 어느 축도 화이트리스트가 아니다 — **아는 것만 지목**하고 모르는 것은 통과시킨다.
 */
function isInjectedCarrier(line: TranscriptLine, text: string): boolean {
  if (isInjectedOrigin(line.origin)) return true;
  const tag = LEADING_TAG_NAME.exec(text.trimStart())?.[1];
  return tag !== undefined && INJECTED_TRANSCRIPT_TAGS.has(tag);
}

function normalizeDispatchText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : capText(trimmed);
}

/**
 * 파서의 결과. 이벤트와 답변 키가 갈라져 있는 이유는 둘의 수신자가 다르기 때문이다 —
 * 이벤트는 브라우저가 그릴 것이라 상한과 trim을 지나지만, 답변 키는 도구가 답을 맞춰 볼
 * 좌표라 **원문 그대로**여야 한다. 표시용으로 가공한 문자열을 키로 쓰면 400자를 넘거나
 * 앞뒤 공백이 있는 질문에서 키가 어긋나, 라우트는 200을 돌려주는데 모델은 답을 받지 못한다.
 */
export interface AgentChatAskParse {
  readonly event: Extract<AgentChatStreamEvent, { kind: "ask" }>;
  /** 질문 순서대로의 원본 질문 텍스트. 이벤트의 questions와 길이·순서가 같다. */
  readonly answerKeys: readonly string[];
}

/**
 * 대화형 도구의 입력을 카드가 읽을 이벤트로 옮긴다. 모양이 계약과 다르면 null을 돌려준다 —
 * 그때 세션은 카드를 세우지 않고 도구를 그냥 통과시킨다. 반쯤 읽은 질문을 세우는 것보다,
 * 모델이 답 없이 계속하는 편이 정직하다.
 */
export function agentChatAskFromToolInput(
  name: string,
  id: string,
  input: unknown,
): AgentChatAskParse | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (name === "ExitPlanMode") {
    const plan = typeof record.plan === "string" ? record.plan.trim() : "";
    if (plan.length === 0) return null;
    // 상한은 텍스트 이벤트와 같은 자리에 둔다 — 계획도 모델이 사람에게 읽히려고 쓴 문서다.
    // 그래도 넘는 계획은 잘리는데, 그때는 승인을 열지 않는다는 사실을 함께 싣는다.
    const truncated = plan.length > MAX_PLAN_CHARS;
    return {
      event: { kind: "ask", id, form: "plan", plan: cap(plan, MAX_PLAN_CHARS), ...(truncated ? { truncated: true } : {}) },
      answerKeys: [],
    };
  }
  if (name !== "AskUserQuestion") return null;
  if (!Array.isArray(record.questions)) return null;
  const questions: AgentChatQuestion[] = [];
  // 건너뛴 질문이 있으면 인덱스가 어긋나므로, 키는 실제로 실린 질문과 같은 걸음으로 쌓는다.
  const answerKeys: string[] = [];
  for (const raw of record.questions.slice(0, MAX_QUESTIONS)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    // 원문은 도구가 답을 맞춰 볼 키다 — trim도 상한도 표시용에만 건다.
    const rawQuestion = typeof entry.question === "string" ? entry.question : "";
    const question = rawQuestion.trim();
    if (question.length === 0) continue;
    const header = typeof entry.header === "string" && entry.header.trim().length > 0
      ? entry.header.trim()
      : question;
    const options: AgentChatQuestionOption[] = [];
    if (Array.isArray(entry.options)) {
      for (const rawOption of entry.options.slice(0, MAX_OPTIONS)) {
        if (!rawOption || typeof rawOption !== "object") continue;
        const option = rawOption as Record<string, unknown>;
        const label = typeof option.label === "string" ? option.label.trim() : "";
        if (label.length === 0) continue;
        options.push({
          // 라벨은 사용자가 고르면 그대로 답이 되어 도구로 돌아간다 — 표시용으로 자르면
          // 보이는 것과 보내는 것이 갈라져, 고른 것과 다른 값이 모델에게 간다. 길이는
          // 카드 CSS가 접는다. description은 답이 되지 않으므로 상한을 그대로 둔다.
          label,
          description: cap(typeof option.description === "string" ? option.description.trim() : "", MAX_OPTION_DESC_CHARS),
        });
      }
    }
    // 선택지가 없는 질문은 자유 입력 하나만 남는데, 그 모양은 도구 계약이 아니다.
    if (options.length === 0) continue;
    questions.push({
      header: cap(header, MAX_HEADER_CHARS),
      question: cap(question, MAX_QUESTION_CHARS),
      multiSelect: entry.multiSelect === true,
      options,
    });
    answerKeys.push(rawQuestion);
  }
  if (questions.length === 0) return null;
  return { event: { kind: "ask", id, form: "question", questions }, answerKeys };
}

function cap(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * 도구 입력에서 한 줄 요약을 뽑는다. 사람이 스캔할 좌표 성격의 필드만 고르고 상한을 둔다 —
 * 전체 입력(파일 본문·프롬프트)은 싣지 않는다. 경로 필드는 브라우저로 나가는 스트림이므로
 * raw 절대 경로 대신 표시형으로 옮긴다(Console 보안 계약).
 */
export function summarizeToolInput(input: unknown, options: ChatEventMapOptions = {}): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS.concat(["command", "pattern", "url", "query", "description", "prompt", "subject"])) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const flat = value.replace(/\s+/g, " ").trim();
      const shown = PATH_KEYS.includes(key)
        ? displayPath(flat, options.cwd)
        : normalizePathTokens(flat, options.cwd);
      return shown.length > MAX_TOOL_DETAIL_CHARS ? `${shown.slice(0, MAX_TOOL_DETAIL_CHARS - 1)}…` : shown;
    }
  }
  return "";
}

/**
 * 도구 결과에서 한 줄 요약을 뽑는다. 도구가 돌려준 본문 전체는 싣지 않는다 — 첫 줄만,
 * 상한 아래로, 경로 정규화와 자격 증명 마스킹을 통과시킨다. 모델이 고른 문장이 아니라
 * 실행 결과가 그대로 흐르는 경로이므로, 도구 입력 요약보다 좁은 문을 지난다.
 */
export function summarizeToolResult(content: unknown, options: ChatEventMapOptions = {}): string {
  const text = readResultText(content);
  if (text === null) return "";
  const first = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return "";
  const flat = normalizePathTokens(first.replace(/\s+/g, " ").trim(), options.cwd);
  const masked = maskSecrets(abbreviateAbsolutePaths(flat));
  return masked.length > MAX_TOOL_RESULT_CHARS ? `${masked.slice(0, MAX_TOOL_RESULT_CHARS - 1)}…` : masked;
}

/**
 * cwd·홈 정규화를 지나고도 남은 절대 경로를 표시형으로 접는다. 도구 결과는 실행 출력이 그대로
 * 흐르는 경로라 우리 두 접두 밖의 절대 경로가 원문으로 나갈 수 있다 — 실측에서 실패한 쓰기의
 * EACCES 메시지가 다른 사용자의 홈 경로를 실어 왔다. 원장의 경로 필드가 이미 쓰는 규칙과 같게
 * 마지막 두 조각만 남긴다.
 *
 * 두 벌로 훑는다. 먼저 따옴표로 감싼 경로를 통째로 — 공백이 든 경로는 실제 오류 메시지에서
 * 거의 언제나 이 모양이라(`can't open file '/a/My Project/x.py'`), 이것이 공백 문제의 현실적인
 * 답이다. 그다음 공백 없는 맨 경로를 POSIX·Windows 드라이브·UNC 세 형태로.
 *
 * 따옴표 없는 공백 경로는 의도적으로 건드리지 않는다: 산문과 경로를 가를 근거가 없어 공백을
 * 욕심내면 문장을 먹는다. 그런 경로도 앞 조각은 이 규칙에 잘려 나가므로 사용자 이름 같은
 * 식별 정보는 남지 않는다. URL(`scheme://…`)과 이미 정규화된 `./`·`~/`, 그리고 이미 접힌
 * `…/`는 어느 벌에서도 다시 잡지 않는다.
 */
/**
 * 맨 경로는 "무엇으로 시작하는가"가 아니라 "어디서 시작하는가"로 잡는다. 조각의 첫 글자를
 * 열거하면 `/équipe/…`나 `/사용자/…` 같은 비ASCII 경로가 통째로 빠져나가고, 문자 클래스를
 * 넓히는 싸움은 끝나지 않는다. 대신 경로는 경계에서만 시작할 수 있게 한다 — 문자열 처음,
 * 공백, 따옴표, 여는 괄호, `=` 뒤. 그러면 URL(`scheme://…`), 이미 접힌 `…/`, 정규화된
 * `./`·`~/`, 그리고 `읽기/쓰기`·`and/or` 같은 산문 속 슬래시는 어느 것도 경계가 아니라
 * 저절로 걸러진다.
 */
const QUOTED_ABSOLUTE_PATH = /(['"`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^'"`\n]*)\1/g;
const BARE_ABSOLUTE_PATH = /(?<![^\s'"`([{=<])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`,;:()[\]<>]+/g;

function abbreviateAbsolutePaths(value: string): string {
  return value
    .replace(QUOTED_ABSOLUTE_PATH, (_match, quote: string, path: string) => `${quote}${foldPath(path)}${quote}`)
    .replace(BARE_ABSOLUTE_PATH, (match) => foldPath(match));
}

function foldPath(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0 && !/^[A-Za-z]:$/.test(segment));
  if (segments.length === 0) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

function readResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * 눈에 띄는 자격 증명 모양을 가린다. 완전한 비밀 탐지가 아니라, 실행 출력이 그대로 흐르는
 * 경로에서 가장 흔한 토큰 모양이 원문으로 남지 않게 하는 최소 방어다.
 */
function maskSecrets(value: string): string {
  return value
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "$1-…")
    .replace(/\b(gh[pousr]|xox[baprs])_[A-Za-z0-9_-]{16,}/g, "$1_…")
    .replace(/\bAKIA[0-9A-Z]{12,}/g, "AKIA…")
    .replace(/\b(?:Bearer|Authorization:)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer …")
    .replace(/\beyJ[A-Za-z0-9._-]{24,}/g, "eyJ…");
}

/**
 * 쓰기 계열 도구의 입력에서 변경 한 건을 접는다. 파일 본문은 싣지 않고 줄 수만 센다 —
 * "무엇이 얼마나 바뀌었는가"는 좌표이지 내용이 아니다.
 */
function changeFromToolInput(name: string, input: unknown, options: ChatEventMapOptions = {}): AgentChatChange | null {
  if (!WRITE_TOOLS.has(name)) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const raw = PATH_KEYS
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
  if (raw === null) return null;
  const file = displayPath(raw.trim(), options.cwd);
  if (name === "Write") {
    return { file, added: lineCount(record.content), removed: 0 };
  }
  if (name === "Edit") {
    return { file, added: lineCount(record.new_string), removed: lineCount(record.old_string) };
  }
  if (name === "MultiEdit") {
    let added = 0;
    let removed = 0;
    const edits = Array.isArray(record.edits) ? record.edits : [];
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const entry = edit as Record<string, unknown>;
      added += lineCount(entry.new_string);
      removed += lineCount(entry.old_string);
    }
    return { file, added, removed };
  }
  // NotebookEdit는 셀 단위라 줄 수를 세지 않는다 — 파일이 바뀌었다는 사실만 장부에 올린다.
  return { file, added: 0, removed: 0 };
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  return value.replace(/\n$/, "").split("\n").length;
}

/** 도구 입력의 경로 좌표가 Operation cwd 밖을 가리키는지. 좌표가 없으면 false다. */
function pathIsOutsideCwd(input: unknown, cwd: string | undefined): boolean {
  if (!cwd || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const normalized = resolveDotSegments(value.trim().replace(/\\/g, "/"));
    if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return false;
    const root = resolveDotSegments(cwd.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (root.length <= 1) return false;
    return normalized !== root && !normalized.startsWith(`${root}/`);
  }
  return false;
}

/**
 * `.`·`..`를 접은 뒤에 경로를 비교한다. 문자열 접두만 보면 `/repo/../etc/passwd`가 `/repo/`로
 * 시작한다는 이유로 Theater 안쪽이 되는데, 도구는 밖에 쓴다 — 경계 표식이 지켜야 할 바로 그
 * 경우에 침묵하게 된다. 표시형(displayPath)과 판정(pathIsOutsideCwd)이 같은 함수를 써야
 * 원장의 경로와 그 표식이 서로 다른 사실을 말하지 않는다.
 */
function resolveDotSegments(path: string): string {
  if (!path.includes("./") && !path.endsWith("/.") && !path.endsWith("/..")) return path;
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      // 루트를 나타내는 선두의 빈 조각은 남긴다 — 그것이 절대 경로라는 사실이다.
      if (out.length > 1 || (out.length === 1 && out[0] !== "")) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return joined.length > 0 ? joined : "/";
}

/**
 * 자유 텍스트 요약(command·prompt 등) 안의 경로 토큰을 표시형으로 정규화한다: Operation cwd
 * 접두는 `.`으로, 홈 디렉터리 접두는 `~`로 바꾼다. 셸 관용 표기라 의미를 해치지 않으면서
 * 작업공간·홈 절대 경로가 브라우저 스트림에 원문으로 실리지 않게 한다.
 */
function normalizePathTokens(value: string, cwd: string | undefined): string {
  let result = value;
  if (cwd) {
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root.length > 1) result = result.split(root).join(".");
  }
  const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
  if (home.length > 1) result = result.split(home).join("~");
  return result;
}

/**
 * 절대 경로를 브라우저 표시형으로 옮긴다: Operation cwd 안이면 상대 경로, 밖이면 마지막 두
 * 조각만 남긴 축약형이다. 상대 경로는 이미 안전하므로 그대로 둔다.
 */
function displayPath(value: string, cwd: string | undefined): string {
  const normalized = resolveDotSegments(value.replace(/\\/g, "/"));
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return value;
  if (cwd) {
    const root = resolveDotSegments(cwd.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (normalized === root) return ".";
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return `…/${segments.slice(-2).join("/")}`;
}

function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}
