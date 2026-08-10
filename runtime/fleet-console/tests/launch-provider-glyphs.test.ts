import { describe, expect, it } from "vitest";

import { launchProviderFromOperationPayload } from "../core/client/src/components/launch-provider-glyphs.js";

describe("launchProviderFromOperationPayload", () => {
  it("기록된 공급자를 그대로 읽는다", () => {
    for (const provider of ["claude", "codex", "cursor", "kimi", "opencode"] as const) {
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
