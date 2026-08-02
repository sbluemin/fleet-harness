import { describe, expect, it } from "vitest";
import type { OperationCatalogPlugin, OperationNode } from "@fleet-console/sdk/operations";

import { resolveOperationLaunchKind } from "../core/client/src/sidebar/interaction.js";

const CATALOG: readonly OperationCatalogPlugin[] = [
  {
    id: "terminal",
    title: "Terminal",
    kinds: [
      { id: "claude", type: "agent", title: "Claude" },
      { id: "codex", type: "agent", title: "Codex" },
      { id: "shell", type: "shell", title: "Shell" },
    ],
  },
];

describe("resolveOperationLaunchKind", () => {
  it("matches Claude agent operations by launchKindId", () => {
    expect(resolveOperationLaunchKind(CATALOG, operation({ type: "agent", launchKindId: "claude" }))?.id).toBe("claude");
  });

  it("matches Codex agent operations by launchKindId", () => {
    expect(resolveOperationLaunchKind(CATALOG, operation({ type: "agent", launchKindId: "codex" }))?.id).toBe("codex");
  });

  it("returns null when launchKindId is absent and multiple kinds share the operation type", () => {
    expect(resolveOperationLaunchKind(CATALOG, operation({ type: "agent" }))).toBeNull();
  });

  it("returns the single matching kind when exactly one kind shares the operation type", () => {
    expect(resolveOperationLaunchKind(CATALOG, operation({ type: "shell" }))?.id).toBe("shell");
  });

  it("returns null when launchKindId does not match and multiple kinds share the operation type", () => {
    expect(resolveOperationLaunchKind(CATALOG, operation({ type: "agent", launchKindId: "openai" }))).toBeNull();
  });

  it("returns null when plugin or type does not match the catalog", () => {
    expect(resolveOperationLaunchKind(CATALOG, operation({ pluginId: "diff", type: "agent", launchKindId: "claude" }))).toBeNull();
    expect(resolveOperationLaunchKind(CATALOG, operation({ type: "not-found", launchKindId: "shell" }))).toBeNull();
  });
});

function operation(input: { readonly pluginId?: string; readonly type: string; readonly launchKindId?: string }): OperationNode {
  return {
    id: "op",
    theaterId: "theater",
    pluginId: input.pluginId ?? "terminal",
    type: input.type,
    title: "Operation",
    payload: input.launchKindId ? { launchKindId: input.launchKindId } : {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
