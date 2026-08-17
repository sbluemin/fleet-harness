import { describe, expect, it } from "vitest";

import {
  groupModelsByLaunchProvider,
  launchProviderCaption,
  launchProviderFromModelId,
  launchProviderFromOperationPayload,
} from "../core/client/src/components/launch-provider-glyphs.js";

describe("launchProviderFromOperationPayload", () => {
  it("기록된 공급자를 그대로 읽는다", () => {
    for (const provider of ["claude", "codex", "cursor", "kimi", "opencode", "xai"] as const) {
      expect(launchProviderFromOperationPayload({ launchProvider: provider })).toBe(provider);
    }
  });

  it("공급자를 기록하지 않는 Operation은 null이다", () => {
    expect(launchProviderFromOperationPayload({})).toBeNull();
    expect(launchProviderFromOperationPayload(undefined)).toBeNull();
  });

  // 어휘 밖의 값을 통과시키면 CSS 대조표에 없는 수식 클래스가 붙어 마크가 조용히 색을 잃는다.
  // 서버가 다른 어휘로 흘러가도 표면은 플러그인 아이콘으로 되돌아가야 한다.
  it("어휘 밖의 값은 통과시키지 않는다", () => {
    expect(launchProviderFromOperationPayload({ launchProvider: "gemini" })).toBeNull();
    expect(launchProviderFromOperationPayload({ launchProvider: "" })).toBeNull();
    expect(launchProviderFromOperationPayload({ launchProvider: 7 })).toBeNull();
    expect(launchProviderFromOperationPayload({ launchProvider: { id: "cursor" } })).toBeNull();
  });
});

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
