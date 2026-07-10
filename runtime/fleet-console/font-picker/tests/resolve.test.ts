import { describe, expect, it, vi } from "vitest";

import { clearFontResolutionCache, fontResolves, quoteFontFamily, sanitizeFontFamilyName, withFontFallback } from "../resolve.js";

const RESOLVED_DOCUMENT = {
  createElement: () => ({
    getContext: () => ({
      font: "",
      measureText() { return { width: this.font.includes("Resolved") ? 200 : 100 }; },
    }),
  }),
} as unknown as Document;

const FALLBACK_DOCUMENT = {
  createElement: () => ({
    getContext: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length }),
    }),
  }),
} as unknown as Document;

describe("font resolution helpers", () => {
  it("quotes families and rejects empty or hostile names", () => {
    expect(quoteFontFamily('A\\B"C')).toBe('"A\\\\B\\"C"');
    expect(sanitizeFontFamilyName(" \u0000 Inter \u007f")).toBe("Inter");
    expect(withFontFallback("", "sans-serif")).toBe("sans-serif");
  });

  it("handles resolved, fallback, SSR, and unavailable canvas cases", () => {
    clearFontResolutionCache();
    expect(fontResolves("Resolved", { document: RESOLVED_DOCUMENT })).toBe(true);
    clearFontResolutionCache();
    expect(fontResolves("Fallback", { document: FALLBACK_DOCUMENT })).toBe(false);
    expect(fontResolves("", { document: FALLBACK_DOCUMENT })).toBe(false);
    expect(fontResolves("No canvas", { document: { createElement: () => ({ getContext: () => null }) } as unknown as Document })).toBe(false);
    vi.stubGlobal("document", undefined);
    expect(fontResolves("No document")).toBe(false);
    vi.unstubAllGlobals();
  });
});
