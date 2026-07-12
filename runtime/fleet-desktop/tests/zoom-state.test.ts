import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_ZOOM_LEVEL, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, clampZoomLevel, createZoomState } from "../src/zoom-state.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("zoom state", () => {
  it("clamps zoom levels to the supported Desktop range", () => {
    expect(clampZoomLevel(MIN_ZOOM_LEVEL - 1)).toBe(MIN_ZOOM_LEVEL);
    expect(clampZoomLevel(MAX_ZOOM_LEVEL + 1)).toBe(MAX_ZOOM_LEVEL);
    expect(clampZoomLevel(1.5)).toBe(1.5);
    expect(clampZoomLevel(Number.NaN)).toBe(DEFAULT_ZOOM_LEVEL);
  });

  it("atomically saves a bounded zoom level and loads it again", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-zoom-state-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "desktop-state.json");
    const state = createZoomState(statePath);

    state.save(9);

    expect(fs.readFileSync(statePath, "utf8")).toBe('{"zoomLevel":3}\n');
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
    expect(state.load()).toBe(MAX_ZOOM_LEVEL);
  });

  it("falls back to the default for missing or corrupt state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-zoom-state-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "desktop-state.json");
    const state = createZoomState(statePath);

    expect(state.load()).toBe(DEFAULT_ZOOM_LEVEL);
    fs.writeFileSync(statePath, "not json", "utf8");
    expect(state.load()).toBe(DEFAULT_ZOOM_LEVEL);
    fs.writeFileSync(statePath, '{"zoomLevel":"large"}', "utf8");
    expect(state.load()).toBe(DEFAULT_ZOOM_LEVEL);
  });
});
