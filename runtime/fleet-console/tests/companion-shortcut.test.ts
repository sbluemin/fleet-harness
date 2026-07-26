import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { CompanionPanelDescriptor } from "../sdk/plugin/types.js";
import { RESERVED_SHORTCUT_CODES, resolveCompanionShortcutToggle, usableCompanionShortcuts } from "../core/client/src/companion-shortcut.js";

const COMPANIONS = [
  companion("streams", true),
  companion("chat", true),
  companion("artifacts", true),
  companion("always-visible", false),
];

describe("companion shortcut toggle", () => {
  it("keeps only declared, unreserved, first-by-code shortcuts", () => {
    const companions = [
      companion("missing", true),
      shortcutCompanion("reserved", "ArrowDown"),
      shortcutCompanion("first", "KeyC"),
      shortcutCompanion("duplicate", "KeyC"),
      shortcutCompanion("second", "KeyA"),
    ];

    expect(RESERVED_SHORTCUT_CODES).toEqual([
      "KeyF", "KeyS", "KeyT", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape",
    ]);
    expect(usableCompanionShortcuts(companions).map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("uses the same usable shortcut list for dispatch and help collection", () => {
    const operationsSource = readFileSync(new URL("../core/client/src/pages/operations.tsx", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("../core/client/src/app.tsx", import.meta.url), "utf8");

    expect(operationsSource).toContain("usableCompanionShortcuts(activeKind.companions)");
    expect(appSource).toContain("usableCompanionShortcuts(activeKind?.companions ?? [])");
  });

  it("opens the companion layer, revealing the target and leaving peers at their default visibility", () => {
    // 단축키는 패널 자체의 열기 컨트롤과 같은 결과에 이르는 두 번째 경로다. defaultHidden을 끈 패널을
    // 단축키만 강제로 숨기면 그 선언 의도를 뒤집고 두 경로의 동작이 갈린다(Codex P2 판정 근거).
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

  it("does not touch a peer that declares itself visible by default when opening", () => {
    const changed = resolveCompanionShortcutToggle({
      companions: COMPANIONS,
      targetId: "streams",
      companionsOpen: false,
      visibilityOverrides: {},
    }).visibilityChanges.map((change) => change.id);

    expect(changed).not.toContain("always-visible");
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

  it("always closes the target when the declared cluster lists only siblings", () => {
    expect(resolveCompanionShortcutToggle({
      companions: COMPANIONS,
      targetId: "chat",
      clusterIds: ["artifacts"],
      companionsOpen: true,
      visibilityOverrides: { chat: true, artifacts: true, streams: false, "always-visible": false },
    })).toEqual({
      openLayer: false,
      closeLayer: true,
      visibilityChanges: [
        { id: "chat", visible: false },
        { id: "artifacts", visible: false },
      ],
    });
  });

  it("keeps the target first and removes duplicate cluster ids", () => {
    expect(resolveCompanionShortcutToggle({
      companions: COMPANIONS,
      targetId: "chat",
      clusterIds: ["artifacts", "chat", "artifacts"],
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

function shortcutCompanion(id: string, code: string): CompanionPanelDescriptor {
  return {
    ...companion(id, true),
    shortcut: { code, label: id },
  };
}
