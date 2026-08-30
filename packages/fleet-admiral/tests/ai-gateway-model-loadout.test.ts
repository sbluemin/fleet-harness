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
    const exposed = [model("cursor--grok-4.5"), model("opencode--deepseek-v4-pro")];
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
  it("does not expose static Ledger pricing through gateway_models", () => {
    const loadout = buildGatewayLoadout({ exposed: [model("codex--gpt-5.6-sol")] });
    expect(model("codex--gpt-5.6-sol")).not.toHaveProperty("pricing");
    expect(JSON.stringify(loadout)).not.toContain("pricing");
    expect(JSON.stringify(loadout)).not.toContain("inputCostPerToken");
  });

  it("carries no per-model measurement table alongside the class prior", () => {
    // roleFit 측정 테이블은 capabilityClass 로 대체·폐기됐다. 로스터에 되살아나면
    // 품질 어휘가 두 벌이 되어, 판단석 배정이 어느 축을 읽을지 갈라진다.
    const loadout = buildGatewayLoadout({ exposed: [model("codex--gpt-5.6-sol")] });
    expect(JSON.stringify(loadout)).not.toContain("roleFit");
  });

});

describe("gateway loadout", () => {
  it("reports only the exposed models", () => {
    const exposed = [model("kimi--k3"), model("cursor--grok-4.5-fast")];
    const loadout = buildGatewayLoadout({ exposed });
    expect(allModels(loadout)).toHaveLength(2);
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
    const requoted = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: { kimi: { status: "ok", windows: [{ id: "cycle", usedPercent: 47 }] } },
    });
    expect(one.revision).not.toBe(two.revision);
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
  it("is available to gateway sessions that can route its ids", () => {
    expect(isHostSessionToolAllowed(GATEWAY_MODELS_TOOL_ID)).toBe(true);
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

  // 호스트가 직접 읽는 도구다. 응답은 로스터 JSON 하나이며 훅 봉투를 두르지 않는다.
  it("returns the roster as a plain reading", async () => {
    const spec = buildGatewayModelsToolSpec({
      readSelection: () => ({ models: [model("cursor--grok-4.5-fast")] }),
    });
    const result = await spec.execute({}, {} as never) as {
      content: readonly { readonly text: string }[];
      details: GatewayLoadout;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0]!.text) as GatewayLoadout;
    expect(parsed).toEqual(result.details);
    expect(result.content[0]!.text).toContain("claude-gateway--cursor--grok-4.5-fast");
    expect(result.content[0]!.text).toContain("fleet:cursor-grok-4-5-fast");
    expect(result.content[0]!.text).not.toContain("hookSpecificOutput");
  });
});

// 이 도구에서 모델에 실제로 도달하는 텍스트는 description 하나다 — core-agent의 specToMcpTool이
// MCP 도구로 내보내는 필드가 그것뿐이다. 예전에는 그 사실을 모른 채 판정 규칙 수천 자가
// whenToUse·usageGuidelines에 쌓여 있었고, 그 문장들은 한 번도 모델에 실린 적이 없다.
// 여기서는 틀리면 조용히 실패하는 두 규칙이 실제로 나가는 필드에 있는지만 고정한다.
describe("gateway_models tool doctrine", () => {
  function doctrine() {
    return buildGatewayModelsToolSpec({ readSelection: () => ({ models: [] }) });
  }

  it("carries the two failure-loud rules in the field MCP actually serves", () => {
    const { description } = doctrine();
    // 이름 자리에 modelId를 넣으면 전 분기가 시작 즉시 죽는다. 그 실패가 이 로스터에
    // agentTypes가 생긴 이유이므로, 두 철자의 구분은 반드시 description에 있어야 한다.
    expect(description).toContain("Two spellings, never interchangeable");
    expect(description).toContain("subagent_type");
    expect(description).toContain("opts.agentType");
    expect(description).toContain("opts.model");
    // 게이트 퇴역과 함께 agentTypes는 두 디스패치 표면을 모두 섬긴다 — 옛 "상대 자리에서
    // 거부된다" 서술이 되살아나면 로스터가 delegation 스킬 정책과 모순된다.
    expect(description).not.toContain("refused where the other belongs");
    // 세션 중 노출한 모델은 이름이 해석되지 않는다. 이것을 모르면 stale roster를 의심하며
    // 같은 실패를 반복한다.
    expect(description).toContain("registered once at session start");
  });

  it("states the roster is resolved at call time rather than remembered", () => {
    expect(doctrine().description).toContain("resolved at call time rather than remembered");
  });

  // 판정 규칙이 이 필드들로 돌아가면 그 문장은 다시 아무에게도 도달하지 않은 채 유지비만 낸다.
  it("keeps the fields MCP does not serve empty", () => {
    const spec = doctrine();
    expect(spec.whenToUse).toEqual([]);
    expect(spec.whenNotToUse).toEqual([]);
    expect(spec.usageGuidelines).toEqual([]);
  });
});
