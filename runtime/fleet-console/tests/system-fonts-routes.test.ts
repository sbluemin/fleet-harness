import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createSystemFontsRouter } from "../core/host/system-fonts-routes.js";

interface Write {
  readonly status: number;
  readonly body: unknown;
}

const SYSTEM_FONTS_PATH = "/api/v1/settings/fonts/system";
const SAFE_FONTS = [{ family: "Noto Sans", monospace: false, uiSuitable: true }];

describe("system font route", () => {
  it("serves only the frozen GET envelope", async () => {
    const harness = createRouterHarness();
    await expect(harness.router({ req: request("GET"), res: {} as http.ServerResponse, pathname: SYSTEM_FONTS_PATH })).resolves.toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: { version: 1, fonts: SAFE_FONTS } }]);
  });

  it("rejects unsupported methods and maps enumeration errors to 503", async () => {
    const methods = createRouterHarness();
    await methods.router({ req: request("POST"), res: {} as http.ServerResponse, pathname: SYSTEM_FONTS_PATH });
    expect(methods.writes).toEqual([{ status: 405, body: { error: "Method not allowed" } }]);
    const unavailable = createRouterHarness(new Error("native helper failed"));
    await unavailable.router({ req: request("GET"), res: {} as http.ServerResponse, pathname: SYSTEM_FONTS_PATH });
    expect(unavailable.writes).toEqual([{ status: 503, body: { error: "system_fonts_unavailable" } }]);
  });

  it("falls through unrelated paths", async () => {
    const harness = createRouterHarness();
    await expect(harness.router({ req: request("GET"), res: {} as http.ServerResponse, pathname: "/api/v1/settings/fonts/other" })).resolves.toBe(false);
    expect(harness.writes).toEqual([]);
  });
});

function createRouterHarness(error?: Error) {
  const writes: Write[] = [];
  const router = createSystemFontsRouter({
    systemFonts: { getFonts: async () => { if (error) throw error; return SAFE_FONTS; } },
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
  });
  return { router, writes };
}

function request(method: string): http.IncomingMessage {
  return { method } as http.IncomingMessage;
}
