import {
  CURSOR_SUBSCRIPTION_MODELS,
  GATEWAY_MODELS,
  findGatewayModel,
  type GatewayModel,
} from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { buildGatewayAgentFiles, FLEET_PLUGIN_NAME } from "../src/agent-cli/gateway-agents.js";
import { buildGatewayModelsToolSpec, GATEWAY_MODELS_TOOL_ID } from "../src/ai-gateway/gateway-models-tool.js";
import { buildGatewayLoadout, type GatewayLoadout } from "../src/ai-gateway/model-loadout.js";
import { isHostSessionToolAllowed } from "../src/tools.js";

function allModels(loadout: ReturnType<typeof buildGatewayLoadout>) {
  return Object.values(loadout.providers).flatMap((provider) => provider.models);
}

/**
 * 세션이 실제로 등록하는 철자. 정의는 플러그인 `agents/`에 파일로 놓이고 Claude Code가
 * `<plugin>:<파일 stem>`으로 등록하므로, 로스터가 보고하는 이름은 그 파일 집합에서 나와야
 * 한다 — 다른 곳에서 다시 만들면 둘이 갈라져도 이 테스트가 알아채지 못한다.
 */
function registeredSelectors(
  exposed: readonly GatewayModel[],
  exposure?: Parameters<typeof buildGatewayAgentFiles>[1],
): Set<string> {
  return new Set(buildGatewayAgentFiles(exposed, exposure)
    .map((file) => `${FLEET_PLUGIN_NAME}:${file.fileName.replace(/\.md$/u, "")}`));
}

function model(id: string): GatewayModel {
  const found = findGatewayModel(id);
  if (!found) throw new Error(`missing catalog model: ${id}`);
  return found;
}

describe("gateway loadout agent type selectors", () => {
  // 로스터는 호스트가 매 run 직전에 읽는 유일한 권위다. 여기에 이름이 없으면 호스트는
  // 이름을 요구하는 자리에 넣을 값을 회수할 방법이 없어 모델 id를 넣고 실패한다.
  it("keys selectors by the model's own ladder and matches the registered agents", () => {
    const exposed = [model("cursor--claude-opus-5"), model("opencode--deepseek-v4-pro")];
    const registered = registeredSelectors(exposed);
    const loadout = buildGatewayLoadout({ exposed });

    expect(allModels(loadout).length).toBe(exposed.length);
    for (const entry of allModels(loadout)) {
      const keys = Object.keys(entry.agentTypes).sort();
      expect(keys, entry.modelId).toEqual(
        entry.constraints.effortSupported ? [...entry.constraints.effortLadder].sort() : ["none"],
      );
      for (const name of Object.values(entry.agentTypes)) {
        // 같은 transform으로 만들어야 로스터가 세션에 등록된 이름과 어긋나지 않는다.
        expect(registered.has(name), `${entry.modelId} -> ${name}`).toBe(true);
        expect(name).not.toBe(entry.modelId);
      }
    }
  });

  // 사용자가 강도를 좁히면 정체성이 사라진다. 로스터가 카탈로그 사다리를 계속
  // 보고하면 호스트는 등록되지 않은 이름을 고르고, 그 실패는 세션 시작 뒤에야 난다.
  it("reports only the exposed rungs and keeps them matched to the registered agents", () => {
    const kimi = model("kimi--k3");
    const effortExposure = { [kimi.id]: ["max"] as const };
    const registered = registeredSelectors([kimi], effortExposure);
    const loadout = buildGatewayLoadout({ exposed: [kimi], effortExposure });
    const entry = allModels(loadout)[0];

    expect(entry?.constraints.effortLadder).toEqual(["max"]);
    expect(Object.keys(entry?.agentTypes ?? {})).toEqual(["max"]);
    expect(registered).toEqual(new Set(Object.values(entry?.agentTypes ?? {})));
    expect(registered.size).toBe(1);
  });

  it("moves the revision when a model's exposed rungs change", () => {
    const kimi = model("kimi--k3");
    const whole = buildGatewayLoadout({ exposed: [kimi] });
    const narrowed = buildGatewayLoadout({
      exposed: [kimi],
      effortExposure: { [kimi.id]: ["max"] },
    });

    expect(narrowed.revision).not.toBe(whole.revision);
  });

  it("ignores an exposure that narrows to nothing", () => {
    const kimi = model("kimi--k3");
    const whole = buildGatewayLoadout({ exposed: [kimi] });
    // 사다리와 하나도 겹치지 않는 선택은 정체성 0개를 뜻하게 두지 않는다.
    const stale = buildGatewayLoadout({
      exposed: [kimi],
      effortExposure: { [kimi.id]: ["xhigh"] },
    });

    expect(allModels(stale)[0]?.constraints.effortLadder)
      .toEqual(allModels(whole)[0]?.constraints.effortLadder);
  });
});

