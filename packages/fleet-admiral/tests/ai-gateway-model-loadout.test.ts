import {
  CURSOR_SUBSCRIPTION_MODELS,
  GATEWAY_MODELS,
  findGatewayModel,
  gatewayModelIdentity,
  type GatewayModel,
} from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { buildGatewayModelsToolSpec, GATEWAY_MODELS_TOOL_ID } from "../src/ai-gateway/gateway-models-tool.js";
import { buildGatewayLoadout } from "../src/ai-gateway/model-loadout.js";
import { declaredRoleFitIdentities, gatewayRoleFit } from "../src/ai-gateway/role-fit.js";
import { isHostSessionToolAllowed } from "../src/tools.js";

function model(id: string): GatewayModel {
  const found = findGatewayModel(id);
  if (!found) throw new Error(`missing catalog model: ${id}`);
  return found;
}

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
    expect(gatewayRoleFit(gatewayModelIdentity(model("codex--gpt-5.6-sol-fast"))))
      .toEqual(gatewayRoleFit(gatewayModelIdentity(model("codex--gpt-5.6-sol"))));
  });
});

describe("gateway loadout", () => {
  it("reports only the exposed models and marks the session default", () => {
    const exposed = [model("kimi--k3"), model("cursor--grok-4.5-fast")];
    const loadout = buildGatewayLoadout({ exposed, defaultModel: exposed[0] });
    expect(loadout.models).toHaveLength(2);
    expect(loadout.models.map((entry) => entry.isSessionDefault)).toEqual([true, false]);
    // 노출하지 않은 모델은 게이트웨이가 여전히 실행하므로, 로스터에 새면
    // 사용자가 끈 선택이 오류 없이 뒤집힌다.
    const ids = loadout.models.map((entry) => entry.id);
    expect(ids.some((id) => id.includes("claude-opus-5"))).toBe(false);
  });

  it("keeps an unmeasured axis null rather than implying a verdict", () => {
    const loadout = buildGatewayLoadout({ exposed: [model("cursor--grok-4.5-fast")] });
    expect(loadout.models[0]?.roleFit).toBeNull();
  });

  it("reports an unreadable allowance as unsupported instead of omitting it", () => {
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3"), model("cursor--grok-4.5-fast")],
      quota: { cursor: { status: "ok", windows: [{ id: "cycle", scope: "auto", usedPercent: 62 }] } },
    });
    const kimi = loadout.providers.find((entry) => entry.id === "kimi");
    expect(kimi?.quota.status).toBe("unsupported");
  });

  it("keeps the parent allowance in the roster as the baseline for offloading", () => {
    const loadout = buildGatewayLoadout({
      exposed: [model("kimi--k3")],
      quota: { claude: { status: "ok", windows: [{ id: "weekly", usedPercent: 28 }] } },
    });
    // claude는 게이트웨이 모델을 제공하지 않지만, 고정하지 않은 Phase가 소모하는
    // 예산이므로 오프로드 판단의 기준선으로 남아야 한다.
    expect(loadout.providers.map((entry) => entry.id)).toContain("claude");
  });

  it("keeps the parent allowance listed even when nothing could be read at all", () => {
    // 쿼터 조회가 실패하면 claude는 노출 프로바이더가 아니어서 목록에서 통째로 빠질 수
    // 있다. 그러면 호스트는 "읽지 못했다"와 "그런 예산이 없다"를 구별하지 못한다.
    const loadout = buildGatewayLoadout({ exposed: [model("kimi--k3")] });
    const parent = loadout.providers.find((entry) => entry.id === "claude");
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
    for (const provider of settled.providers) {
      expect(Object.keys(provider)).toEqual(["id", "quota"]);
    }
    // 기본 모델이 무엇이든 프로바이더 목록 자체는 달라지지 않는다.
    const undefaulted = buildGatewayLoadout({
      exposed: [model("kimi--k3"), model("cursor--grok-4.5-fast")],
    });
    expect(settled.providers.map((entry) => entry.id))
      .toEqual(undefaulted.providers.map((entry) => entry.id));
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
      expect(loadout.models[0]?.constraints.quotaScope).toBeDefined();
    }
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
    const first = await spec.execute({}, {} as never) as { details: { models: unknown[] } };
    exposed = [model("kimi--k3"), model("cursor--grok-4.5-fast")];
    const second = await spec.execute({}, {} as never) as { details: { models: unknown[] } };
    expect(first.details.models).toHaveLength(1);
    expect(second.details.models).toHaveLength(2);
  });

  it("still reports the roster when the allowance read fails", async () => {
    const spec = buildGatewayModelsToolSpec({
      readSelection: () => ({ models: [model("kimi--k3")] }),
      readQuota: () => { throw new Error("quota route unreachable"); },
    });
    const result = await spec.execute({}, {} as never) as {
      isError: boolean;
      details: { models: unknown[]; providers: Array<{ id: string; quota: { status: string } }> };
    };
    expect(result.isError).toBe(false);
    expect(result.details.models).toHaveLength(1);
    // 조회가 실패해도 기준선과 노출 프로바이더가 모두 남고, 각자 읽지 못했음을 밝힌다.
    expect(result.details.providers.map((entry) => entry.id)).toEqual(["claude", "kimi"]);
    expect(result.details.providers.every((entry) => entry.quota.status === "unsupported")).toBe(true);
  });
});
