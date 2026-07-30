// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { readServerInjectedTheme } from "../core/client/src/store.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-source");
  window.localStorage.clear();
});

// 첫 페인트 부트 스크립트는 플레인 JS 공개 자산이라 타입 시스템이 유니온 축소를 못 잡는다 —
// 실제 소스를 실행해 힌트 적용·퇴역값 폴백·서버 마커 우선순위를 계약으로 고정한다.
const THEME_BOOT_SOURCE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../core/client/public/theme-boot.js"),
  "utf8",
);

function runThemeBoot(): void {
  new Function(THEME_BOOT_SOURCE)();
}

describe("theme boot script", () => {
  it("applies a stored valid hint before first paint", () => {
    window.localStorage.setItem("fleet-console.theme-hint", "carbon");
    runThemeBoot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("carbon");
  });

  it("maps retired light hints to whites so first paint keeps light polarity", () => {
    for (const legacy of ["daywatch", "drydock"]) {
      document.documentElement.removeAttribute("data-theme");
      window.localStorage.setItem("fleet-console.theme-hint", legacy);
      runThemeBoot();
      expect(document.documentElement.getAttribute("data-theme")).toBe("whites");
    }
  });

  it("leaves an unknown hint unapplied", () => {
    window.localStorage.setItem("fleet-console.theme-hint", "neon");
    runThemeBoot();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("defers to the server-injected marker", () => {
    document.documentElement.setAttribute("data-theme", "instrument");
    document.documentElement.setAttribute("data-theme-source", "server");
    window.localStorage.setItem("fleet-console.theme-hint", "carbon");
    runThemeBoot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("instrument");
  });
});

describe("Console theme precedence", () => {
  it("accepts a valid server-injected theme", () => {
    document.documentElement.setAttribute("data-theme", "whites");
    document.documentElement.setAttribute("data-theme-source", "server");

    expect(readServerInjectedTheme()).toBe("whites");
  });

  it("ignores a valid theme without the server marker", () => {
    document.documentElement.setAttribute("data-theme", "whites");

    expect(readServerInjectedTheme()).toBeNull();
  });

  it("ignores a retired light theme with the server marker", () => {
    document.documentElement.setAttribute("data-theme", "daywatch");
    document.documentElement.setAttribute("data-theme-source", "server");

    expect(readServerInjectedTheme()).toBeNull();
  });

  it("ignores an unknown theme with the server marker", () => {
    document.documentElement.setAttribute("data-theme", "neon");
    document.documentElement.setAttribute("data-theme-source", "server");

    expect(readServerInjectedTheme()).toBeNull();
  });
});
