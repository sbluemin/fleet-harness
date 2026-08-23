import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { OperationNode } from "../sdk/operations/types.js";
import type { CompanionPanelDescriptor } from "../sdk/plugin/types.js";
import { RESERVED_SHORTCUT_CODES, availableCompanionPanels, resolveCompanionShortcutToggle, usableCompanionShortcuts } from "../core/client/src/shortcuts.js";

const COMPANIONS = [
  companion("streams", true),
  companion("chat", true),
  companion("artifacts", true),
  companion("always-visible", false),
];

const OPERATION: OperationNode = {
  id: "operation-1",
  theaterId: "theater-1",
  type: "agent",
  pluginId: "terminal",
  title: "Agent",
  payload: { companionClass: "supported" },
  geometry: null,
  ts: { createdAt: 1, updatedAt: 1 },
};

describe("companion panel availability", () => {
  it("keeps a descriptor that omits available", () => {
    const descriptor = companion("always", true);

    expect(availableCompanionPanels([descriptor], OPERATION)).toEqual([descriptor]);
  });

  it("drops unavailable descriptors and keeps available descriptors", () => {
    const unavailable = { ...companion("unavailable", true), available: () => false };
    const available = { ...companion("available", true), available: () => true };

    expect(availableCompanionPanels([unavailable, available], OPERATION)).toEqual([available]);
  });

  it("passes the OperationNode to the predicate", () => {
    const gatewayOnly = {
      ...companion("gateway-only", true),
      available: (operation: OperationNode) => operation.payload.companionClass === "supported",
    };

    expect(availableCompanionPanels([gatewayOnly], OPERATION)).toEqual([gatewayOnly]);
    expect(availableCompanionPanels([gatewayOnly], {
      ...OPERATION,
      payload: { companionClass: "unsupported" },
    })).toEqual([]);
  });

  it("withholds an unavailable panel's shortcut from dispatch and help", () => {
    const gated = { ...shortcutCompanion("gated", "KeyC"), available: () => false };
    const open = shortcutCompanion("open", "KeyA");

    // 도움말과 디스패치는 같은 합성을 통과한다. 여기서 KeyC가 살아남으면 존재하지 않는 패널로
    // 향하는 단축키가 도움말에 실리고, 눌렀을 때 열 수 없는 패널을 여는 명령이 나간다.
    expect(usableCompanionShortcuts(availableCompanionPanels([gated, open], OPERATION))
      .map((entry) => entry.shortcut?.code)).toEqual(["KeyA"]);
  });

  it("does not count an unavailable panel as a remaining visible peer", () => {
    const gated = { ...companion("gated", false), available: () => false };
    const target = companion("target", false);

    // 필터를 거치지 않은 목록을 넘기면 gated가 "아직 보이는 동료"로 계산돼 layer가 열린 채 남는다.
    expect(resolveCompanionShortcutToggle({
      companions: availableCompanionPanels([gated, target], OPERATION),
      targetId: "target",
      companionsOpen: true,
      visibilityOverrides: {},
    })).toEqual({
      openLayer: false,
      closeLayer: true,
      visibilityChanges: [{ id: "target", visible: false }],
    });
  });
});

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

  it("uses the same available-then-usable shortcut list for dispatch and help collection", () => {
    const operationsSource = readFileSync(new URL("../core/client/src/pages/operations.tsx", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("../core/client/src/app.tsx", import.meta.url), "utf8");

    // 두 경로가 availability 필터를 같은 순서로 통과해야 한다. 한쪽만 거르면 존재하지 않는 패널의
    // 단축키가 도움말에만 남거나, 도움말에 없는 키가 디스패치되는 어긋남이 생긴다.
    for (const source of [operationsSource, appSource]) {
      expect(source).toContain("availableCompanionPanels(activeKind?.companions ?? [], activeOperation)");
      expect(source).toContain("usableCompanionShortcuts(activeCompanions)");
    }
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
