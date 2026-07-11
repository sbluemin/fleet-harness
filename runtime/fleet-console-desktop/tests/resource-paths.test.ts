import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopResourcePaths } from "../src/resource-paths.js";

// resolveDesktopResourcePaths는 path.join/resolve로 호스트 네이티브 구분자를 쓴다(Windows=\, POSIX=/).
// 런타임에는 네이티브 구분자가 맞으므로, 경로 비교는 구분자에 무관하게 정규화해서 검증한다.
const posix = (value: string): string => value.split(path.sep).join("/");

describe("desktop resource paths", () => {
  it("keeps packaged Node and service resources outside asar", () => {
    const paths = resolveDesktopResourcePaths(true, "/Applications/Fleet Console.app/Contents/Resources");
    expect(posix(paths.nodePath)).toContain("/Resources/sidecar/node/");
    expect(posix(paths.serviceRoot)).toBe("/Applications/Fleet Console.app/Contents/Resources/sidecar/fleet-console");
    expect(paths.cliPath).toBe(path.join(paths.serviceRoot, "dist", "cli.mjs"));
    expect(paths.iconPath).toBe(path.join(paths.serviceRoot, "icon.png"));
    expect(paths.nodePath).not.toContain("app.asar");
    expect(paths.serviceRoot).not.toContain("app.asar");
  });

  it("uses the Console distribution in development without selecting a writable resource root", () => {
    const paths = resolveDesktopResourcePaths(false);
    expect(posix(paths.serviceRoot)).toMatch(/runtime\/fleet-console$/);
    expect(posix(paths.cliPath)).toMatch(/runtime\/fleet-console\/dist\/cli\.mjs$/);
    expect(posix(paths.iconPath)).toMatch(/runtime\/fleet-console-desktop\/build\/icon\.png$/);
  });
});
