import { describe, expect, it } from "vitest";

import {
  CHAT_COMMAND_POLICY,
  classifyChatCommand,
  isChatCommandLane,
  isClassifiedChatCommand,
} from "../server/agent-api/chat-command-policy.js";

/**
 * 2026-08-29에 살아 있는 Console이 실제로 광고한 내장 명령 전량.
 *
 * 출처는 실행 중 Console의 `chat-catalog` 응답이고(HTTP 200, 명령 24 · 스킬 34 · 에이전트 7),
 * 그 24개가 이 목록이다. 손으로 고른 표본이 아니라 **그 세션의 전량**이라는 점이 중요하다 —
 * 표본이면 빠진 것이 분류되지 않은 채 통과하고, 그것이 이 계약이 막으려는 상태다.
 *
 * 이 픽스처가 잡는 것과 잡지 못하는 것을 분명히 해 둔다. 잡는 것은 **저장소 안의 표류**다:
 * 정책표에 규칙을 더하면서 이 목록을 갱신하지 않거나 그 반대인 경우 red가 된다. 잡지 못하는 것은
 * **새 CLI 판본**이다 — 테스트는 자식을 세우지 않으므로 다음 판본이 무엇을 새로 광고하는지 알 수
 * 없다. 그쪽은 런타임이 진다: 표에 없는 내장 명령은 통과하되 카탈로그의 `unclassified`에 실려,
 * 사라지지 않고 눈에 보이는 채로 남는다.
 */
const MEASURED_BUILT_INS: readonly string[] = [
  "__remote-workflow",
  "agents",
  "clear",
  "color",
  "compact",
  "config",
  "context",
  "design",
  "design-consent",
  "design-revoke",
  "effort",
  "extra-usage",
  "fast",
  "goal",
  "heapdump",
  "insights",
  "mcp",
  "model",
  "recap",
  "reload-skills",
  "rename",
  "team-onboarding",
  "usage",
  "usage-credits",
];

describe("chat command policy", () => {
  it("classifies every built-in the measured child advertised", () => {
    const missing = MEASURED_BUILT_INS.filter((name) => !isClassifiedChatCommand(name));
    expect(missing).toEqual([]);
  });

  it("carries no rule for a name the measured child never advertised", () => {
    // 표가 목록보다 넓어지는 것도 표류다 — 사라진 명령의 규칙이 남으면 다음 사람이 그것을
    // 살아 있는 사실로 읽는다.
    const stale = Object.keys(CHAT_COMMAND_POLICY).filter((name) => !MEASURED_BUILT_INS.includes(name));
    expect(stale).toEqual([]);
  });

  it("supports exactly four commands and hides the rest", () => {
    // 지원 목록은 선별이다. 늘어나면 이 줄이 red가 되고, 그때 늘어난 이름이 이 표면에서 무슨
    // 뜻인지·끝까지 책임질 수 있는지를 사람이 한 번 답해야 한다.
    const supported = Object.entries(CHAT_COMMAND_POLICY)
      .filter(([, rule]) => rule.disposition !== "hidden")
      .map(([name]) => name)
      .sort();
    expect(supported).toEqual(["clear", "compact", "context", "reload-skills"]);
  });

  it("gives a Console target to exactly the commands Console answers", () => {
    const routed = Object.entries(CHAT_COMMAND_POLICY)
      .filter(([, rule]) => rule.disposition === "console")
      .map(([name, rule]) => [name, rule.target] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    expect(routed).toEqual([["clear", "clear"], ["context", "context"]]);
  });

  it("puts a ledger lane on exactly the commands that reach the child", () => {
    // `/context`는 지원되지만 자식에게 가지 않으므로 원장에 줄을 갖지 않는다. `/clear`는
    // Console이 중개하지만 문맥을 비우는 것은 자식뿐이라 간다 — 두 축은 직교한다.
    const lane = Object.keys(CHAT_COMMAND_POLICY).filter((name) => isChatCommandLane(name)).sort();
    expect(lane).toEqual(["clear", "compact", "reload-skills"]);
  });

  it("keeps a target off every command that is not Console's", () => {
    for (const [name, rule] of Object.entries(CHAT_COMMAND_POLICY)) {
      if (rule.disposition === "console") continue;
      expect(rule.target, name).toBeUndefined();
    }
  });

  it("does not stand up a name it has never seen", () => {
    // 지원 목록이 선별이므로 모르는 내장 명령은 세우지 않는다. 이것이 카탈로그의 fail-open과
    // 모순되지 않는 이유: 표에 없는 이름은 카탈로그가 내장 명령이 아니라 **스킬**로 읽어 그대로
    // 세운다. 사라지는 것은 우리가 아는 내장 명령 중 고르지 않은 것뿐이다.
    expect(classifyChatCommand("some-future-command")).toEqual({ disposition: "hidden" });
    expect(isClassifiedChatCommand("some-future-command")).toBe(false);
    expect(isChatCommandLane("some-future-command")).toBe(false);
  });
});
