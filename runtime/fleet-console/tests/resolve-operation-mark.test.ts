import { describe, expect, it } from "vitest";
import type { OperationCatalogPlugin } from "@fleet-console/sdk/operations";

import { resolveOperationMark } from "../core/client/src/operation-mark.js";
import type { OperationNode } from "../core/client/src/types.js";

const CATALOG: readonly OperationCatalogPlugin[] = [
  {
    id: "terminal",
    title: "Terminal",
    kinds: [
      { id: "claude", type: "agent", title: "Claude" },
      { id: "shell", type: "shell", title: "Shell" },
    ],
  },
];

describe("resolveOperationMark", () => {
  it("prefers the recorded provider glyph over the kind icon", () => {
    const mark = resolveOperationMark(
      operation({ type: "shell", launchProvider: "cursor" }),
      CATALOG,
      () => "kind",
    );
    expect(mark.launchProvider).toBe("cursor");
    expect(mark.icon).not.toBe("kind");
    expect(mark.icon).not.toBeNull();
  });

  it("uses the plugin kind icon when no provider is recorded", () => {
    const mark = resolveOperationMark(operation({ type: "shell" }), CATALOG, () => "kind");
    expect(mark.launchProvider).toBeNull();
    expect(mark.icon).toBe("kind");
  });

  it("returns no mark when neither provider nor kind can be resolved", () => {
    expect(resolveOperationMark(
      operation({ pluginId: "missing", type: "other" }),
      CATALOG,
      () => "kind",
    )).toEqual({ icon: null, launchProvider: null });
  });

  it("rejects a provider outside the glyph vocabulary", () => {
    const mark = resolveOperationMark(
      operation({ type: "shell", launchProvider: "gemini" }),
      CATALOG,
      () => "kind",
    );
    expect(mark.launchProvider).toBeNull();
    expect(mark.icon).toBe("kind");
  });
});

function operation(input: {
  readonly pluginId?: string;
  readonly type: string;
  readonly launchProvider?: string;
}): OperationNode {
  return {
    id: "op",
    theaterId: "theater",
    pluginId: input.pluginId ?? "terminal",
    type: input.type,
    title: "Operation",
    payload: input.launchProvider ? { launchProvider: input.launchProvider } : {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
