import { describe, expect, it } from "vitest";

import { isConsoleOrigin, isLoopbackConsoleOrigin, isRemoteConsoleOrigin, normalizeConsoleOrigin } from "../src/console-origin.js";

describe("console origin", () => {
  it("accepts a loopback console over plaintext and a remote console over TLS", () => {
    expect(isLoopbackConsoleOrigin("http://127.0.0.1:4310")).toBe(true);
    expect(isLoopbackConsoleOrigin("http://[::1]:4310")).toBe(true);
    expect(isRemoteConsoleOrigin("https://192.168.1.20:4310")).toBe(true);
    expect(isRemoteConsoleOrigin("https://console.example")).toBe(true);
  });

  it("keeps the two kinds apart so a remote origin never passes as loopback", () => {
    expect(isLoopbackConsoleOrigin("https://192.168.1.20:4310")).toBe(false);
    expect(isRemoteConsoleOrigin("http://127.0.0.1:4310")).toBe(false);
  });

  it.each([
    ["plaintext off the loopback", "http://192.168.1.20:4310"],
    ["a loopback without a port", "http://127.0.0.1"],
    ["a path", "https://console.example/console/"],
    ["a query", "https://console.example?x=1"],
    ["a fragment", "https://console.example#t=1"],
    ["credentials", "https://user:pw@console.example"],
    ["a trailing slash that is not the origin", "https://console.example/"],
    ["a foreign scheme", "file:///tmp/console"],
    ["nonsense", "not-a-url"],
  ])("refuses %s", (_label, origin) => {
    expect(isConsoleOrigin(origin)).toBe(false);
    expect(() => normalizeConsoleOrigin(origin, "surface_specific_code")).toThrow("surface_specific_code");
  });

  it("reports the refusing surface's own code so a log says which gate closed", () => {
    expect(() => normalizeConsoleOrigin("http://evil.example", "desktop_theme_origin_invalid")).toThrow("desktop_theme_origin_invalid");
    expect(() => normalizeConsoleOrigin("http://evil.example", "desktop_fullscreen_origin_invalid")).toThrow("desktop_fullscreen_origin_invalid");
    expect(normalizeConsoleOrigin("https://192.168.1.20:4310", "unused")).toBe("https://192.168.1.20:4310");
  });
});