describe("gateway loadout quality signal", () => {
  it("carries no per-model measurement table alongside the class prior", () => {
    // roleFit 측정 테이블은 capabilityClass 로 대체·폐기됐다. 로스터에 되살아나면
    // 품질 어휘가 두 벌이 되어, 판단석 배정이 어느 축을 읽을지 갈라진다.
    const loadout = buildGatewayLoadout({ exposed: [model("codex--gpt-5.6-sol")] });
    expect(JSON.stringify(loadout)).not.toContain("roleFit");
  });

});

describe("gateway loadout", () => {
  it("reports only the exposed models and marks the session default", () => {
    const exposed = [model("kimi--k3"), model("cursor--grok-4.5-fast")];
    const loadout = buildGatewayLoadout({ exposed, defaultModel: exposed[0] });
    expect(allModels(loadout)).toHaveLength(2);
    expect(allModels(loadout).map((entry) => entry.isSessionDefault)).toEqual([true, false]);
    // 노출하지 않은 모델은 게이트웨이가 여전히 실행하므로, 로스터에 새면
    // 사용자가 끈 선택이 오류 없이 뒤집힌다.
    const ids = allModels(loadout).map((entry) => entry.modelId);
    expect(ids.some((id) => id.includes("claude-opus-5"))).toBe(false);
  });

  it("reports an unreadable allowance as unsupported instead of omitting it", () => {
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3"), model("cursor--grok-4.5-fast")],
      quota: { cursor: { status: "ok", windows: [{ id: "cycle", scope: "auto", usedPercent: 62 }] } },
    });
    const kimi = loadout.providers.kimi;
    expect(kimi?.quota.status).toBe("unsupported");
  });

  it("keeps the parent allowance in the roster as the baseline for offloading", () => {
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: { claude: { status: "ok", windows: [{ id: "weekly", usedPercent: 28 }] } },
    });
    // claude는 게이트웨이 모델을 제공하지 않지만, 고정하지 않은 Phase가 소모하는
    // 예산이므로 오프로드 판단의 기준선으로 남아야 한다.
    expect(Object.keys(loadout.providers)).toContain("claude");
  });

  it("keeps the parent allowance listed even when nothing could be read at all", () => {
    // 쿼터 조회가 실패하면 claude는 노출 프로바이더가 아니어서 목록에서 통째로 빠질 수
    // 있다. 그러면 호스트는 "읽지 못했다"와 "그런 예산이 없다"를 구별하지 못한다.
    const loadout = buildGatewayLoadout({ exposed: [model("kimi--k3")] });
    const parent = loadout.providers.claude;
    expect(parent?.quota.status).toBe("unsupported");
  });

  it("does not claim which allowance an unpinned stage spends", () => {
    // 세션의 시작 모델은 런치 시점 환경으로 정해지고 세션 안에서 바뀔 수 있는데, 이
    // 도구는 런타임당 한 번 등록되어 어느 세션이 무엇으로 떴는지 볼 수 없다. 설정값을
    // 기준선으로 발표하면 이미 떠 있는 세션과 어긋난 답을 자신 있게 내놓게 된다.
    const settled = buildGatewayLoadout({
      exposed: [model("kimi--k3"), model("cursor--grok-4.5-fast")],
      defaultModel: model("kimi--k3"),
    });
    for (const provider of Object.values(settled.providers)) {
      expect(Object.keys(provider)).toEqual(["quota", "models"]);
    }
    // 기본 모델이 무엇이든 프로바이더 목록 자체는 달라지지 않는다.
    const undefaulted = buildGatewayLoadout({
      exposed: [model("kimi--k3"), model("cursor--grok-4.5-fast")],
    });
    expect(Object.keys(settled.providers))
      .toEqual(Object.keys(undefaulted.providers));
  });

  it("moves the revision when exposure changes but not when a reading does", () => {
    const one = buildGatewayLoadout({ exposed: [model("kimi--k3")] });
    const two = buildGatewayLoadout({ exposed: [model("kimi--k3"), model("cursor--grok-4.5-fast")] });
    const defaulted = buildGatewayLoadout({ exposed: [model("kimi--k3")], defaultModel: model("kimi--k3") });
    const requoted = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: { kimi: { status: "ok", windows: [{ id: "cycle", usedPercent: 47 }] } },
    });
    expect(one.revision).not.toBe(two.revision);
    expect(one.revision).not.toBe(defaulted.revision);
    // 사용량은 스스로 움직인다. 이것까지 revision에 넣으면 매 조회가 로스터 변경으로
    // 보여, 실제 노출 편집이 묻힌다.
    expect(one.revision).toBe(requoted.revision);
  });

  it("carries the pool a Cursor model is billed against", () => {
    for (const cursorModel of CURSOR_SUBSCRIPTION_MODELS) {
      const loadout = buildGatewayLoadout({ exposed: [cursorModel] });
      expect(allModels(loadout)[0]?.constraints.quotaScope).toBeDefined();
    }
  });

  it("carries the provider-stated capability class into constraints", () => {
    const loadout = buildGatewayLoadout({
      exposed: [model("opencode--deepseek-v4-flash"), model("codex--gpt-5.6-sol")],
    });
    // 판단석 배정의 prior 가 로스터에서 빠지면 호스트는 이름 문자열로 등급을 추측하게 된다.
    const classes = allModels(loadout).map((entry) => entry.constraints.capabilityClass);
    expect(classes).toContain("light");
    expect(classes).toContain("flagship");
  });

  it("carries benchmark evidence into constraints when the catalog has figures", () => {
    const loadout = buildGatewayLoadout({ exposed: [model("codex--gpt-5.6-sol-fast")] });
    expect(allModels(loadout)[0]?.constraints.benchmark?.source).toBe("CursorBench 3.2");
  });

  it("carries providerPriority through to the payload and into the revision", () => {
    const exposed = [model("kimi--k3")];
    const without = buildGatewayLoadout({ exposed });
    const withPriority = buildGatewayLoadout({
      exposed,
      providerPriority: ["cursor", "kimi"],
    });
    const samePriority = buildGatewayLoadout({
      exposed,
      providerPriority: ["cursor", "kimi"],
    });
    const reordered = buildGatewayLoadout({
      exposed,
      providerPriority: ["kimi", "cursor"],
    });

    expect(without.providerPriority).toBeUndefined();
    expect(withPriority.providerPriority).toEqual(["cursor", "kimi"]);
    expect(withPriority.revision).not.toBe(without.revision);
    expect(samePriority.revision).toBe(withPriority.revision);
    expect(reordered.revision).not.toBe(withPriority.revision);
  });
});

