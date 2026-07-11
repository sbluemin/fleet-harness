import { describe, expect, it, vi } from "vitest";

import { createRegistryChecker } from "../src/runtime/registry-check.js";

function setup(state = '{"skipped":[],"notified":[]}') {
  const fileSystem = { readFile: vi.fn(async () => state), writeFile: vi.fn(async () => undefined) };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: "2.0.0" } }) }));
  const setInterval = vi.fn(() => 42 as never);
  const clearInterval = vi.fn();
  return { checker: createRegistryChecker({ packageName: "@dotobokuri/fleet-console", statePath: "/runtime/registry-state.json", dependencies: { fileSystem, fetch, setInterval, clearInterval } }), fileSystem, fetch, setInterval, clearInterval };
}

describe("registry checker", () => {
  it("uses an injected network request, persists the once-per-version notification gate, and honors skip", async () => {
    const { checker, fileSystem, fetch } = setup();
    await expect(checker.check("1.0.0")).resolves.toEqual({ latest: "2.0.0", shouldNotify: true });
    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/%40dotobokuri%2Ffleet-console", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fileSystem.writeFile).toHaveBeenCalledWith("/runtime/registry-state.json", "{\"skipped\":[],\"notified\":[\"2.0.0\"]}");
    await checker.skip("2.0.0");
    expect(fileSystem.writeFile).toHaveBeenLastCalledWith("/runtime/registry-state.json", "{\"skipped\":[\"2.0.0\"],\"notified\":[]}");
  });

  it("returns offline as no update and schedules a sixty-minute poll without real network access", async () => {
    const { checker, fetch, setInterval, clearInterval } = setup();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(checker.check("1.0.0")).resolves.toEqual({ latest: null, shouldNotify: false });
    const stop = checker.startPolling(() => "1.0.0", vi.fn());
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    stop();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });
});
