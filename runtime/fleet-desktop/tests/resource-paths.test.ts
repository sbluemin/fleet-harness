import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopResourcePaths } from "../src/resource-paths.js";
import { resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

// resolveDesktopResourcePaths는 path.join/resolve로 호스트 네이티브 구분자를 쓴다(Windows=\, POSIX=/).
// 런타임에는 네이티브 구분자가 맞으므로, 경로 비교는 구분자에 무관하게 정규화해서 검증한다.
const posix = (value: string): string => value.split(path.sep).join("/");

describe("desktop resource paths", () => {
  it("resolves packaged code from the durable desktop runtime", () => {
    const paths = resolveDesktopResourcePaths(true, "/Applications/Fleet Console.app/Contents/Resources");
    expect(posix(paths.nodePath)).toMatch(/\.fleet\/desktop\/runtime\/node\//);
    expect(posix(paths.serviceRoot)).toMatch(/\.fleet\/desktop\/runtime\/console\/latest$/);
    expect(paths.cliPath).toBe(path.join(paths.serviceRoot, "dist", "cli.mjs"));
    // 자산은 dist 앵커(모듈 디렉터리 기준) — copy-entry-assets가 dist/assets·dist/build로 나르고, packaged에선 ASAR 내 dist가 모듈 위치다.
    expect(posix(paths.iconPath)).toMatch(/runtime\/fleet-desktop\/(src|dist)\/build\/icon\.png$/);
    expect(posix(paths.trayTemplateIconPath)).toMatch(/runtime\/fleet-desktop\/(src|dist)\/build\/trayTemplate\.png$/);
    expect(posix(paths.entryPagePath)).toMatch(/runtime\/fleet-desktop\/(src|dist)\/assets\/entry\/index\.html$/);
    expect(paths.nodePath).not.toContain("app.asar");
    expect(paths.serviceRoot).not.toContain("app.asar");
    expect(paths.serviceRoot).toBe(resolveRuntimePaths(os.homedir()).latest);
  });

  it("uses the Console distribution in development without selecting a writable resource root", () => {
    const previous = process.env.FLEET_CONSOLE_NODE_PATH;
    process.env.FLEET_CONSOLE_NODE_PATH = "/workspace/node";
    try {
      const paths = resolveDesktopResourcePaths(false);
      expect(posix(paths.serviceRoot)).toMatch(/runtime\/fleet-console$/);
      expect(posix(paths.cliPath)).toMatch(/runtime\/fleet-console\/dist\/cli\.mjs$/);
      expect(posix(paths.iconPath)).toMatch(/runtime\/fleet-desktop\/(src|dist)\/build\/icon\.png$/);
      expect(posix(paths.trayTemplateIconPath)).toMatch(/runtime\/fleet-desktop\/(src|dist)\/build\/trayTemplate\.png$/);
      expect(posix(paths.entryPagePath)).toMatch(/runtime\/fleet-desktop\/(src|dist)\/assets\/entry\/index\.html$/);
    } finally {
      if (previous === undefined) delete process.env.FLEET_CONSOLE_NODE_PATH;
      else process.env.FLEET_CONSOLE_NODE_PATH = previous;
    }
  });
});