describe("gateway loadout derived quota metrics", () => {
  const WEEK_MS = 604_800_000;
  const AT = 1_700_000_000_000;

  function weeklyWindow(usedPercent: number, elapsedFraction: number) {
    const startsAt = AT - Math.round(WEEK_MS * elapsedFraction);
    return {
      id: "weekly",
      usedPercent,
      resetsAt: startsAt + WEEK_MS,
      period: { durationMs: WEEK_MS, durationBasis: "catalog", startsAt, startsAtBasis: "derived" },
    };
  }

  function firstWindow(loadout: ReturnType<typeof buildGatewayLoadout>, providerId: string) {
    const quota = loadout.providers[providerId]?.quota;
    return quota && "windows" in quota ? quota.windows?.[0] : undefined;
  }

  it("normalizes burn pace to the window's own clock so naive percent ranking inverts", () => {
    // 2026-08-03 실측 반례를 그대로 고정한다: 주 후반의 44%는 페이스 0.46(여유)이고
    // 주 초반의 49%는 페이스 1.42(경보 직전)다. usedPercent 직접 비교는 이 순위를
    // 정반대로 읽는다 — 이 역전이 파생지표가 존재하는 이유다.
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: {
        claude: { status: "ok", windows: [weeklyWindow(44, 0.955)], fetchedAt: AT },
        codex: { status: "ok", windows: [weeklyWindow(49, 0.345)], fetchedAt: AT },
      },
    });
    const claude = firstWindow(loadout, "claude");
    const codex = firstWindow(loadout, "codex");
    expect(claude).toMatchObject({
      cadence: "weekly",
      paceRatio: 0.46,
      recoveryHalfLifeMs: WEEK_MS / 2,
      pressure: "ok",
    });
    // 페이스가 1 미만이면 리셋 전에 100%에 닿지 않는다 — 부재가 "안전"의 표현이다.
    expect(claude).not.toHaveProperty("projectedExhaustionAt");
    expect(codex).toMatchObject({ cadence: "weekly", paceRatio: 1.42, pressure: "elevated" });
    expect(codex?.projectedExhaustionAt).toBeDefined();
    expect(codex?.projectedExhaustionAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(codex?.resetsAt ?? 0);
  });

  it("omits the pace family instead of clamping when the window is too young", () => {
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: { kimi: { status: "ok", windows: [weeklyWindow(2, 0.01)], fetchedAt: AT } },
    });
    const window = firstWindow(loadout, "kimi");
    // 경과율 1%에서의 페이스 2.0은 신호가 아니라 노이즈다. clamp된 값은 진짜 신호로
    // 오독되므로 필드 자체를 생략한다.
    expect(window).not.toHaveProperty("paceRatio");
    expect(window).not.toHaveProperty("projectedExhaustionAt");
    expect(window).toMatchObject({ cadence: "weekly", pressure: "ok" });
  });

  it("still issues a percent-band pressure verdict when no period is known", () => {
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: {
        cursor: {
          status: "ok",
          windows: [
            { id: "cycle", usedPercent: 97, scope: "api" },
            { id: "cycle", usedPercent: 85, scope: "auto" },
            { id: "cycle", usedPercent: 40, isAggregate: true },
          ],
          fetchedAt: AT,
        },
      },
    });
    const quota = loadout.providers.cursor?.quota;
    const windows = quota && "windows" in quota ? quota.windows ?? [] : [];
    // 기간이 없어도 판정은 항상 실린다 — 소비자가 산술 없이 읽을 단일 축이다.
    expect(windows.map((window) => window.pressure)).toEqual(["critical", "elevated", "ok"]);
    expect(windows.map((window) => window.cadence)).toEqual([undefined, undefined, undefined]);
    // 사실 필드는 파생을 붙여도 그대로 살아남는다.
    expect(windows[2]?.isAggregate).toBe(true);
  });

  it("does not fabricate pace from a reading taken after the window reset", () => {
    const startsAt = AT - WEEK_MS * 2;
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: {
        codex: {
          status: "ok",
          // 관측(fetchedAt=AT)이 resetsAt 이후다: 이 percent는 이미 끝난 회차의 것이다.
          windows: [{
            id: "weekly",
            usedPercent: 60,
            resetsAt: startsAt + WEEK_MS,
            period: { durationMs: WEEK_MS, durationBasis: "upstream", startsAt, startsAtBasis: "derived" },
          }],
          fetchedAt: AT,
        },
      },
    });
    const window = firstWindow(loadout, "codex");
    expect(window).not.toHaveProperty("paceRatio");
    expect(window).toMatchObject({ cadence: "weekly", pressure: "ok" });
  });

  it("treats startsAt plus duration as the reset boundary when resetsAt is absent", () => {
    // resetsAt이 빠진 판독이라도 startsAt+durationMs는 같은 경계를 말한다. 이 가드가
    // 없으면 몇 주 지난 관측이 elapsed=1로 clamp되어 낮은 pace로 위장한다.
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: {
        codex: {
          status: "ok",
          windows: [{
            id: "weekly",
            usedPercent: 60,
            period: {
              durationMs: WEEK_MS,
              durationBasis: "upstream",
              startsAt: AT - WEEK_MS * 2,
              startsAtBasis: "upstream",
            },
          }],
          fetchedAt: AT,
        },
      },
    });
    const window = firstWindow(loadout, "codex");
    expect(window).not.toHaveProperty("paceRatio");
    expect(window).toMatchObject({ cadence: "weekly", pressure: "ok" });
  });

  it("measures elapsed time at fetchedAt, not at the wall clock of the call", () => {
    // 요약은 캐시된다. 벽시계로 경과율을 재면 같은 판독이 조회 시각에 따라 다른
    // 페이스를 내놓는다 — 관측 시각이 pace의 유일한 기준점이다.
    const window = weeklyWindow(50, 0.5);
    const atFetch = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: { codex: { status: "ok", windows: [window], fetchedAt: AT } },
      now: () => AT + WEEK_MS,
    });
    const enriched = firstWindow(atFetch, "codex");
    expect(enriched?.paceRatio).toBe(1);
    // 정확히 리셋 시점에 100%에 닿는 궤도는 조기 고갈이 아니다 — 경계는 엄격 미만이다.
    expect(enriched).not.toHaveProperty("projectedExhaustionAt");
  });
});

