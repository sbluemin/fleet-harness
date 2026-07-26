import { describe, expect, it } from "vitest";

import type { CompanionPanelDescriptor } from "../sdk/plugin/types.js";
import { resolveCompanionShortcutToggle } from "../core/client/src/companion-shortcut.js";

const COMPANIONS = [
  companion("streams", true),
  companion("chat", true),
  companion("artifacts", true),
  companion("always-visible", false),
];

describe("companion shortcut toggle", () => {
  it("opens the companion layer and shows only the requested target", () => {
    expect(resolveCompanionShortcutToggle({
      companions: COMPANIONS,
      targetId: "streams",
      companionsOpen: false,
      visibilityOverrides: {},
    })).toEqual({
      openLayer: true,
      closeLayer: false,
      visibilityChanges: [{ id: "streams", visible: true }],
    });
  });

  it("shows a hidden target without reopening an already-open layer", () => {
    expect(resolveCompanionShortcutToggle({
      companions: COMPANIONS,
      targetId: "chat",
      companionsOpen: true,
      visibilityOverrides: { chat: false, streams: true },
    })).toEqual({
      openLayer: false,
      closeLayer: false,
      visibilityChanges: [{ id: "chat", visible: true }],
    });
  });

  it("closes every declared cluster member while another panel remains visible", () => {
    expect(resolveCompanionShortcutToggle({
      companions: COMPANIONS,
      targetId: "chat",
      clusterIds: ["chat", "artifacts"],
      companionsOpen: true,
      visibilityOverrides: { chat: true, artifacts: true, streams: true, "always-visible": false },
    })).toEqual({
      openLayer: false,
      closeLayer: false,
      visibilityChanges: [
        { id: "chat", visible: false },
        { id: "artifacts", visible: false },
      ],
    });
  });

  it("closes the layer when hiding the target leaves no visible companions", () => {
    expect(resolveCompanionShortcutToggle({
      companions: COMPANIONS,
      targetId: "streams",
      companionsOpen: true,
      visibilityOverrides: { streams: true, "always-visible": false },
    })).toEqual({
      openLayer: false,
      closeLayer: true,
      visibilityChanges: [{ id: "streams", visible: false }],
    });
  });
});

function companion(id: string, defaultHidden: boolean): CompanionPanelDescriptor {
  return {
    id,
    title: id,
    defaultHidden,
    render: () => null,
  };
}
