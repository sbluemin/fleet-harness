import { describe, expect, it } from "vitest";

import {
  buildCarrierRoster,
  createCarrierRuntime,
  getRegisteredOrder,
  PRIOR_JOBS_REQUEST_HINT,
} from "@dotobokuri/fleet-carriers";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../src/agent-cli/assets.generated.js";

// carrier-contracts 스킬은 로스터 contracts tier의 SSoT 사본이다.
// personas의 request-block 계약이 바뀌면 이 테스트가 깨지고,
// assets/skills/carrier-contracts/SKILL.md를 아래 기대 렌더로 재생성해야 한다.
describe("carrier-contracts skill asset", () => {
  function skillContent(): string {
    const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find(
      (entry) => entry.relativePath === "carrier-contracts/SKILL.md",
    );
    expect(asset).toBeDefined();
    return asset?.content ?? "";
  }

  it("is embedded in the agent CLI skill manifest", () => {
    const content = skillContent();

    expect(content).toContain("name: carrier-contracts");
    expect(content).toContain("skip reloading if already in context");
  });

  it("mirrors the live registry contracts tier verbatim", () => {
    const carrierRuntime = createCarrierRuntime();
    carrierRuntime.registerCarrierDefaults();
    const carrierIds = getRegisteredOrder(carrierRuntime.registry);
    const expected = buildCarrierRoster(carrierRuntime.registry, carrierIds, {
      heading: "## Contracts by carrier",
      tier: "contracts",
    });

    expect(skillContent()).toContain(expected);
  });

  it("carries the shared prior_jobs hint moved out of the static roster", () => {
    expect(skillContent()).toContain(`All carriers accept an optional \`<prior_jobs>\` block: ${PRIOR_JOBS_REQUEST_HINT}`);
  });
});