describe("gateway_models tool", () => {
  it("is withheld from native sessions that cannot route its ids", () => {
    expect(isHostSessionToolAllowed(GATEWAY_MODELS_TOOL_ID, "gateway")).toBe(true);
    expect(isHostSessionToolAllowed(GATEWAY_MODELS_TOOL_ID, "native")).toBe(false);
  });

  it("resolves the roster on every call rather than at registration", async () => {
    let exposed = [model("kimi--k3")];
    const spec = buildGatewayModelsToolSpec({ readSelection: () => ({ models: exposed }) });
    const first = await spec.execute({}, {} as never) as { details: GatewayLoadout };
    exposed = [model("kimi--k3"), model("cursor--grok-4.5-fast")];
    const second = await spec.execute({}, {} as never) as { details: GatewayLoadout };
    expect(allModels(first.details)).toHaveLength(1);
    expect(allModels(second.details)).toHaveLength(2);
  });

  it("still reports the roster when the allowance read fails", async () => {
    const spec = buildGatewayModelsToolSpec({
      readSelection: () => ({ models: [model("kimi--k3")] }),
      readQuota: () => { throw new Error("quota route unreachable"); },
    });
    const result = await spec.execute({}, {} as never) as {
      isError: boolean;
      details: GatewayLoadout;
    };
    expect(result.isError).toBe(false);
    expect(allModels(result.details)).toHaveLength(1);
    // 조회가 실패해도 기준선과 노출 프로바이더가 모두 남고, 각자 읽지 못했음을 밝힌다.
    expect(Object.keys(result.details.providers)).toEqual(["claude", "kimi"]);
    expect(
      Object.values(result.details.providers).every((entry) => entry.quota.status === "unsupported"),
    ).toBe(true);
  });
});

