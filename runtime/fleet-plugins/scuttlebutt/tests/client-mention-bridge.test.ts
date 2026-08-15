import { describe, expect, it, vi } from "vitest";

import { connectScuttlebuttMentions, readScuttlebuttMentionBridge } from "../client/mention-bridge.js";

function bridgeStub(overrides: Partial<Parameters<typeof connectScuttlebuttMentions>[0]> = {}) {
  return {
    onDuty: () => ["tori"] as const,
    label: () => "토리 부관",
    locale: () => "ko" as const,
    ask: async () => {},
    ...overrides,
  };
}

describe("scuttlebutt mention bridge", () => {
  it("reports no bridge until a flock connects", () => {
    const release = connectScuttlebuttMentions(bridgeStub());
    release();
    expect(readScuttlebuttMentionBridge()).toBeNull();
  });

  it("hands the latest connection to the plugin object", () => {
    const first = bridgeStub({ label: () => "first" });
    const second = bridgeStub({ label: () => "second" });
    const releaseFirst = connectScuttlebuttMentions(first);
    const releaseSecond = connectScuttlebuttMentions(second);
    expect(readScuttlebuttMentionBridge()?.label("tori")).toBe("second");
    // 이전 연결의 해제가 살아 있는 연결을 끊어서는 안 된다 — 재마운트 순서가 뒤집히면
    // 덱이 조용히 비고, 그 원인은 어디에도 남지 않는다.
    releaseFirst();
    expect(readScuttlebuttMentionBridge()?.label("tori")).toBe("second");
    releaseSecond();
    expect(readScuttlebuttMentionBridge()).toBeNull();
  });

  it("routes an ask through the connected flock", async () => {
    const ask = vi.fn(async () => {});
    const release = connectScuttlebuttMentions(bridgeStub({ ask }));
    await readScuttlebuttMentionBridge()?.ask("tori", "why is the sea salty?");
    expect(ask).toHaveBeenCalledWith("tori", "why is the sea salty?");
    release();
  });
});
