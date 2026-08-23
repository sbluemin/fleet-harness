import { describe, expect, it } from "vitest";

import {
  groupModelsByLaunchProvider,
  launchProviderCaption,
  launchProviderFromModelId,
} from "../core/client/src/components/launch-provider-glyphs.js";

describe("launchProviderFromModelId", () => {
  it("reads native aliases and launch ids", () => {
    expect(launchProviderFromModelId("sonnet")).toBe("claude");
    expect(launchProviderFromModelId("fable[1m]")).toBe("claude");
    expect(launchProviderFromModelId("codex--gpt-5.6-sol")).toBe("codex");
    expect(launchProviderFromModelId("cursor--auto")).toBe("cursor");
  });

  it("strips the Analyst gateway prefix before reading the provider", () => {
    expect(launchProviderFromModelId("claude-gateway--codex--gpt-5.6-sol")).toBe("codex");
    expect(launchProviderFromModelId("claude-gateway--xai--grok-4.6")).toBe("xai");
    expect(launchProviderFromModelId("claude-gateway--kimi--k3-1m[1m]")).toBe("kimi");
  });

  it("rejects an unknown provider segment", () => {
    expect(launchProviderFromModelId("claude-gateway--gemini--pro")).toBeNull();
    expect(launchProviderFromModelId("")).toBeNull();
    expect(launchProviderFromModelId(undefined)).toBeNull();
  });
});

describe("groupModelsByLaunchProvider", () => {
  it("bands native Claude first, then gateway providers in launch order", () => {
    const groups = groupModelsByLaunchProvider([
      { id: "sonnet" },
      { id: "claude-gateway--kimi--k3" },
      { id: "opus[1m]" },
      { id: "claude-gateway--codex--sol" },
      { id: "claude-gateway--unknown--x" },
    ]);
    expect(groups.map((group) => group.provider)).toEqual(["claude", "codex", "kimi", null]);
    expect(groups[0]?.models.map((model) => model.id)).toEqual(["sonnet", "opus[1m]"]);
    expect(launchProviderCaption("kimi")).toBe("Moonshot-Kimi");
  });
});
