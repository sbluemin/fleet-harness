import { describe, expect, it, vi } from "vitest";

import { createRegistryChecker } from "../src/runtime/registry-check.js";

function setup(state = '{"skipped":[]}') {
  const fileSystem = { readFile: vi.fn(async () => state), writeFile: vi.fn(async () => undefined) };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: "2.0.0" } }) }));
  const setInterval = vi.fn(() => 42 as never);
  const clearInterval = vi.fn();
  return { checker: createRegistryChecker({ packageName: "@dotobokuri/fleet-console", statePath: "/runtime/registry-state.json", dependencies: { fileSystem, fetch, setInterval, clearInterval } }), fileSystem, fetch, setInterval, clearInterval };
}

describe("registry checker", () => {

  it("never offers a downgrade or equal version when the registry lags the installed build", async () => {
    const { checker, fileSystem } = setup();
    // registry(2.0.0)가 설치본(2.1.0/2.0.0)보다 뒤처져도 설치 후보로 노출하면 매 부팅 다운그레이드가 된다.
    await expect(checker.check("2.1.0")).resolves.toEqual({ latest: null, shouldNotify: false });
    await expect(checker.check("2.0.0")).resolves.toEqual({ latest: null, shouldNotify: false });
    expect(fileSystem.writeFile).not.toHaveBeenCalled();
    // 최초 설치도 strict stable semver 후보만 설치 대상으로 허용한다.
    await expect(checker.check("")).resolves.toEqual({ latest: "2.0.0", shouldNotify: true });
  });

  it.each(["npm:attacker@1.0.0", "https://attacker.invalid/pkg.tgz", "^1.2.3", "1.2.3-beta.1"])("rejects non-semver first-install registry value %s", async (latest) => {
    const { checker, fetch } = setup();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ "dist-tags": { latest } }) });
    await expect(checker.check("")).resolves.toEqual({ latest: null, shouldNotify: false });
  });

  it("returns offline as no update and schedules a sixty-minute poll without real network access", async () => {
    const { checker, fetch, setInterval, clearInterval } = setup();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(checker.check("1.0.0")).resolves.toEqual({ latest: null, shouldNotify: false, unavailable: true });
    const stop = checker.startPolling(() => "1.0.0", vi.fn());
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    stop();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });
});
