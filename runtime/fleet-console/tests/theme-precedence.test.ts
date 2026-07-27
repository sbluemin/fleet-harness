// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { readServerInjectedTheme } from "../core/client/src/store.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-source");
});

describe("Console theme precedence", () => {
  it("accepts a valid server-injected theme", () => {
    document.documentElement.setAttribute("data-theme", "daywatch");
    document.documentElement.setAttribute("data-theme-source", "server");

    expect(readServerInjectedTheme()).toBe("daywatch");
  });

  it("ignores a valid theme without the server marker", () => {
    document.documentElement.setAttribute("data-theme", "daywatch");

    expect(readServerInjectedTheme()).toBeNull();
  });

  it("ignores an unknown theme with the server marker", () => {
    document.documentElement.setAttribute("data-theme", "neon");
    document.documentElement.setAttribute("data-theme-source", "server");

    expect(readServerInjectedTheme()).toBeNull();
  });
});
