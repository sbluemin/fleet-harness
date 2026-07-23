import { describe, expect, it } from "vitest";

import { resolveConsoleLanguage, resolveReleaseNotesLocale } from "../core/client/src/whatsnew-i18n.js";

describe("What's New release-notes locale resolution", () => {
  it("resolves explicit preferences without consulting browser language", () => {
    expect(resolveReleaseNotesLocale("en", "ko-KR")).toBe("en");
    expect(resolveReleaseNotesLocale("ko", "en-US")).toBe("ko");
  });

  it("resolves auto only for exact Korean and Korean regional browser languages", () => {
    expect(resolveReleaseNotesLocale("auto", "ko")).toBe("ko");
    expect(resolveReleaseNotesLocale("auto", "ko-KR")).toBe("ko");
    expect(resolveReleaseNotesLocale("auto", "en-US")).toBe("en");
    expect(resolveReleaseNotesLocale("auto", "")).toBe("en");
  });

  it("shares the same resolver with plugin operation context language", () => {
    expect(resolveConsoleLanguage("auto", "ko-KR")).toBe("ko");
    expect(resolveConsoleLanguage("auto", "ja-JP")).toBe("en");
  });
});
