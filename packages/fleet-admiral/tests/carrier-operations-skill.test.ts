import { describe, expect, it } from "vitest";

import {
  buildCarrierRoster,
  createCarrierRuntime,
  getRegisteredOrder,
  PRIOR_JOBS_REQUEST_HINT,
} from "@dotobokuri/fleet-carriers";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../src/agent-cli/assets.generated.js";

// carrier-operations 스킬은 로스터 contracts tier의 SSoT 사본이다.
// personas의 request-block 계약이 바뀌면 이 테스트가 깨지고,
// assets/skills/carrier-operations/SKILL.md를 아래 기대 렌더로 재생성해야 한다.
describe("carrier-operations skill asset", () => {
  function skillContent(): string {
    const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find(
      (entry) => entry.relativePath === "carrier-operations/SKILL.md",
    );
    expect(asset).toBeDefined();
    return asset?.content ?? "";
  }

  it("is embedded in the agent CLI skill manifest", () => {
    const content = skillContent();

    expect(content).toContain("name: carrier-operations");
    expect(content).toContain("skip reloading if already in context");
  });

  it("contains the dispatch composition rules", () => {
    const content = skillContent();

    expect(content).toContain("## Parallel Default");
    expect(content).toContain("invoke them in parallel — one tool call per carrier, same response");
    expect(content).toContain("a recon Carrier must complete before a specialist Carrier can be selected");
    expect(content).toContain("Never split a parallel launch into sequential calls.");
    expect(content).toContain("## Dispatch Failure Handling");
    expect(content).toContain("If the intended Carrier is unavailable or carrier_dispatch rejects the requested Carrier: report to the user, await instructions. Never silently substitute.");
    expect(content).toContain("A missing-required-block rejection is self-correcting — recompose the request per the echoed contract and re-dispatch instead of escalating.");
  });

  it("mirrors the live registry contracts tier verbatim", () => {
    const carrierRuntime = createCarrierRuntime();
    carrierRuntime.registerCarrierDefaults();
    const carrierIds = getRegisteredOrder(carrierRuntime.registry);
    const expected = buildCarrierRoster(carrierRuntime.registry, carrierIds, {
      heading: "## Contracts by carrier",
      tier: "contracts",
    });

    const content = skillContent();
    const rosterStart = content.indexOf("## Contracts by carrier");

    expect(rosterStart).toBeGreaterThanOrEqual(0);
    expect(content.slice(rosterStart).trimEnd()).toBe(expected);
  });

  it("carries the shared prior_jobs hint moved out of the static roster", () => {
    expect(skillContent()).toContain(`All carriers accept an optional \`<prior_jobs>\` block: ${PRIOR_JOBS_REQUEST_HINT}`);
  });

  it("exposes Ohio's exact execution_scope contract", () => {
    expect(skillContent()).toContain("<execution_scope?> optional: Optional: for legacy plans without Execution Topology or plans marked Execution mode: Sequential, omitted or `all` executes the full plan sequentially. For Execution mode: Parallel, provide one exact Wave/Lane ID declared by the Dispatch Manifest; omitted or `all` is rejected. Never combine a full-plan invocation with scoped-lane Ohio invocation(s).");
  });
});
