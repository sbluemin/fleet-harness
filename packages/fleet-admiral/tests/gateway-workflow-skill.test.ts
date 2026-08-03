import { describe, expect, it } from "vitest";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../src/agent-cli/assets.generated.js";

// gateway/workflow 스킬은 모델·effort 배정 규칙의 SSoT다. prompts.test.ts가 Standing Order 본문만
// 고정하던 동안 이 자산은 계약 사각지대였고, 배정 규칙을 통째로 뒤집어도 깨지는 테스트가 없었다.
// 아래 단언은 그 사각지대를 덮는다: 규정이 살아 있는지(toContain)와 폐기된 규정이 되살아나지
// 않는지(not.toContain)를 함께 고정한다.
describe("gateway workflow skill asset", () => {
  function skillContent(): string {
    const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find(
      (entry) => entry.relativePath === "gateway/workflow/SKILL.md",
    );
    expect(asset).toBeDefined();
    return asset?.content ?? "";
  }

  it("is embedded in the agent CLI skill manifest", () => {
    const content = skillContent();

    expect(content).toContain("name: workflow");
    expect(content).toContain("## Model and Effort Assignment");
  });

  it("makes distribution the default and the session model the exception", () => {
    const content = skillContent();

    expect(content).toContain("Distribution is the default.");
    expect(content).toContain("carries the burden of proof");
    expect(content).toContain("Indistinguishable never meant \"inherit\"");
  });

  it("does not restore the superseded inherit-by-default rules", () => {
    const content = skillContent();

    // 이 세 문장이 되살아나면 분산 기본이 무력화된다. 특히 세 번째는 다양화를
    // 판정 스테이지로 한정해 일반 분산과 결합하지 못하게 만들던 문장이다.
    expect(content).not.toContain("Inheriting the session model is the default");
    expect(content).not.toContain("Unsure is not a reason to pin");
    expect(content).not.toContain("Diversify only where disagreement is the product");
  });

  it("requires a live roster read before every run, not only before pinning", () => {
    const content = skillContent();

    expect(content).toContain("Call `gateway_models` first, every time.");
    expect(content).toContain("Not once per session");
  });

  it("routes allowance reads to the model's own pool, with and without a declared scope", () => {
    const content = skillContent();

    expect(content).toContain("whose `scope` matches `constraints.quotaScope` when the model declares one");
    // quotaScope는 Cursor만 선언한다. scope-less 창을 일괄 금지하면 codex/kimi/claude의
    // allowance를 읽을 창이 사라져 분산 정책의 입력 자체가 없어진다.
    expect(content).toContain("the provider's scope-less window when it does not");
  });

  it("ranks windows by the server verdict and confines percent comparison to a shared cadence", () => {
    const content = skillContent();

    // 리셋 주기가 다른 창의 usedPercent 직접 비교는 순위를 뒤집는다 — 주 초반 49%가
    // 월말 78%보다 뜨거운 실측 케이스. 판정(pressure)이 앞서고, percent는 같은
    // cadence 안의 타이브레이크로만 남는다.
    expect(content).toContain('prefer windows at `pressure: "ok"`');
    expect(content).toContain("share a `cadence` by the lower `usedPercent`");
    expect(content).toContain("never compare percentages across cadences");
    // 합산 창을 헤드룸 계산에 넣으면 같은 할당이 두 번 세어진다.
    expect(content).toContain("`isAggregate`");
    // 구 절차가 되살아나면 주기 무시 나이브 비교가 복귀한다.
    expect(content).not.toContain("then send stages toward the lower `usedPercent`");
    // 파생 필드 없는 구형 판독의 fallback도 cycle 다의성(cursor 월간 vs kimi 주간)을
    // 넘어가면 안 된다 — id 공유는 길이 공유가 아니므로 프로바이더 내부 비교로 한정한다.
    expect(content).toContain("comparable only within a single provider's windows");
    expect(content).not.toContain("between windows of the same id only");
  });

  it("forces an effort re-pick and a context-window check when the model changes", () => {
    const content = skillContent();

    expect(content).toContain("Re-pick effort for the model you chose.");
    expect(content).toContain("`effortLadder`");
    expect(content).toContain("`contextWindow`");
  });

  it("separates lineage independence from spend relocation", () => {
    const content = skillContent();

    expect(content).toContain("`homolineage: true`");
    expect(content).toContain("useful for moving spend, useless for independence");
  });

  it("carries both measurements with their dates and figures", () => {
    const content = skillContent();

    expect(content).toContain("indistinguishable on five of them");
    expect(content).toContain("Twelve identities");
    expect(content).toContain("176k total tokens over 5 tool calls");
    expect(content).toContain("5.20M over 29");
    // 캐시 읽기로 부풀려진 수치가 아니라는 근거가 문언에 남아 있어야 재검증이 가능하다.
    expect(content).toContain("not a cache-read artifact");
  });

  it("hands the surface choice back to the Orchestration Policy Standing Order", () => {
    const content = skillContent();

    expect(content).toContain("This skill covers that surface only, and that surface is not the default.");
    expect(content).toContain("makes it the default for exactly that reason");
    // 워크플로가 사는 이유는 배선이다 — 여러 모델을 한 문제에 동시에 붙이는 것을 포함한다.
    expect(content).toContain("a fleet of different models working the same problem at once");
  });

  it("records that exhaustion has no status of its own", () => {
    const content = skillContent();

    expect(content).toContain("There is no exhaustion status.");
    expect(content).toContain("Do not wait for a message that says exhausted.");
    // 게이트웨이 코드가 번역을 보장하지 않는 토큰에 doctrine이 기대면 안 된다.
    expect(content).not.toContain("resource_exhausted");
  });

  it("records that the Agent name set is frozen at session start", () => {
    const content = skillContent();

    expect(content).toContain("Reaching a newly enabled model requires a new session.");
  });

  it("keeps executor-persona vocabulary out of the gateway path", () => {
    const content = skillContent();

    for (const marker of ["subagent", "Subagent", "delegate", "Delegate", "delegation", "Delegation"]) {
      expect(content, `executor naming marker leaked: ${marker}`).not.toContain(marker);
    }
  });
});
