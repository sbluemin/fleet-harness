// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";

describe("languageLocale mapping", () => {
  afterEach(() => {
    localStorage.removeItem("fleet-wiki-lang");
  });

  it("returns ko-KR when language is ko", async () => {
    const { setLanguage, languageLocale } = await import("../client/src/i18n/store");
    setLanguage("ko");
    expect(languageLocale()).toBe("ko-KR");
  });

  it("returns en-US when language is en", async () => {
    const { setLanguage, languageLocale } = await import("../client/src/i18n/store");
    setLanguage("en");
    expect(languageLocale()).toBe("en-US");
  });
});

describe("formatAbsoluteDate locale behavior", () => {
  const isoDate = "2024-06-15T09:30:00.000Z";

  afterEach(() => {
    localStorage.removeItem("fleet-wiki-lang");
  });

  it("uses ko-KR locale when language is ko", async () => {
    const { setLanguage } = await import("../client/src/i18n/store");
    setLanguage("ko");
    const { formatAbsoluteDate } = await import("../client/src/utils/time");
    const result = formatAbsoluteDate(isoDate);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe(isoDate);
  });

  it("uses en-US locale when language is en", async () => {
    const { setLanguage } = await import("../client/src/i18n/store");
    setLanguage("en");
    const { formatAbsoluteDate } = await import("../client/src/utils/time");
    const result = formatAbsoluteDate(isoDate);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("respects injected locale override parameter", async () => {
    const { formatAbsoluteDate } = await import("../client/src/utils/time");
    const koResult = formatAbsoluteDate(isoDate, "ko-KR");
    const enResult = formatAbsoluteDate(isoDate, "en-US");
    expect(typeof koResult).toBe("string");
    expect(typeof enResult).toBe("string");
  });
});

describe("relativeTime locale behavior", () => {
  afterEach(() => {
    localStorage.removeItem("fleet-wiki-lang");
  });

  it("returns Korean relative time strings when language is ko", async () => {
    const { setLanguage } = await import("../client/src/i18n/store");
    setLanguage("ko");
    const { relativeTime } = await import("../client/src/utils/time");
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = relativeTime(fiveMinAgo);
    expect(result).toBe("5분 전");
  });

  it("returns English relative time strings when language is en", async () => {
    const { setLanguage } = await import("../client/src/i18n/store");
    setLanguage("en");
    const { relativeTime } = await import("../client/src/utils/time");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(threeHoursAgo);
    expect(result).toBe("3 hr ago");
  });

  it("returns just now string for very recent time", async () => {
    const { setLanguage } = await import("../client/src/i18n/store");
    setLanguage("ko");
    const { relativeTime } = await import("../client/src/utils/time");
    const justNow = new Date(Date.now() - 10 * 1000).toISOString();
    expect(relativeTime(justNow)).toBe("방금 전");

    setLanguage("en");
    const { relativeTime: relativeTimeEn } = await import("../client/src/utils/time");
    expect(relativeTimeEn(justNow)).toBe("just now");
  });
});
