import { describe, expect, it } from "vitest";

import {
  launchProviderFromGroupId,
  launchProviderFromKindId,
  launchProviderFromModelId,
} from "../core/client/src/components/launch-provider-glyphs.js";

describe("launchProviderFromKindId", () => {
  it("tints the Agent CLI kinds the Console ships", () => {
    expect(launchProviderFromKindId("claude-gateway")).toBe("claude");
  });

  it("leaves every other launch kind neutral", () => {
    // 실행 종류 id는 플러그인이 자유롭게 짓는 문자열이다. 앞 토막을 공급자로 읽으면
    // 외부 플러그인의 claude-report·codex-review가 자기 것이 아닌 공급자 색을 얻는다 —
    // 아는 Agent CLI id만 칠하고 모르는 어휘는 중립으로 남겨 잘못된 신원을 주장하지 않는다.
    for (const kindId of ["claude-report", "codex-review", "cursor-board", "kimi-notes", "opencode-panel"]) {
      expect(launchProviderFromKindId(kindId), kindId).toBeNull();
    }
    for (const kindId of ["shell", "notes", "agent", "", null, undefined]) {
      expect(launchProviderFromKindId(kindId), String(kindId)).toBeNull();
    }
  });
});

describe("launch menu provider resolvers", () => {
  it("keeps resolving the launch-menu band groups", () => {
    expect(launchProviderFromGroupId("native")).toBe("claude");
    expect(launchProviderFromGroupId("gateway:cursor")).toBe("cursor");
    expect(launchProviderFromGroupId("gateway:nope")).toBeNull();
    expect(launchProviderFromGroupId("cursor")).toBeNull();
  });

  it("keeps resolving selected model ids", () => {
    expect(launchProviderFromModelId("fable")).toBe("claude");
    expect(launchProviderFromModelId("cursor--grok-4.5")).toBe("cursor");
    expect(launchProviderFromModelId("nope--x")).toBeNull();
    expect(launchProviderFromModelId(null)).toBeNull();
  });
});
