import { describe, expect, it, vi } from "vitest";

import { createReleaseChecker, selectPackagedConsoleProcurement, type ReleaseFetch } from "../src/runtime/release-check.js";

function manifest(version: string, tag = `v${version}`) {
  return { schema: 1, package: "@dotobokuri/fleet-console", version, tag, tarball: { name: `fleet-console-${version}.tgz`, size: 1, sha256: "0".repeat(64) } };
}

function setup(served: unknown, environment: Record<string, string> = {}) {
  const fetch = vi.fn<ReleaseFetch>(async () => new Response(JSON.stringify(served), { status: 200 }));
  return { checker: createReleaseChecker({ environment, dependencies: { fetch } }), fetch };
}

describe("release checker", () => {
  it("never offers a downgrade or equal version when the release lags the installed build", async () => {
    const { checker } = setup(manifest("2.0.0"));
    // 릴리스(2.0.0)가 설치본(2.1.0/2.0.0)보다 뒤처져도 설치 후보로 노출하면 매 부팅 다운그레이드가 된다.
    await expect(checker.check("2.1.0")).resolves.toEqual({ release: null });
    await expect(checker.check("2.0.0")).resolves.toEqual({ release: null });
    // 정식 릴리스는 같은 버전의 실험 빌드를 대체하고, 최초 설치는 무엇이든 받는다.
    await expect(checker.check("2.0.0-exp.3")).resolves.toMatchObject({ release: { version: "2.0.0" } });
    await expect(checker.check("")).resolves.toMatchObject({ release: { version: "2.0.0" } });
  });

  it("accepts an experiment build only when the release tag override names it", async () => {
    const experiment = manifest("2.1.0-exp.1", "console-exp-2.1.0-exp.1");
    const withoutOverride = setup(experiment);
    const withOverride = setup(experiment, { FLEET_CONSOLE_RELEASE_TAG: "console-exp-2.1.0-exp.1" });

    await expect(withoutOverride.checker.check("2.0.0")).resolves.toEqual({ release: null, unavailable: true });
    await expect(withOverride.checker.check("2.0.0")).resolves.toMatchObject({ release: { version: "2.1.0-exp.1" } });
    expect(withOverride.fetch).toHaveBeenCalledWith("https://github.com/sbluemin/fleet-harness/releases/download/console-exp-2.1.0-exp.1/fleet-console-release.json", expect.anything());
  });

  it("does not fetch or install a public Console when the release tag is source", async () => {
    const fetch = vi.fn<ReleaseFetch>(() => {
      throw new Error("public console lookup");
    });
    const checker = createReleaseChecker({ environment: { FLEET_CONSOLE_RELEASE_TAG: "source" }, dependencies: { fetch } });
    const freshHome = await checker.check("");
    const seededHome = await checker.check("1.315.0");

    expect(freshHome).toEqual({ release: null, unavailable: true });
    expect(seededHome).toEqual({ release: null, unavailable: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(selectPackagedConsoleProcurement(freshHome, null)).toEqual({ action: "refuse" });
    expect(selectPackagedConsoleProcurement(seededHome, "1.315.0")).toEqual({ action: "keep", version: "1.315.0", unavailable: true });
    expect(selectPackagedConsoleProcurement({ release: null, unavailable: true }, null).action).not.toBe("install");
  });

  it("reports an unreachable release as unavailable rather than as no update", async () => {
    const { checker, fetch } = setup(manifest("2.0.0"));
    fetch.mockRejectedValueOnce(new Error("offline"));
    // "없다"와 "못 물어봤다"가 같은 값이 되면 조달 경로가 오프라인에서 설치본을 지운다.
    await expect(checker.check("1.0.0")).resolves.toEqual({ release: null, unavailable: true });
  });
});
