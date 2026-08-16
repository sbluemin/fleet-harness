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
      "gateway/workflow-architecting/SKILL.md",
      "gateway/workflow-research/SKILL.md",
      "gateway/workflow-review/SKILL.md",
    ]) {
      const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find(
        (entry) => entry.relativePath === relativePath,
      );
      expect(asset, relativePath).toBeDefined();
      expect(asset?.content, relativePath).toContain(
        "model and effort assignment — belongs to `workflow`",
      );
      // 퇴역한 스킬로 라우팅하면 호스트가 없는 스킬을 부르려다 스켈레톤 없이
      // 즉흥 실행으로 폴백한다 — 구조화된 실행보다 드리프트가 크다.
      expect(asset?.content, relativePath).not.toContain("workflow-implementing");
    }
  });

  it("scopes distribution to mechanical roles and keeps the session model the exception", () => {
    const content = skillContent();

    expect(content).toContain("Distribution is the default for mechanical roles");
    expect(content).toContain("for judgment roles the top reachable quality band is the default");
    expect(content).toContain("carries the burden of proof");
    expect(content).toContain("Indistinguishable never meant \"inherit\"");
    // 입증 책임이 어디서 해소되는지 가리키지 않으면 배정 절차가 게이트와 분리되어
    // 각각 다른 예외 집합을 갖게 된다.
    expect(content).toContain("Gate 2 above is where that burden is discharged");
    // 무조건 분산이 되살아나면 판단석이 다시 할당량 축으로 떨어진다 — 실측된 실패:
    // 아키텍처 Propose 3석 중 2석이 light 모델(luna·deepseek-flash)에 배정됐다.
    expect(content).not.toContain("Distribution is the default.");
  });

  // 판단/기계 2-체제가 이 스킬의 새 척추다. 역할표·class 바닥·축소 규칙 중 하나라도
  // 조용히 사라지면 판단석이 다시 할당량 축으로 떨어진다.
  it("assigns judgment seats by capability class and keeps mechanical fans on distribution", () => {
    const content = skillContent();

    expect(content).toContain("| **Judgment** | decompose, propose, decide, judge, synthesize |");
    expect(content).toContain("| **Mechanical** | map, scan, extract, transform, implement, verify |");
    expect(content).toContain("quality evidence first");
    expect(content).toContain("the `capabilityClass` prior where not");
    // band-eligible 부족 시 줄이거나 반복 착석한다 — 밴드 아래로 머릿수를 채우는
    // 순간 이 체제 전체가 무효가 된다.
    expect(content).toContain("repeat-seat one as independent runs or shrink the fan");
    expect(content).toContain("never filled from below the band to make a count");
    // verify(닫힌 반박)와 judge(열린 채점)가 갈라지지 않으면 아키텍처 심판이 verify 로
    // 표기되어 class 바닥을 벗어난다.
    expect(content).toContain("that is `judge`, and it is judgment");
    // 판단 팬 크기는 배정 4단계 소유다 — bulk 절이 다시 전체를 잡으면 축소 규칙이 죽는다.
    expect(content).toContain("This subsection sizes mechanical fans only.");
    // 구 절차의 열거식 방어선이 되살아나면 Propose 가 다시 목록 누락으로 빠진다.
    expect(content).not.toContain("Do not choose the load-bearing stage by allowance alone");
  });

  // 측정>주장 재편의 척추다. 밴드·노이즈·caveat·우선순위 중 하나라도 조용히 사라지면
  // 판단석이 다시 공급자 주장(class)만으로 채워지거나, 사용자 옵트인이 예보에 뒤집힌다.
  it("ranks judgment seats by measured evidence and honors the user's provider priority", () => {
    const content = skillContent();

    expect(content).toContain("### Reading quality evidence");
    expect(content).toContain("Measurement outranks the claim.");
    expect(content).toContain("a measured `standard` model above the band beats an unmeasured `flagship` claim");
    expect(content).toContain("Scores within `routingTieBandPoints` are one band, not an ordering.");
    expect(content).toContain("Read `caveat` before trusting a standout.");
    // 우선순위는 allowance 축 전용이다 — 품질 밴드를 넘으면 판단석이 할당량 축으로 떨어진다.
    expect(content).toContain("`providerPriority` is the user's standing order on this axis.");
    expect(content).toContain("It outranks the pressure forecast, `critical` included");
    expect(content).toContain("It never lifts an identity across a quality band");
    // 예보(pressure)로 사용자 명령을 뒤집는 조용한 재배분이 되살아나면 안 된다.
    expect(content).toContain("leave a listed provider only on observation");
    // 판단석 자격 필터(non-critical)가 우선순위 예외 없이 남으면, 우선 공급자의 판단
    // 후보가 관측 실패 전에 예보만으로 배제된다 — 실측 리뷰가 잡은 자기모순.
    expect(content).toContain("A listed provider's identities stay eligible for judgment seats at any forecast.");
    expect(content).toContain("not `critical` unless the user listed it in `providerPriority`");
    // 소스가 둘이면 소스 간 점수 비교라는 오류 계열이 생긴다 — 카탈로그는 단일 소스가
    // 정책이고, 미측정 모델은 class prior 로만 읽는다(빈칸을 외부 수치로 메우지 않는다).
    expect(content).toContain("The catalog carries one benchmark source deliberately.");
    expect(content).toContain("read it by its class prior alone");
    expect(content).toContain("never fill the gap with a number from anywhere else");
    // E2가 예보만으로 열리면 우선 공급자의 critical이 관측 실패 없이 세션 모델 예외를
    // 여는 뒷문이 된다 — 우선순위의 "관측만이 이탈 근거" 규칙과 직접 충돌.
    expect(content).toContain("never opens E2 on its forecast");
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
    expect(content).toContain('Prefer `pressure: "ok"`');
    // 판정이 있는데도 스스로 퍼센트를 재해석하면 건강한 프로바이더를 비켜 간다 —
    // 한 응답이 elevated 35% 창과 ok 64% 창을 함께 싣는다.
    expect(content).toContain("outranks arithmetic of your own");
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
    // parity 는 닫힌 과업에서만 측정됐다(role-fit.ts 의 tokenEfficiency 주석과 같은
    // 한정). 이 스코프가 프롬프트에서 빠지면 판단 역할까지 parity 로 정당화되어
    // class 바닥이 무력화된다 — 소스 주석에만 있는 의도는 모델에 도달하지 않는다.
    expect(content).toContain("quality parity is the prior on closed roles");
    expect(content).toContain("Both measurements were closed tasks");
    expect(content).toContain("a model that spends less there may be answering less");
  });

  // workflow-implementing 퇴역 후, 파일을 쓰는 실행의 규율은 이 스킬이 단독으로 진다.
  // 대응하는 스켈레톤이 없으므로 이 문언이 사라지면 되살릴 다른 문서가 없다 — 리터럴
  // 배리어가 빠지는 순간 각 분기가 자기 값을 지어내고, 그것이 퇴역을 부른 실패 그대로다.
  it("carries the writing-run rules that no skeleton covers", () => {
    const content = skillContent();

    expect(content).toContain("### When the run writes files");
    expect(content).toContain("Writing work has no stage skeleton of its own");
    expect(content).toContain("Fix every literal on the host first.");
    expect(content).toContain("Isolate every writing branch.");
    expect(content).toContain("Inspect artifacts, never narratives.");
    expect(content).toContain("A site needing a new decision stops.");
    expect(content).toContain("Reject rather than patch.");
    // 측정 범위 한정이 빠지면 sweeping·cross-package 실행이 측정된 것처럼 읽힌다.
    expect(content).toContain("Only local, well-precedented edits were measured.");
    // 퇴역한 스킬 이름이 남으면 호스트가 존재하지 않는 스킬을 로드하려 한다.
    expect(content).not.toContain("workflow-implementing");
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
    expect(content).toContain("The session's own allowance is the last one to spend");
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
    expect(content).toContain("A session launched on a gateway model spends an entry that both reports *and* serves");
    expect(content).toContain("drains one allowance twice");
    // claude 항목도 창을 보고한다(model-loadout.ts buildProviders 가 PARENT_PROVIDER_ID 를
    // 항상 넣고 스냅샷을 enrich 한다). "보이지 않는다"고 쓰면 호스트가 실제로 읽히는
    // claude pressure 를 E2 판정에서 통째로 버린다. 차이는 가시성이 아니라 선택 가능성이다.
    expect(content).toContain("every provider's allowance is reported, the parent subscription included");
    expect(content).not.toContain("that spend surfaces in no window at all");
    expect(content).not.toContain("nothing in the response will show it rising");
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

  // 예외는 넷뿐이고 각각 라벨로 기록된다. E2 의 "읽히지 않는 allowance 는 고갈의
  // 증거가 아니다"가 빠지면 조회 실패가 곧 최후의 보루 발동으로 둔갑한다.
  it("admits exactly four labelled exceptions and closes the unreadable-allowance loophole", () => {
    const content = skillContent();

    expect(content).toContain("Four exceptions, and only these four.");
    expect(content).not.toContain("Three exceptions, and only these three.");
    expect(content).toContain("**E1 — cross-lineage verification.**");
    expect(content).toContain("**E2 — last resort.**");
    expect(content).toContain("**E3 — empty roster.**");
    // E4 는 능력을 사는 문이지 편의의 문이 아니다 — 도달 가능한 flagship 하나가 닫고,
    // 세션 모델은 스테이지당 한 석을 넘지 못한다. 이 캡이 빠지면 "판단 스테이지니까
    // 항상 세션 모델"이 게이트 전체를 삼킨다.
    expect(content).toContain("**E4 — judgment floor.**");
    expect(content).toContain("E4 buys capability, never convenience");
    expect(content).toContain("at most one seat per stage");
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
    // 무등급(라우터)이 예외로 승격되면 게이트가 무력화된다 — 무등급은 판단석 자격이
    // 없을 뿐이고, 기계석은 allowance 로 떨어진다.
    expect(content).toContain("An unclassed entry opens no exception of its own");
    // 라벨 없는 상속과 의도된 예외는 사후에 구별되지 않는다.
    expect(content).toContain("the `E1` / `E2` / `E3` / `E4` label");
    // E1 좌석 수가 남은 프로바이더 수에 연동되면 프로바이더가 줄수록 세션 계열이 늘어난다.
    // 실측 실패가 그것이었다 — 비-세션 프로바이더 둘이 빠지자 세션 분기가 2에서 5로 늘었다.
    expect(content).toContain("one verifier seat per verify stage");
  });

  // 배분 규칙이 산문에만 남으면 프로바이더가 줄 때마다 세션 계열이 팬아웃을 흡수한다.
  it("budgets bulk fan-out on non-session providers and never grows the session's share", () => {
    const content = skillContent();

    // 균등 분배는 아이덴티티가 아니라 프로바이더 단위다 — 모델을 둘 노출한 쪽이 두 배를
    // 가져가면 "프로바이더 N개에 균등"이 아니라 노출 수 경쟁이 된다.
    expect(content).toContain("Count providers, not identities");
    expect(content).toContain("no provider more than one branch above another");
    // 남은 하나가 높은 사용률이어도 금지가 아니다. 여기서 물러설 곳은 세션 자기 창뿐이다.
    expect(content).toContain("One eligible provider left carries the whole fan-out");
    // 조회 불가는 고갈이 아니므로 E2 를 열 수 없다 — 열리면 팬아웃이 세션 모델로 접힌다.
    expect(content).toContain("an unreadable allowance never opens E2");
    // 쿼터 수치로 분기 수를 깎는 것은 Proportionality 가 아니라 회피다.
    expect(content).toContain("an allowance reading never trims it");
  });

  // roleFit 측정 테이블은 capabilityClass 로 대체·폐기됐다. 스킬 문언에 되살아나면
  // 품질 신호가 두 벌이 되어 판단석 배정이 어느 축을 읽을지 갈라진다.
  it("carries no retired roleFit vocabulary", () => {
    const content = skillContent();

    expect(content).not.toContain("roleFit");
    expect(content).not.toContain("measured fit");
    expect(content).not.toContain("Look for a measured fit");
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
