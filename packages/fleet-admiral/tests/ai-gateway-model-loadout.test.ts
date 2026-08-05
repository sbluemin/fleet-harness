import {
  CURSOR_SUBSCRIPTION_MODELS,
  GATEWAY_MODELS,
  findGatewayModel,
  gatewayModelIdentity,
  type GatewayModel,
} from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { buildGatewayCustomAgents } from "../src/agent-cli/gateway-agents.js";
import { buildGatewayModelsToolSpec, GATEWAY_MODELS_TOOL_ID } from "../src/ai-gateway/gateway-models-tool.js";
import { buildGatewayLoadout, type GatewayLoadout } from "../src/ai-gateway/model-loadout.js";
import { declaredRoleFitIdentities, gatewayRoleFit } from "../src/ai-gateway/role-fit.js";
import { isHostSessionToolAllowed } from "../src/tools.js";

function allModels(loadout: ReturnType<typeof buildGatewayLoadout>) {
  return Object.values(loadout.providers).flatMap((provider) => provider.models);
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
    const registered = new Set(Object.keys(buildGatewayCustomAgents(exposed)));
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
    const registered = new Set(Object.keys(buildGatewayCustomAgents([kimi], effortExposure)));
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

describe("gateway role fit declarations", () => {
  it("names only identities the catalog still contains", () => {
    // roleFit은 카탈로그와 별도 파일에 산다. 모델이 사라지거나 upstream id가 바뀌면
    // 선언은 조용히 고아가 되고, 아무 모델에도 붙지 않은 채 남는다.
    const known = new Set(GATEWAY_MODELS.map((entry) => gatewayModelIdentity(entry)));
    for (const identity of declaredRoleFitIdentities()) {
      expect(known.has(identity), `orphaned role-fit identity: ${identity}`).toBe(true);
    }
  });

  it("carries re-checkable evidence and an observation date on every claim", () => {
    for (const identity of declaredRoleFitIdentities()) {
      const fit = gatewayRoleFit(identity);
      expect(fit).toBeDefined();
      for (const entry of Object.values(fit ?? {})) {
        expect(entry.evidence.length).toBeGreaterThan(24);
        expect(entry.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("reaches a model through its service-tier sibling's identity", () => {
    // codex--gpt-5.6-sol-fast는 sol과 같은 upstream이므로 sol에 대한 측정이 그대로 적용된다.
    const sol = gatewayRoleFit(gatewayModelIdentity(model("codex--gpt-5.6-sol")));
    // 선언이 사라지면 양쪽이 undefined가 되어 toEqual이 그대로 통과한다.
    // sibling 전파를 검사하려면 원본이 존재한다는 것부터 고정해야 한다.
    expect(sol).toBeDefined();
    expect(gatewayRoleFit(gatewayModelIdentity(model("codex--gpt-5.6-sol-fast")))).toEqual(sol);
  });

  it("still declares the measurements the table was written to carry", () => {
    // 위 두 검사는 declaredRoleFitIdentities()를 순회하므로 ROLE_FIT이 비면 루프가 0회 돌고
    // vacuous pass한다 — 측정을 통째로 지워도 green이었다. 표가 비지 않았음을 직접 고정한다.
    const identities = declaredRoleFitIdentities();
    expect(identities.length).toBeGreaterThan(0);
    for (const identity of identities) {
      expect(Object.keys(gatewayRoleFit(identity) ?? {}).length).toBeGreaterThan(0);
    }
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

  it("keeps an unmeasured axis null rather than implying a verdict", () => {
    const loadout = buildGatewayLoadout({ exposed: [model("cursor--grok-4.5-fast")] });
    expect(allModels(loadout)[0]?.roleFit).toBeNull();
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
  it("is withheld from classic and native sessions that cannot route its ids", () => {
    expect(isHostSessionToolAllowed(GATEWAY_MODELS_TOOL_ID, "gateway")).toBe(true);
    expect(isHostSessionToolAllowed(GATEWAY_MODELS_TOOL_ID, "classic")).toBe(false);
    expect(isHostSessionToolAllowed(GATEWAY_MODELS_TOOL_ID, "native")).toBe(false);
    expect(isHostSessionToolAllowed("carrier_dispatch", "classic")).toBe(true);
    expect(isHostSessionToolAllowed("carrier_dispatch", "gateway")).toBe(false);
    expect(isHostSessionToolAllowed("carrier_dispatch", "native")).toBe(false);
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

  it("sends an unmeasured axis to allowance instead of back to the session model", () => {
    const guidelines = doctrine().usageGuidelines.join("\n");
    expect(guidelines).toContain("unmeasured, never unsuitable");
    expect(guidelines).toContain("the choice falls to allowance");
    expect(guidelines).not.toContain("it is not a reason to pin");
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
