import { describe, expect, it } from "vitest";

import { clampProgress, createEntrySnapshotScript, normalizeEntrySnapshot, pushEntrySnapshot, type EntryPageSnapshot } from "../src/entry-page.js";

const DAILY: EntryPageSnapshot = {
  platform: "darwin",
  foot: "shell 1.23.0",
  dev: false,
  steps: [
    { name: "Runtime ready", sub: "node v22.23.1 · runtime/console/latest 1.25.0", state: "complete", result: "ok" },
    { name: "Checking for updates", sub: "registry.npmjs.org", state: "active", result: "up to date" },
    { name: "Starting console", sub: "dist/cli.mjs serve", state: "waiting" },
  ],
};

describe("entry page snapshots", () => {
  it("keeps the six approved journey states and J-dev renderable as passive snapshots", () => {
    const snapshots: Record<string, EntryPageSnapshot> = {
      daily: DAILY,
      update: { ...DAILY, steps: [...DAILY.steps, { name: "Updating to 1.26.0", sub: "14.2 MB · verify · atomic swap", state: "active", progress: 54 }] },
      firstrun: { ...DAILY, foot: "first launch · one-time setup", steps: [{ name: "Downloading Node runtime", sub: "v22.23.1 · darwin-arm64 · checksum", state: "active", progress: 21 }] },
      offline: { ...DAILY, steps: [{ name: "Checking for updates", sub: "registry.npmjs.org", state: "warning", result: "unreachable — skipped" }] },
      firstfail: { ...DAILY, foot: "first launch · one-time setup", steps: [{ name: "Installing Fleet Console", sub: "registry.npmjs.org", state: "failed", result: "failed — unreachable" }] },
      longrun: { ...DAILY, handoff: "→ /console/" },
      dev: { platform: "darwin", foot: "channel local · workspace checkout", dev: true, steps: [{ name: "Local build detected", sub: "runtime/fleet-console/dist · FLEET_CONSOLE_NODE_PATH", state: "complete", result: "ok" }] },
    };
    expect(Object.keys(snapshots)).toEqual(["daily", "update", "firstrun", "offline", "firstfail", "longrun", "dev"]);
    expect(createEntrySnapshotScript(snapshots.update!)).toContain('"progress":54');
    expect(createEntrySnapshotScript(snapshots.dev!)).toContain('"dev":true');
    expect(createEntrySnapshotScript(snapshots.longrun!)).toContain('"handoff":"→ /console/"');
  });

  it("clamps download progress before the entire snapshot is pushed", async () => {
    let source = "";
    const executeJavaScript = async (code: string): Promise<void> => { source = code; };
    await pushEntrySnapshot({ executeJavaScript }, { ...DAILY, steps: [{ name: "Updating", sub: "verify", state: "active", progress: 140 }] });
    expect(source).toContain('"progress":100');
    expect(normalizeEntrySnapshot({ ...DAILY, steps: [{ name: "Updating", sub: "verify", state: "active", progress: -3 }] }).steps[0]?.progress).toBe(0);
    expect(clampProgress(44)).toBe(44);
  });

  it("serializes text safely without renderer-controlled markup", () => {
    const source = createEntrySnapshotScript({ ...DAILY, foot: "</script><img src=x>", steps: [{ name: "<step>", sub: "&", state: "active" }] });
    expect(source).toContain("\\u003c/script\\u003e");
    expect(source).toContain("\\u003cstep\\u003e");
    expect(source).toContain("textContent");
    expect(source).not.toContain("innerHTML");
  });
});
