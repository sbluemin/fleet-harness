/**
 * 자식 CLI의 **내장 슬래시 명령**이 Console 채팅에서 무엇을 뜻하는지 정하는 표.
 *
 * 왜 목록이 아니라 표인가: `supportedCommands()`는 *자식이 무엇을 받아 주는가*를 정확히 말하지만,
 * 덱이 답해야 하는 질문은 *이 화면에서 그것이 무슨 뜻인가*다. 두 질문의 답이 갈리는 이유는
 * 호스트가 다르기 때문이다 — 터미널 TUI에는 프롬프트 바가 있고 모델 피커가 있고 세션 제목이 곧
 * 대화 제목이지만, Console 채팅에는 그 중 어느 것도 그 자리에 없다. 그래서 판정 축은 하나다:
 * **이 축을 누가 소유하는가.**
 *
 * 스킬과 서브에이전트는 이 표에 오지 않는다. 그쪽은 CLI의 내장 표면이 아니라 사용자·프로젝트가
 * 직접 놓은 것이고, Console이 그 의미를 판단할 근거가 없다.
 *
 * 분류 근거는 2026-08-29 실측이다(격리 SDK 세션, Claude Agent SDK 0.3.212). 각 항목의 주석에
 * 자식이 실제로 뭐라고 답했는지를 남긴다 — 근거 없이 숨긴 항목은 다음 사람이 되살릴 수 없다.
 */

/** 한 내장 명령의 처분. */
export type ChatCommandDisposition =
  /** 덱에 세우지 않는다. 여기서 동작하지 않거나, 동작해도 뜻이 없거나, 사용자 어포던스가 아니다. */
  | "hidden"
  /** 덱에 세우되 자식에게 보내지 않는다 — Console이 자기 컨트롤로 답한다. */
  | "console"
  /** 자식이 정당하게 소유한 기능. 그대로 보낸다. */
  | "passthrough";

/**
 * `console` 처분이 가리키는 Console 쪽 자리. 클라이언트가 이 값으로 행동을 고른다.
 *
 * 서버가 문구가 아니라 좌표를 싣는 이유: 문구는 언어마다 다르고 화면마다 다르지만, "어느 축인가"는
 * 한 가지다. 서버가 문장을 실으면 i18n이 서버로 새고, 화면이 그 문장을 다시 해석해야 한다.
 */
export type ChatCommandConsoleTarget =
  /** 컴포저 바의 문맥 계기. 같은 `getContextUsage()` 값을 이미 그리고 있다. */
  | "context"
  /** 문맥 초기화. 자식과 화면 기록을 **함께** 끊어야 하므로 Console이 중개한다. */
  | "clear";

export interface ChatCommandRule {
  readonly disposition: ChatCommandDisposition;
  /** `disposition === "console"`일 때만 있다. */
  readonly target?: ChatCommandConsoleTarget;
  /**
   * 이 명령은 자식에게 닿고, 그 왕복이 **턴이 아니라 정비 줄**로 그려진다.
   *
   * `disposition`과 직교한다: `/clear`는 Console이 중개하지만(확인·기록 삭제) 문맥을 실제로
   * 비우는 것은 자식뿐이라 여전히 닿고, `/context`는 통과처럼 보여도 자식에게 가지 않는다
   * (같은 수를 Console이 이미 들고 있다). 그래서 "누가 소유하는가"와 "자식에게 가는가"를
   * 한 필드로 합칠 수 없다.
   */
  readonly lane?: true;
}

/**
 * 내장 명령 24개의 처분. 지원하는 것은 넷뿐이다.
 *
 * 지원 목록이 **선별**이므로 표에 없는 이름은 세우지 않는다(`classifyChatCommand`의 기본값이
 * `hidden`이다). 그것이 카탈로그의 fail-open과 모순되지 않는 이유: 카탈로그는 표에 없는 이름을
 * 내장 명령이 아니라 **스킬**로 읽어 그대로 세운다. 즉 사라지는 것은 "우리가 아는 내장 명령 중
 * 고르지 않은 것"뿐이고, 자식이 새로 얻은 것은 스킬 칸에서 살아남는다.
 */
