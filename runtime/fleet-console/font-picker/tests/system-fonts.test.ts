import { describe, expect, it } from "vitest";

import { fetchSystemFonts, parseSystemFontsResponse, SystemFontsFetchError } from "../system-fonts.js";

const VALID_RESPONSE = { version: 1, fonts: [{ family: "Inter", monospace: false, uiSuitable: true }] };

describe("system font response contract", () => {
  it("accepts the frozen versioned DTO", () => {
    expect(parseSystemFontsResponse(VALID_RESPONSE)).toEqual(VALID_RESPONSE);
  });

  it("rejects unknown versions and malformed records", () => {
    expect(() => parseSystemFontsResponse({ ...VALID_RESPONSE, version: 2 })).toThrow(SystemFontsFetchError);
    expect(() => parseSystemFontsResponse({ version: 1, fonts: [{ family: "Inter", monospace: "no", uiSuitable: true }] })).toThrow(SystemFontsFetchError);
    expect(() => parseSystemFontsResponse({ ...VALID_RESPONSE, extra: true })).toThrow(SystemFontsFetchError);
  });

  it("fetches the same-origin Core route and maps failed responses", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(input).toBe("/api/v1/settings/fonts/system");
      return new Response(JSON.stringify(VALID_RESPONSE), { status: 200 });
    };
    await expect(fetchSystemFonts({ fetchImpl })).resolves.toEqual(VALID_RESPONSE);
    await expect(fetchSystemFonts({ fetchImpl: async () => new Response("", { status: 503 }) })).rejects.toMatchObject({ status: 503 });
  });
});
