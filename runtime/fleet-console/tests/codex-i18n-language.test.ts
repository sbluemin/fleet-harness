// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { resolveInitialLanguage, buildUrlWithoutLang } from "../client/src/codex/i18n/store";

describe("resolveInitialLanguage", () => {
  it("returns ko when no hints are provided (default)", () => {
    expect(resolveInitialLanguage("", null, "")).toBe("ko");
  });

  it("localStorage ko beats navigator", () => {
    expect(resolveInitialLanguage("", "ko", "en-US")).toBe("ko");
  });

  it("localStorage en beats navigator", () => {
    expect(resolveInitialLanguage("", "en", "ko-KR")).toBe("en");
  });

  it("navigator starting with ko returns ko when no storage", () => {
    expect(resolveInitialLanguage("", null, "ko-KR")).toBe("ko");
    expect(resolveInitialLanguage("", null, "ko")).toBe("ko");
  });

  it("navigator not starting with ko returns en when no storage", () => {
    expect(resolveInitialLanguage("", null, "en-US")).toBe("en");
    expect(resolveInitialLanguage("", null, "ja-JP")).toBe("en");
    expect(resolveInitialLanguage("", null, "zh-CN")).toBe("en");
  });

  it("invalid localStorage value falls through to navigator", () => {
    expect(resolveInitialLanguage("", "fr", "ko-KR")).toBe("ko");
    expect(resolveInitialLanguage("", "invalid", "en-US")).toBe("en");
  });

  it("empty navigator with no storage returns ko (default)", () => {
    expect(resolveInitialLanguage("", null, "")).toBe("ko");
  });
});

describe("buildUrlWithoutLang", () => {
  it("removes only lang param from URL preserving path", () => {
    const result = buildUrlWithoutLang("http://localhost/entry/foo?lang=en");
    expect(result).toBe("/entry/foo");
  });

  it("preserves other query params when removing lang", () => {
    const result = buildUrlWithoutLang("http://localhost/?lang=ko&status=pending");
    expect(result).toBe("/?status=pending");
  });

  it("preserves hash when removing lang", () => {
    const result = buildUrlWithoutLang("http://localhost/entry/foo?lang=en#section");
    expect(result).toBe("/entry/foo#section");
  });

  it("preserves path when no lang param present", () => {
    const result = buildUrlWithoutLang("http://localhost/entry/foo?status=ok");
    expect(result).toBe("/entry/foo?status=ok");
  });

  it("returns href unchanged when given an invalid URL", () => {
    const result = buildUrlWithoutLang("not-a-url");
    expect(result).toBe("not-a-url");
  });

  it("handles URL with only lang param producing clean path", () => {
    const result = buildUrlWithoutLang("http://localhost/?lang=ko");
    expect(result).toBe("/");
  });
});

describe("document.documentElement.lang side effect", () => {
  afterEach(() => {
    document.documentElement.lang = "ko";
    localStorage.removeItem("fleet-wiki-lang");
  });

  it("setLanguage updates document.documentElement.lang", async () => {
    const { setLanguage } = await import("../client/src/codex/i18n/store");
    setLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    setLanguage("ko");
    expect(document.documentElement.lang).toBe("ko");
  });
});

describe("localStorage persistence", () => {
  afterEach(() => {
    localStorage.removeItem("fleet-wiki-lang");
  });

  it("setLanguage writes fleet-wiki-lang to localStorage", async () => {
    const { setLanguage } = await import("../client/src/codex/i18n/store");
    setLanguage("en");
    expect(localStorage.getItem("fleet-wiki-lang")).toBe("en");
    setLanguage("ko");
    expect(localStorage.getItem("fleet-wiki-lang")).toBe("ko");
  });
});

describe("initLanguage() URL priority and side effects", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.removeItem("fleet-wiki-lang");
    document.documentElement.lang = "ko";
    history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.resetModules();
    localStorage.removeItem("fleet-wiki-lang");
    document.documentElement.lang = "ko";
    history.replaceState(null, "", "/");
  });

  it("?lang=en sets localStorage en, updates html lang, and calls replaceState", async () => {
    history.pushState(null, "", "/?lang=en");
    const replaceStateSpy = vi.spyOn(history, "replaceState");

    const { initLanguage } = await import("../client/src/codex/i18n/store");
    initLanguage();

    expect(localStorage.getItem("fleet-wiki-lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(replaceStateSpy).toHaveBeenCalled();
    const cleanedUrl = replaceStateSpy.mock.calls[0]?.[2] as string;
    expect(cleanedUrl).not.toContain("lang=");
    replaceStateSpy.mockRestore();
  });

  it("?lang=en preserves other query params and hash when cleaning URL", async () => {
    history.pushState(null, "", "/?lang=en&status=pending#section");
    const replaceStateSpy = vi.spyOn(history, "replaceState");

    const { initLanguage } = await import("../client/src/codex/i18n/store");
    initLanguage();

    expect(replaceStateSpy).toHaveBeenCalled();
    const cleanedUrl = replaceStateSpy.mock.calls[0]?.[2] as string;
    expect(cleanedUrl).toContain("status=pending");
    expect(cleanedUrl).not.toContain("lang=");
    expect(cleanedUrl).toContain("#section");
    replaceStateSpy.mockRestore();
  });

  it("?lang=foo (invalid) falls back to navigator/storage without calling replaceState", async () => {
    history.pushState(null, "", "/?lang=foo");
    const replaceStateSpy = vi.spyOn(history, "replaceState");

    const { initLanguage } = await import("../client/src/codex/i18n/store");
    initLanguage();

    expect(replaceStateSpy).not.toHaveBeenCalled();
    replaceStateSpy.mockRestore();
  });

  it("blocked localStorage getter falls back to navigator/default without throwing", async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage blocked");
    });

    const { initLanguage } = await import("../client/src/codex/i18n/store");
    expect(() => initLanguage()).not.toThrow();
    expect(document.documentElement.lang).toMatch(/^(ko|en)$/);

    getItemSpy.mockRestore();
  });
});
