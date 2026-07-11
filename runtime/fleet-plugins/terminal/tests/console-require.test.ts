import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConsolePackageRequire } from "../server/shared/console-require.js";

const consolePackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fleet-console");
const fallback = createRequire(import.meta.url);
const originalHint = process.env.FLEET_CONSOLE_PACKAGE_ROOT;

afterEach(() => {
  if (originalHint === undefined) delete process.env.FLEET_CONSOLE_PACKAGE_ROOT;
  else process.env.FLEET_CONSOLE_PACKAGE_ROOT = originalHint;
});

describe("resolveConsolePackageRequire", () => {
  it("prefers the explicit package root hint when the bundle lives outside the workspace", () => {
    // 번들 캐시가 FLEET_CONSOLE_DIR(워크스페이스 밖)로 이동하면 조상 탐색이 실패하는 지형 재현.
    process.env.FLEET_CONSOLE_PACKAGE_ROOT = consolePackageRoot;
    const resolved = resolveConsolePackageRequire("/tmp/fleet-console-external/plugin-cache/routes.mjs", fallback);
    expect(resolved).not.toBe(fallback);
    expect(resolved.resolve("ws")).toContain("ws");
  });

  it("falls back to ancestor discovery when the hint is absent or not the console package", () => {
    delete process.env.FLEET_CONSOLE_PACKAGE_ROOT;
    const inWorkspace = resolveConsolePackageRequire(path.join(consolePackageRoot, "dist", "fleet-plugins", "terminal", "routes.mjs"), fallback);
    expect(inWorkspace).not.toBe(fallback);

    process.env.FLEET_CONSOLE_PACKAGE_ROOT = "/tmp/definitely-not-a-console-package";
    const outsideWorkspace = resolveConsolePackageRequire("/tmp/fleet-console-external/plugin-cache/routes.mjs", fallback);
    expect(outsideWorkspace).toBe(fallback);
  });
});