export const CHAT_COMMAND_POLICY: Readonly<Record<string, ChatCommandRule>> = Object.freeze({
  // ── 지원 ──────────────────────────────────────────────────────────────────
  // 이 넷만 Console 채팅의 어휘다. 고른 기준은 "여기서 뜻이 있고, 여기서 끝까지 책임질 수 있는가"다 —
  // 셋은 이 세션의 상태(문맥·기록·능력 목록)를 다루고, 그 상태는 Console도 함께 그리고 있다.
  /** 문맥을 비운다. 자식의 기억과 화면의 기록을 **함께** 끊어야 하므로 Console이 중개한다. */
  clear: { disposition: "console", target: "clear", lane: true },
  /** 대화를 요약해 문맥을 되찾는다. 자식이 수행하고, 그 진행을 Console이 원장에 그린다. */
  compact: { disposition: "passthrough", lane: true },
  /** 문맥 내역. 같은 `getContextUsage()` 값을 컴포저 바의 계기가 이미 그린다. */
  context: { disposition: "console", target: "context" },
  /** 디스크의 스킬을 다시 읽는다. 함께 오는 `commands_changed`가 덱의 카탈로그를 무효화한다. */
  "reload-skills": { disposition: "passthrough", lane: true },

  // ── 그 외 전부 ────────────────────────────────────────────────────────────
  // 나머지는 세우지 않는다. 하나씩 나쁜 이유가 있어서가 아니라, 이 표면이 그것들을 끝까지
  // 책임지지 못하기 때문이다: Console이 겹쳐 쥔 축을 뒤에서 바꾸거나(model·effort), 여기 없는
  // 것을 조작하거나(color·fast), 계정·브라우저로 나가거나(usage-credits·design*), 자식의
  // 진단 도구이거나(heapdump·doctor류), 답하려고만 존재한다(agents·extra-usage).
  // 각 줄의 주석은 2026-08-29 실측에서 자식이 실제로 한 말이다.

  /** 이중 언더스코어 내부 명령 — 세션 환경이 실어 준 워크플로 스크립트를 돌린다. */
  "__remote-workflow": { disposition: "hidden" },
  /** 자식이 직접 거절한다: "Fast mode is not available in the Agent SDK". */
  fast: { disposition: "hidden" },
  /** 자기가 폐기됐다고 답하려고만 존재한다: "The /agents wizard has been removed." */
  agents: { disposition: "hidden" },
  /** 죽은 별칭이고 부작용이 있다 — 실측에서 브라우저 탭을 열었다. */
  "extra-usage": { disposition: "hidden" },
  /** "Session color set to: red" — TUI 프롬프트 바의 색이다. 여기엔 프롬프트 바가 없다. */
  color: { disposition: "hidden" },
  /** CLI 설정 키(autoCompact·chrome·checkpoints…)를 바꾼다. Console Settings가 보여 주지 못한다. */
  config: { disposition: "hidden" },
  /** 자식의 JS 힙을 ~/Desktop에 쓴다. 진단 도구이지 채팅 동작이 아니다. */
  heapdump: { disposition: "hidden" },
  /** 후보에 게이트웨이 모델이 없고, Console의 모델 라벨은 payload에서 읽는 읽기 전용이다. */
  model: { disposition: "hidden" },
  /** "Set effort level to high (this session only)" — 강도 라벨도 같은 payload에서 읽는다. */
  effort: { disposition: "hidden" },
  /** 실행은 되지만 채팅 Operation 제목으로 갈 길이 없다. Console에는 이름 바꾸기가 이미 세 곳 있다. */
  rename: { disposition: "hidden" },
  /** 쿼터 보고. 우현 레일의 Quota 패널이 같은 것을 상시로 그린다. */
  usage: { disposition: "hidden" },
  /** 계정 크레딧 관리 — 브라우저를 연다. */
  "usage-credits": { disposition: "hidden" },
  /** 세션 기록 분석 보고서. 비용이 크고 Console에 세울 자리가 없다. */
  insights: { disposition: "hidden" },
  /** 자식이 붙은 MCP 서버 관리 — TUI의 대화형 흐름이다. */
  mcp: { disposition: "hidden" },
  /** 한 줄 요약 생성. */
  recap: { disposition: "hidden" },
  /** 조건이 찰 때까지 계속 일하게 하는 지시 — 평문 프롬프트로 말하는 것이 이 표면의 문법이다. */
  goal: { disposition: "hidden" },
  /** Design 프로젝트 접근 동의 — 계정 축이고 브라우저로 나간다. */
  design: { disposition: "hidden" },
  "design-consent": { disposition: "hidden" },
  "design-revoke": { disposition: "hidden" },
  /** 사용 기록으로 팀 온보딩 가이드를 만든다. */
  "team-onboarding": { disposition: "hidden" },
});

/**
 * 이 명령이 **원장에 자기 줄을 갖는가.** 자식에게 가서 무언가를 하고 오는 것들이다.
 *
 * 이 줄들은 턴이 아니다. 턴 문법(회전하는 노드·경과 시계·흐르는 글)은 "모델이 생각하고 있다"를
 * 말하는데, 이것들은 세션의 상태를 즉시 바꾸는 정비 동작이라 그 말이 거짓이 된다. 그래서 원장에
 * 서되 자기 어휘로 선다.
 */
export function isChatCommandLane(name: string): boolean {
  return CHAT_COMMAND_POLICY[name]?.lane === true;
}

/** 표에 없으면 숨긴다. 지원 목록이 선별이라, 모르는 이름은 지원하지 않는 것과 같다. */
export function classifyChatCommand(name: string): ChatCommandRule {
  return CHAT_COMMAND_POLICY[name] ?? { disposition: "hidden" };
}

/** 이 판본이 분류를 알고 있는 이름인가. 카탈로그가 미분류를 세어 보고할 때 쓴다. */
export function isClassifiedChatCommand(name: string): boolean {
  return Object.hasOwn(CHAT_COMMAND_POLICY, name);
}
