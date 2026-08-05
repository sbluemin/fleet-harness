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

  // 이름이 양쪽 레지스트리에 모두 있어야 한다는 규칙과 그 실패 신호는, 세션 시작에 고정된
  // Agent 이름과 실시간 로스터가 어긋나는 유일한 경우를 설명하는 문장이다. 조용히 사라지면
  // 호스트는 unknown-name 실패를 로스터 오류로 오진한다.
  it("keeps the both-sides name check and its failure signal", () => {
    const content = skillContent();

    expect(content).toContain("Confirm the name exists on both sides.");
    expect(content).toContain("`400 unknown model` means re-read the roster.");
    expect(content).toContain("Reaching a newly enabled model requires a new session.");
  });

  it("keeps every gateway skeleton routing execution to this skill", () => {
    // workflow 자산만 계약으로 덮여 있었다. 나머지 스켈레톤이 이 라우팅 문장을 잃으면
    // 각 스킬이 모델 배정을 자기 방식으로 다시 정의해도 깨지는 테스트가 없다.
    for (const relativePath of [
      "gateway/architecture-review/SKILL.md",
      "gateway/codebase-research/SKILL.md",
      "gateway/implementation-run/SKILL.md",
      "gateway/quality-review/SKILL.md",
    ]) {
      const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find(
        (entry) => entry.relativePath === relativePath,
      );
      expect(asset, relativePath).toBeDefined();
      expect(asset?.content, relativePath).toContain(
        "model and effort assignment — belongs to `workflow`",
      );
    }
  });

  it("makes distribution the default and the session model the exception", () => {
    const content = skillContent();

    expect(content).toContain("Distribution is the default.");
    expect(content).toContain("carries the burden of proof");
    expect(content).toContain("Indistinguishable never meant \"inherit\"");
    // 입증 책임이 어디서 해소되는지 가리키지 않으면 배정 절차가 게이트와 분리되어
    // 각각 다른 예외 집합을 갖게 된다.
    expect(content).toContain("Gate 2 above is where that burden is discharged");
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
    // 독립성은 검증 대상 기준이지 이 세션 기준이 아니다. 이 구분이 빠지면 E1 —
    // 타 계열 산출물을 Claude 계열이 검증하는 유일한 정당 사례 — 이 성립하지 않는다.
    expect(content).toContain("Judge that against the **subject**, not against this session");
    expect(content).toContain("silent about independence from a subject that ran elsewhere");
    // homolineage 는 모델 id 로만 계산되는 Claude 계열 플래그다(core-ai-gateway/src/models.ts).
    // "세션과 같은 계열"로 읽으면 비-Claude 기본으로 기동된 세션에서 통째로 거짓이 된다.
    expect(content).toContain("derived from the model id alone and silent about what this session runs on");
    expect(content).not.toContain("marks an identity sharing the parent Claude session's lineage");
    // 미핀 스테이지는 자기 계열이 없다 — 세션이 기동된 것을 그대로 물려받는다.
    expect(content).toContain("An unpinned stage has no lineage of its own");
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

  // 표면 선택은 Standing Order 에서 이 스킬로 이관됐다. Gate 1 이 세 표면을 모두 들고
  // 있어야 프롬프트에 남은 트립와이어가 가리킬 대상이 존재한다.
  it("owns the surface choice as Gate 1 with all three surfaces", () => {
    const content = skillContent();

    expect(content).toContain("## Gate 1 — Execution Surface");
    expect(content).toContain("**One Agent**");
    expect(content).toContain("**A named teammate**");
    expect(content).toContain("**The staged workflow surface**");
    // 워크플로가 사는 이유는 배선이다 — 여러 모델을 한 문제에 동시에 붙이는 것을 포함한다.
    expect(content).toContain("a fleet of different models working the same problem at once");
    // 게이트에 막히면 보고 후 대기한다. 호스트가 한 컨텍스트에서 대신 해치우지 않는다.
    expect(content).toContain("Report the gate");
    expect(content).toContain("Do not quietly do the work yourself in one context instead.");
    // Standing Order 로 되돌아간 옛 문장이 남아 있으면 소유권이 두 곳으로 갈라진다.
    expect(content).not.toContain("This skill covers that surface only");
  });

  // ultracode 는 하네스 소유 세션 옵트인이지 effort 사다리의 한 칸이 아니다. effort 로
  // 요청하면 상류에서 신호 없이 클램프되므로, 이 구분이 문언에 남아 있어야 한다.
  it("names the staged-surface opt-in as a harness trigger and never as an effort rung", () => {
    const content = skillContent();

    expect(content).toContain("A surface gated behind user opt-in is unavailable until that opt-in exists.");
    expect(content).toContain("`ultracode`");
    expect(content).toContain("That trigger belongs to the harness, not to Fleet");
    expect(content).toContain("never a reasoning-effort rung");
  });

  // Model Pin Gate 의 핵심: 세션 자신의 allowance 는 선택이 아니라 누락으로 도달한다.
  // 이 문장이 사라지면 미핀 실행이 다시 중립 선택처럼 읽힌다.
  it("makes the session's own allowance the last one to spend in Gate 2", () => {
    const content = skillContent();

    expect(content).toContain("## Gate 2 — Model Pin Gate");
    expect(content).toContain("An unpinned run is not the neutral choice");
    expect(content).toContain(
      "The parent session's own allowance is the last one to spend, not the first.",
    );
    expect(content).toContain("it can never be selected, only inherited");
  });

  // 세션이 게이트웨이 기본 모델로 기동되면 ANTHROPIC_MODEL 이 그 모델로 잡히므로, 미핀
  // 실행이 쓰는 것은 claude 항목이 아니라 그 모델을 서빙하는 프로바이더 항목이다.
  // 기준선을 claude 로 못 박으면 실제로 소진 중인 창을 비켜 가면서 엉뚱한 창을 아낀다.
  it("derives the inherited allowance from what the session runs on, never from a fixed provider", () => {
    const content = skillContent();

    expect(content).toContain("the roster cannot tell you");
    expect(content).toContain("never what this session itself runs on");
    // 게이트웨이 기본으로 기동된 세션의 실패 양상은 재귀다 — 이미 이 세션을 지고 있는
    // 창에 실행을 더 얹는다.
    expect(content).toContain("A session launched on a gateway default spends an entry that both reports *and* serves");
    expect(content).toContain("drains one allowance twice");
    // claude 항목도 창을 보고한다(model-loadout.ts buildProviders 가 PARENT_PROVIDER_ID 를
    // 항상 넣고 스냅샷을 enrich 한다). "보이지 않는다"고 쓰면 호스트가 실제로 읽히는
    // claude pressure 를 E2 판정에서 통째로 버린다. 차이는 가시성이 아니라 선택 가능성이다.
    expect(content).toContain("every provider's allowance is reported, the parent subscription included");
    expect(content).not.toContain("that spend surfaces in no window at all");
    expect(content).not.toContain("nothing in the response will show it rising");
    // isSessionDefault 는 현재 Settings 를 비출 뿐, 이미 돌고 있는 세션의 기동값이 아니다.
    expect(content).toContain("`isSessionDefault` does not settle which case you are in");
    // claude 를 보편 기준선으로 되돌리면 그 구분이 통째로 사라진다.
    expect(content).not.toContain("it is what an unpinned run spends, and the baseline any offload is measured against");
  });

  // lineage(누구의 사각지대)와 allowance(누구의 구독)는 직교한다. 둘을 합치면
  // cursor 를 통한 Claude 계열 — 정당한 spend 이전 — 이 금지되거나, 반대로 세션
  // 모델 상속이 비용 논거로 정당화된다.
  it("keeps the lineage and allowance axes separate and binds the rule to allowance", () => {
    const content = skillContent();

    expect(content).toContain("This axis decides independence, never cost.");
    expect(content).toContain("This axis decides cost, never independence.");
    expect(content).toContain("The rule below binds the allowance axis only.");
  });

  // 예외는 셋뿐이고 각각 라벨로 기록된다. E2 의 "읽히지 않는 allowance 는 고갈의
  // 증거가 아니다"가 빠지면 조회 실패가 곧 최후의 보루 발동으로 둔갑한다.
  it("admits exactly three labelled exceptions and closes the unreadable-allowance loophole", () => {
    const content = skillContent();

    expect(content).toContain("Three exceptions, and only these three.");
    expect(content).toContain("**E1 — cross-lineage verification.**");
    expect(content).toContain("**E2 — last resort.**");
    expect(content).toContain("**E3 — empty roster.**");
    // E1 이 무제한이면 검증 정족수가 통째로 세션 계열이 되어 독립성이 사라진다.
    expect(content).toContain("lineage must not hold a majority of the quorum");
    // E2 는 조회 불가를 근거로 열 수 없다.
    expect(content).toContain("is **not** evidence of exhaustion");
    expect(content).toContain("run one alternative identity alongside");
    // E1 은 상속될 계열이 검증 대상과 다르다는 것을 "확인"해야 성립한다. 비-Claude
    // 게이트웨이 기본으로 기동된 세션은 대상과 같은 계열을 상속할 수 있고, 그대로
    // 두면 교차 계열 검증이라 기록하면서 독립성은 하나도 사지 못한다.
    expect(content).toContain("the lineage this run would inherit differs from the subject's");
    expect(content).toContain("That last one is a check, never an assumption");
    expect(content).toContain("the flag describes a model, not this session");
    // 대상 계열을 비-Claude 로 못 박고 세션을 Claude 로 가정하던 구 전제가 되살아나면
    // 같은 결함이 그대로 돌아온다.
    expect(content).not.toContain("the subject under examination ran on a non-Claude lineage");
    // 미측정(roleFit: null)이 네 번째 예외로 승격되면 게이트가 무력화된다.
    expect(content).toContain("`roleFit: null` is not a fourth exception");
    // 라벨 없는 상속과 의도된 예외는 사후에 구별되지 않는다.
    expect(content).toContain("the `E1` / `E2` / `E3` label");
  });

  // 두 게이트는 위임 여부를 정하지 않는다. 이 봉인이 빠지면 스킬이 위임 압력으로 읽힌다.
  it("refuses to become a delegation mandate in either direction", () => {
    const content = skillContent();

    expect(content).toContain("Neither decides *whether* to hand work off");
    expect(content).toContain("a reason to create a run you would not otherwise have made");
    expect(content).toContain("not a reason to absorb a run you would have made");
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