// 이 텍스트는 모델이 실제로 읽는 live tool metadata다. Standing Order와 어긋나면 실무에서는
// 이쪽이 이긴다 — 실제로 "핀할 때만 호출하라"는 구 지침이 새 doctrine을 무효화한 채 남아 있었고,
// 그 모순을 잡아낸 테스트가 하나도 없었다. 여기서 고정한다.
describe("gateway_models tool doctrine", () => {
  function doctrine() {
    return buildGatewayModelsToolSpec({ readSelection: () => ({ models: [] }) });
  }

  it("requires a read before every run rather than only before pinning", () => {
    const spec = doctrine();
    expect(spec.whenToUse.join("\n")).toContain("before every run that leaves the host");
    // 구 지침은 호출 의무를 핀 여부로 한정했다. 그 한정이 돌아오면 분산 기본이 죽는다.
    expect(spec.whenToUse.join("\n")).not.toContain("before authoring a workflow that pins");
  });

  it("does not restore the inherit-shortcut that skipped the roster entirely", () => {
    const spec = doctrine();
    expect(spec.whenNotToUse.join("\n")).not.toContain("when every stage will inherit the session model");
  });

  it("ranks quality by benchmark evidence first, class as the unmeasured prior, never the session model", () => {
    const guidelines = doctrine().usageGuidelines.join("\n");
    // 품질 축이 allowance 로 무너지던 것이 실측된 실패다: 판단 스테이지(propose)에 품질
    // 신호가 없어 아키텍처 제안석이 light 모델로 균등 분배됐다. 이제 측정(benchmark)이
    // 먼저 품질을 답하고, class 는 측정이 없는 곳의 prior 로만 남으며, providerPriority 는
    // allowance 축 전용이다. 어느 질문도 세션 모델로 돌아가지 않는다.
    expect(guidelines).toContain("the quality prior where no benchmark figures exist");
    expect(guidelines).toContain("Quality reads benchmark first");
    expect(guidelines).toContain("judgment seats keep to the top reachable band");
    // 소스 간 점수 비교를 허용하면 공급자 간 class 비교와 같은 오류가 벤치 차원에서
    // 재현된다 — 카탈로그는 단일 소스가 정책이고, 미측정 모델은 class 로만 판정한다.
    expect(guidelines).toContain("The catalog carries one benchmark source deliberately");
    expect(guidelines).toContain("judged by its capability class alone");
    expect(guidelines).toContain("neither quality nor allowance ever falls back to this session's own model");
    // 구 문언이 되살아나면 공급자 주장(class)이 다시 공급자 간 품질 통화가 된다.
    expect(guidelines).not.toContain("the roster's only quality signal");
    expect(guidelines).not.toContain("judgment seats keep to the highest reachable class");
    expect(guidelines).not.toContain("the choice falls to allowance");
    expect(guidelines).not.toContain("it is not a reason to pin");
    // 폐기된 측정 테이블 어휘가 도구 문언에 되살아나면 품질 신호가 두 벌이 된다.
    expect(guidelines).not.toContain("roleFit");
    expect(guidelines).not.toContain("role fit");
  });

  // 우선순위는 사용자 옵트인 소진 순서다. 예보(pressure)가 그것을 뒤집으면 옵트인이
  // 무력화되고, 품질 밴드를 넘으면 판단석이 할당량 축으로 떨어진다.
  it("carries the user's provider spend priority as an allowance-axis order only", () => {
    const guidelines = doctrine().usageGuidelines.join("\n");
    expect(guidelines).toContain("providerPriority is the user's standing spend order");
    expect(guidelines).toContain("the pressure forecast included");
    expect(guidelines).toContain("leave one only on observed failure");
    expect(guidelines).toContain("never lift an identity across a quality band");
  });

  // claude 항목이 로스터 모델을 하나도 서빙하지 않는다는 사실과, 미핀 실행이 항상 claude 를
  // 쓴다는 주장은 다르다. 세션이 게이트웨이 기본 모델로 기동되면 후자는 거짓이 된다 —
  // 도구 지침이 그 보편 주장을 유지하면 스킬이 고쳐도 호스트는 이쪽을 읽는다.
  it("does not claim the claude entry is always what an unpinned run spends", () => {
    const guidelines = doctrine().usageGuidelines.join("\n");
    expect(guidelines).toContain("a session launched on a gateway default instead spends the entry that serves that model");
    expect(guidelines).not.toContain("it is what an unpinned run spends, and the baseline an offload is measured against");
  });

  // buildProviders 는 claude 를 항상 목록에 넣고 스냅샷이 준 창을 그대로 enrich 한다
  // (터미널 쿼터 어댑터도 providers.claude.windows 를 실어 나른다). "보고되지 않는다"고
  // 쓰면 호스트가 실제로 읽히는 parent pressure 를 무시한 채 안전하다고 판단한다.
  it("does not tell the host the parent allowance goes unreported", () => {
    const guidelines = doctrine().usageGuidelines.join("\n");
    expect(guidelines).toContain("Every entry reports its allowance, the parent subscription included");
    expect(guidelines).toContain("an allowance you can read and never select");
    expect(guidelines).not.toContain("spends an allowance no window here reports");
  });

  // homolineage 는 upstream 모델 id 가 "claude"로 시작하는지만 본다. 세션을 참조하지
  // 않으므로 "이 세션의 계열"로 서술하면 비-Claude 기본으로 기동된 세션에서 거짓이 된다.
  it("describes homolineage as a model-derived Claude-family flag, not a session-relative one", () => {
    const guidelines = doctrine().usageGuidelines.join("\n");
    expect(guidelines).toContain("derived from its id alone and silent about what this session runs on");
    expect(guidelines).not.toContain("the blind spots an identity inherits from this session's lineage");
  });

  it("keeps the scope-matching rule tied to a declared quotaScope", () => {
    // quotaScope는 Cursor만 선언한다. 이 문장이 전 프로바이더 규칙으로 읽히면
    // codex/kimi/claude는 읽을 창이 없어진다 — 조건절이 규칙의 본체다.
    expect(doctrine().usageGuidelines.join("\n")).toContain("Where a provider splits into pools");
  });

  it("keeps the two spellings distinct and the name the preferred selector", () => {
    // 이 두 문장이 사라지면 호스트는 이름을 요구하는 자리에 modelId를 넣는 실패로
    // 되돌아간다. 그것이 이 로스터에 agentTypes가 생긴 이유다.
    const guidelines = doctrine().usageGuidelines.join("\n");
    expect(guidelines).toContain("Two spellings, never interchangeable");
    expect(guidelines).toContain("Prefer a name");
    // modelId를 기본 경로로 되돌리면 사용자가 꺼둔 모델이 오류 없이 실행된다.
    expect(guidelines).toContain("including a model the user turned off");
  });
});
