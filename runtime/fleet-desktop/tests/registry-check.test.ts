import { describe, expect, it, vi } from "vitest";

import { createRegistryChecker } from "../src/runtime/registry-check.js";

function setup() {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: "2.0.0" } }) }));
  return { checker: createRegistryChecker({ packageName: "@dotobokuri/fleet-console", dependencies: { fetch } }), fetch };
}

describe("registry checker", () => {
  it("never offers a downgrade or equal version when the registry lags the installed build", async () => {
    const { checker } = setup();
    // registry(2.0.0)가 설치본(2.1.0/2.0.0)보다 뒤처져도 설치 후보로 노출하면 매 부팅 다운그레이드가 된다.
    await expect(checker.check("2.1.0")).resolves.toEqual({ latest: null });
    await expect(checker.check("2.0.0")).resolves.toEqual({ latest: null });
    // 최초 설치도 strict stable semver 후보만 설치 대상으로 허용한다.
    await expect(checker.check("")).resolves.toEqual({ latest: "2.0.0" });
  });

  it.each(["npm:attacker@1.0.0", "https://attacker.invalid/pkg.tgz", "^1.2.3", "1.2.3-beta.1"])("rejects non-semver first-install registry value %s", async (latest) => {
    const { checker, fetch } = setup();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ "dist-tags": { latest } }) });
    await expect(checker.check("")).resolves.toEqual({ latest: null });
  });

  it("reports an unreachable registry as unavailable rather than as no update", async () => {
    const { checker, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error("offline"));
    // "없다"와 "못 물어봤다"가 같은 값이 되면 조달 경로가 오프라인에서 설치본을 지운다.
    await expect(checker.check("1.0.0")).resolves.toEqual({ latest: null, unavailable: true });
  });
});
