import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDesktopState } from "../src/desktop-state.js";
import { resolveInitialWindow } from "../src/window-state.js";

const primary = { x: 0, y: 25, width: 1920, height: 1055 };

describe("desktop state", () => {
  const roots: string[] = [];
  const statePath = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-state-"));
    roots.push(root);
    return path.join(root, "desktop-state.json");
  };
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it("keeps zoom and window together in one file and survives a corrupt half", () => {
    const file = statePath();
    const state = createDesktopState(file);
    state.zoom.save(1.5);
    state.window.save({ x: 10, y: 20, width: 1200, height: 800, maximized: true });
    state.zoom.save(-1);
    expect(createDesktopState(file).zoom.load()).toBe(-1);
    expect(createDesktopState(file).window.load()).toEqual({ x: 10, y: 20, width: 1200, height: 800, maximized: true });

    fs.writeFileSync(file, JSON.stringify({ zoomLevel: 2, window: { x: "left", width: 1 } }));
    expect(state.zoom.load()).toBe(2);
    expect(state.window.load()).toBeNull();
    fs.writeFileSync(file, "{broken");
    expect(state.zoom.load()).toBe(0);
    expect(state.window.load()).toBeNull();
  });

  it("never throws when the state directory cannot be written", () => {
    const blocker = statePath();
    fs.writeFileSync(blocker, "file");
    const state = createDesktopState(path.join(blocker, "nested", "desktop-state.json"));
    expect(() => state.window.save({ x: 0, y: 0, width: 1000, height: 700, maximized: false })).not.toThrow();
    expect(state.window.load()).toBeNull();
  });
});

describe("initial window", () => {
  it("opens centered at 1440x900, shrinking inside 90% of a small work area", () => {
    expect(resolveInitialWindow(null, [primary], primary).bounds).toEqual({ x: 240, y: 103, width: 1440, height: 900 });
    const small = { x: 0, y: 0, width: 1280, height: 720 };
    expect(resolveInitialWindow(null, [small], small).bounds).toEqual({ x: 64, y: 36, width: 1152, height: 648 });
  });

  it("restores a saved window that is still on a monitor and discards one that is not", () => {
    const saved = { x: 100, y: 120, width: 1000, height: 700, maximized: true };
    expect(resolveInitialWindow(saved, [primary], primary)).toEqual({ bounds: { x: 100, y: 120, width: 1000, height: 700 }, maximized: true });
    const gone = { ...saved, x: 4000 };
    expect(resolveInitialWindow(gone, [primary], primary)).toEqual({ bounds: { x: 240, y: 103, width: 1440, height: 900 }, maximized: false });
  });
});
