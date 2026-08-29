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
  /** 이 Operation의 모델 좌표. 세션을 열 때 한 번 정해지고 채팅 중에는 움직이지 않는다. */
  | "model"
  /** 이 Operation의 추론 강도 좌표. 모델과 같은 규율. */
  | "effort"
  /** Operation 제목. Console이 소유하며 캔버스 제목·사이드바가 그 값을 그린다. */
  | "rename"
  /** 컴포저 바의 문맥 계기. 같은 `getContextUsage()` 값을 이미 그리고 있다. */
  | "context"
  /** 문맥 초기화. 자식과 화면 기록을 **함께** 끊어야 하므로 Console이 중개한다. */
  | "clear";

export interface ChatCommandRule {
  readonly disposition: ChatCommandDisposition;
  /** `disposition === "console"`일 때만 있다. */
  readonly target?: ChatCommandConsoleTarget;
}

/**
 * 내장 명령 24개의 처분.
 *
 * 표에 없는 내장 명령은 `passthrough`로 떨어진다 — fail-open이다. 모르는 것을 숨기면 자식이 새로
 * 얻은 기능이 아무 신호 없이 사라지는데, 그 침묵은 잘못 통과시키는 것보다 고치기 어렵다.
 * 대신 분류되지 않았다는 사실 자체를 카탈로그가 실어 보내 눈에 보이게 한다.
 */
export const CHAT_COMMAND_POLICY: Readonly<Record<string, ChatCommandRule>> = Object.freeze({
  // ── 숨김 ──────────────────────────────────────────────────────────────────
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

  // ── Console이 소유 ────────────────────────────────────────────────────────
  /**
   * 자식이 제시하는 후보에 게이트웨이 모델이 하나도 없고(실측: sonnet·opus·haiku·fable·…),
   * Console의 모델 표시는 payload에서 읽는 읽기 전용 라벨이다. 자식에게 현재 모델을 되묻는 API가
   * 계약에 없으므로 바꿔도 라벨은 옛 값을 계속 말한다.
   */
  model: { disposition: "console", target: "model" },
  /** "Set effort level to high (this session only)" — 강도 라벨도 같은 payload에서 읽는다. */
  effort: { disposition: "console", target: "effort" },
  /** 자식은 정말 잊는다. 화면 기록이 그대로 남으면 그 기록이 거짓말을 한다. */
  clear: { disposition: "console", target: "clear" },
  /** 실행되지만 채팅 Operation 제목으로 갈 길이 없다 — provider 제목 반영은 PTY 경로 전용이다. */
  rename: { disposition: "console", target: "rename" },
  /** 같은 `getContextUsage()` 값을 컴포저 바의 문맥 계기가 이미 그린다. */
  context: { disposition: "console", target: "context" },

  // ── 통과 ──────────────────────────────────────────────────────────────────
  /** 자식이 소유한 정당한 동작. 문맥 계기가 compactAt을 이미 알고 있어 결과가 화면에 반영된다. */
  compact: { disposition: "passthrough" },
  /** 디스크의 스킬을 다시 읽는다. 함께 오는 `commands_changed`가 덱의 카탈로그를 무효화한다. */
  "reload-skills": { disposition: "passthrough" },
  /** 실제 쿼터 텍스트. 우현 레일의 Quota 패널과 겹치지만 읽기 전용이라 어긋날 상태가 없다. */
  usage: { disposition: "passthrough" },
  /** 대화 내용에 대한 자식의 요약. */
  recap: { disposition: "passthrough" },
  /** 자식의 작업 방식을 정한다 — Console이 겹쳐 쥔 축이 없다. */
  goal: { disposition: "passthrough" },
  /** 세션 기록을 분석해 보고서를 만든다. */
  insights: { disposition: "passthrough" },
  /** 자식이 붙은 MCP 서버를 말한다. */
  mcp: { disposition: "passthrough" },
  /** 계정 크레딧 관리. 브라우저를 여는 부작용은 자식의 것이고 Console 상태와 겹치지 않는다. */
  "usage-credits": { disposition: "passthrough" },
  /** Design 프로젝트 접근 동의 — 계정 축. */
  design: { disposition: "passthrough" },
  "design-consent": { disposition: "passthrough" },
  "design-revoke": { disposition: "passthrough" },
  /** 사용 기록으로 팀 온보딩 가이드를 만든다. 자식이 소유한 생성 작업. */
  "team-onboarding": { disposition: "passthrough" },
});

/** 표에 없으면 통과다. 이유는 `CHAT_COMMAND_POLICY`의 fail-open 주석에 있다. */
export function classifyChatCommand(name: string): ChatCommandRule {
  return CHAT_COMMAND_POLICY[name] ?? { disposition: "passthrough" };
}

/** 이 판본이 분류를 알고 있는 이름인가. 카탈로그가 미분류를 세어 보고할 때 쓴다. */
export function isClassifiedChatCommand(name: string): boolean {
  return Object.hasOwn(CHAT_COMMAND_POLICY, name);
}
