import { afterEach, describe, expect, it } from "vitest";

import { addShellPanel, clearShellPanels, getActiveShellId, getShellPanels, removeShellPanel, setActiveShellPanel, setShellPanelGeometry } from "../client/src/canvas/shell-panels.js";

const GEOMETRY = { x: 10, y: 20, width: 300, height: 200, zIndex: 1 } as const;

afterEach(() => {
  clearShellPanels();
});

describe("ephemeral shell panel registry", () => {
  it("adds shell panels with shell:<seq> ids and tracks theaterId + geometry", () => {
    const id = addShellPanel("theater-a", { ...GEOMETRY });
    expect(id.startsWith("shell:")).toBe(true);
    const panels = getShellPanels();
    expect(panels[id]).toMatchObject({ theaterId: "theater-a", geometry: { ...GEOMETRY } });
    expect(panels[id]?.createdAt).toBeGreaterThan(0);
  });

  it("assigns distinct ids to concurrent shell panels", () => {
    const a = addShellPanel("t", { ...GEOMETRY });
    const b = addShellPanel("t", { ...GEOMETRY });
    expect(a).not.toBe(b);
    expect(Object.keys(getShellPanels())).toHaveLength(2);
  });

  it("updates geometry without touching theaterId", () => {
    const id = addShellPanel("theater-a", { ...GEOMETRY });
    setShellPanelGeometry(id, { ...GEOMETRY, x: 99 });
    expect(getShellPanels()[id]?.geometry.x).toBe(99);
    expect(getShellPanels()[id]?.theaterId).toBe("theater-a");
  });

  it("removes a single panel and clears all", () => {
    const id = addShellPanel("t", { ...GEOMETRY });
    addShellPanel("t", { ...GEOMETRY });
    removeShellPanel(id);
    expect(getShellPanels()[id]).toBeUndefined();
    expect(Object.keys(getShellPanels())).toHaveLength(1);
    clearShellPanels();
    expect(Object.keys(getShellPanels())).toHaveLength(0);
  });
});

describe("active shell highlight", () => {
  afterEach(() => {
    clearShellPanels();
  });

  it("tracks the active shell id and is null by default", () => {
    expect(getActiveShellId()).toBeNull();
    const id = addShellPanel("t", { ...GEOMETRY });
    setActiveShellPanel(id);
    expect(getActiveShellId()).toBe(id);
  });

  it("removing the active shell clears the active id", () => {
    const id = addShellPanel("t", { ...GEOMETRY });
    setActiveShellPanel(id);
    removeShellPanel(id);
    expect(getActiveShellId()).toBeNull();
  });

  it("removing a non-active shell keeps the active id", () => {
    const active = addShellPanel("t", { ...GEOMETRY });
    const other = addShellPanel("t", { ...GEOMETRY });
    setActiveShellPanel(active);
    removeShellPanel(other);
    expect(getActiveShellId()).toBe(active);
  });

  it("clearShellPanels resets the active id", () => {
    const id = addShellPanel("t", { ...GEOMETRY });
    setActiveShellPanel(id);
    clearShellPanels();
    expect(getActiveShellId()).toBeNull();
  });
});
