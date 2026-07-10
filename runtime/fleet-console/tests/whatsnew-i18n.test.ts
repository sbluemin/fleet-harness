import { describe, expect, it } from "vitest";

import { getWhatsNewSectionLabel, resolveReleaseNotesLocale, WHATSNEW_COPY } from "../core/client/src/whatsnew-i18n.js";

describe("What's New localization", () => {
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

  it("maps display labels while preserving an unknown raw heading", () => {
    expect(getWhatsNewSectionLabel("ko", "Breaking Changes")).toBe("호환성 변경");
    expect(getWhatsNewSectionLabel("ko", "Future heading")).toBe("Future heading");
    expect(WHATSNEW_COPY.en.sections.Added).toBe("Added");
  });
});
