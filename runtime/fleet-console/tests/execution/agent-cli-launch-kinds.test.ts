import { exposableEffortLadder, findGatewayModel, GATEWAY_MODELS, toClaudeGatewayModelId } from "@fleet-console/ai-gateway";
import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../../features/execution/host/agent/agent-cli-launch-kinds.js";
import { buildModelRoster, createModelRosterHost } from "../../features/ai-gateway/host/model-roster.js";

describe("buildModelRoster login filter", () => {
  it("shows a signed-in provider's whole catalog and ladder, hides signed-out providers, and keeps unknown providers", () => {
    const roster = buildModelRoster("agent", {
      claude: "ok",
      codex: "signed_out",
      xai: "not_connected",
    });
    const claude = roster.find((group) => group.id === "gateway:claude");
    const claudeIds = GATEWAY_MODELS.filter((model) => model.provider === "claude").map((model) => toClaudeGatewayModelId(model)).sort();
    expect(claude?.rows.map((row) => row.launch.model).sort()).toEqual(claudeIds);
    const sonnet = findGatewayModel("claude--sonnet-1m");
    expect(sonnet).toBeDefined();
    expect(claude?.rows.find((row) => row.launch.model === "sonnet[1m]")?.effortAxis).toEqual([...(sonnet ? exposableEffortLadder(sonnet) : [])]);
    expect(roster.some((group) => group.id === "gateway:codex" || group.id === "gateway:xai")).toBe(false);
    expect(roster.some((group) => group.id === "gateway:antigravity")).toBe(true);
    expect(roster.some((group) => group.id === "gateway:muse-code")).toBe(true);

    const signedIn = buildModelRoster("launch", {
      claude: "ok",
      codex: "ok",
      xai: "ok",
      antigravity: "ok",
      "muse-code": "ok",
    });
    const sol = signedIn.find((group) => group.id === "gateway:codex")?.rows.find((row) => row.launch.model === "codex--gpt-6.1-sol");
    const solModel = findGatewayModel("codex--gpt-6.1-sol");
    expect(solModel).toBeDefined();
    const ladder = solModel ? exposableEffortLadder(solModel) : [];
    expect(sol?.effortAxis).toEqual([...ladder.filter((effort) => effort !== "max" || ladder.includes("max")), "ultra"]);
    expect(sol?.chips?.map((chip) => chip.id)).toEqual([...ladder, "ultra"]);
    expect(sol?.gatedEfforts).toEqual(ladder.includes("max") ? ["max", "ultra"] : ["ultra"]);

    expect(buildAgentCliLaunchKinds(
      [{ id: "claude", label: "Claude", available: true, signedIn: true }],
      "agent",
      { claude: "signed_out", codex: "signed_out", xai: "signed_out", antigravity: "not_connected", "muse-code": "signed_out" },
    )[0]?.variants?.map((group) => group.id)).toEqual(["roster-fallback"]);

    expect(buildModelRoster("agent").map((group) => group.id)).toEqual(buildModelRoster("agent", {}).map((group) => group.id));
    expect(createModelRosterHost({}).roster("agent").length).toBeGreaterThan(0);
  });

  it("keeps disabled reasons and does not attach variants to a disabled gateway kind", () => {
    const result = buildAgentCliLaunchKinds(
      [{ id: "claude", label: "Claude (Gateway)", available: false, signedIn: true }],
      "agent",
      { claude: "ok" },
    );
    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude (Gateway)", disabled: true, disabledReason: "Not installed" },
    ]);
  });
});
