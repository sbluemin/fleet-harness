import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createGlobalSettingsRouter } from "../core/host/settings/settings-domain.js";
import type { ConsoleSettingsData, ConsoleGeneralSettings } from "../core/host/settings/settings-domain.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly general?: ConsoleGeneralSettings;
  readonly plugins?: ConsoleSettingsData["plugins"];
  readonly onThemeChanged?: (theme: "instrument" | "maritime" | "carbon" | "whites") => void;
}

describe("global settings routes", () => {
  it("GET /global-settings/state returns flat Console settings with defaults", async () => {
    const harness = createRouterHarness({ general: {} });
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/global" });
    expect(handled).toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: { consolePortMode: "dynamic", consoleStaticPort: null, language: "auto", seenFeatureTours: [], theme: "instrument", uiFont: { source: "builtin", id: "manrope", size: 14 } } }]);
    expect(harness.writes[0]?.body).not.toHaveProperty("version");
    expect(harness.writes[0]?.body).not.toHaveProperty("general");
  });

  it("GET /global-settings/state reflects stored values", async () => {
    const harness = createRouterHarness({ general: { consolePortMode: "static", consoleStaticPort: 9000, language: "ko", theme: "maritime", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } } });
    await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { consolePortMode: "static", consoleStaticPort: 9000, language: "ko", seenFeatureTours: [], theme: "maritime", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } } });
  });

  it("GET /global-settings/state rejects non-GET methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("POST"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("PUT /global-settings updates and returns the new state", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "static", consoleStaticPort: 8080, theme: "instrument", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 } } });
    const handled = await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(handled).toBe(true);
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "static", consoleStaticPort: 8080, language: "auto", seenFeatureTours: [], theme: "instrument", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 } } } });
    expect(harness.currentGeneral()).toMatchObject({ consolePortMode: "static", consoleStaticPort: 8080, theme: "instrument", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 } });
  });

  it("PUT /global-settings preserves every plugin setting when storing a UI font", async () => {
    const plugins = {
      terminal: { font: { family: "Cascadia Code", size: 14 } },
      "other-plugin": { collapseGroups: true },
    };
    const harness = createRouterHarness({ authorized: true, body: { uiFont: { source: "builtin", id: "source-code-pro", size: 14 } }, plugins });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.currentData()).toEqual({
      version: 1,
      general: { uiFont: { source: "builtin", id: "source-code-pro", size: 14 } },
      plugins,
    });
  });

  it("PUT /global-settings atomically replaces UI font while preserving sibling general settings", async () => {
    const plugins = { terminal: { font: { customName: "Meslo", size: 14 } } };
    const harness = createRouterHarness({
      authorized: true,
      body: { uiFont: { source: "system", familyName: "Noto Sans Mono", size: 16 } },
      general: { theme: "instrument", language: "ko", uiFont: { source: "builtin", id: "manrope", size: 14 } },
      plugins,
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.currentData()).toEqual({
      version: 1,
      general: { theme: "instrument", language: "ko", uiFont: { source: "system", familyName: "Noto Sans Mono", size: 16 } },
      plugins,
    });
  });

  it("PUT /global-settings accepts each built-in and the 12px and 18px bounds", async () => {
    for (const [id, size] of [["manrope", 12], ["jetbrains-mono", 14], ["source-code-pro", 18]] as const) {
      const harness = createRouterHarness({ authorized: true, body: { uiFont: { source: "builtin", id, size } } });
      await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
      expect(harness.currentGeneral()?.uiFont).toEqual({ source: "builtin", id, size });
    }
  });

  it("PUT /global-settings persists each supported theme", async () => {
    for (const theme of ["instrument", "maritime", "carbon", "whites"] as const) {
      const harness = createRouterHarness({ authorized: true, body: { theme } });
      await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
      expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "dynamic", consoleStaticPort: null, language: "auto", seenFeatureTours: [], theme, uiFont: { source: "builtin", id: "manrope", size: 14 } } } });
      expect(harness.currentGeneral()).toMatchObject({ theme });
    }
  });

  it("publishes a theme only after the durable settings update succeeds", async () => {
    const published: string[] = [];
    const harness = createRouterHarness({
      authorized: true,
      body: { theme: "carbon" },
      onThemeChanged: (theme) => published.push(theme),
    });

    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });

    expect(harness.currentGeneral()?.theme).toBe("carbon");
    expect(published).toEqual(["carbon"]);
  });

  it("PUT /global-settings ignores enableMetaphor body field", async () => {
    const harness = createRouterHarness({
      authorized: true,
      body: { enableMetaphor: true },
      general: { consolePortMode: "static", consoleStaticPort: 8080, language: "en", theme: "instrument", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } },
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.body).toEqual({ state: { consolePortMode: "static", consoleStaticPort: 8080, language: "en", seenFeatureTours: [], theme: "instrument", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } } });
    expect(harness.currentGeneral()).toEqual({ consolePortMode: "static", consoleStaticPort: 8080, language: "en", theme: "instrument", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } });
  });

  it("PUT /global-settings rejects unauthorized requests with 401", async () => {
    const harness = createRouterHarness({ authorized: false, body: { theme: "instrument" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects non-JSON content types with 415", async () => {
    const harness = createRouterHarness({ authorized: true });
    await harness.router({ req: req("PUT", "text/plain"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects a missing body with 400", async () => {
    const harness = createRouterHarness({ authorized: true, bodyNull: true });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings stores a static console port", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "static", consoleStaticPort: 8080 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "static", consoleStaticPort: 8080, language: "auto", seenFeatureTours: [], theme: "instrument", uiFont: { source: "builtin", id: "manrope", size: 14 } } } });
  });

  it("PUT /global-settings rejects an out-of-range static port with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consoleStaticPort: 80 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects an invalid console port mode with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "auto" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects an invalid theme with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { theme: "neon" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects an invalid UI font with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { uiFont: "comic-sans" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]).toEqual({ status: 400, body: { error: "invalid_ui_font" } });
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects malformed atomic UI font objects with stable 400", async () => {
    for (const uiFont of [
      { source: "builtin", id: "bad", size: 14 },
      { source: "system", familyName: "\u0000Bad", size: 14 },
      { source: "system", familyName: "Noto Sans", size: 19 },
      { source: "system", familyName: "Noto Sans", size: 12.5 },
    ]) {
      const harness = createRouterHarness({ authorized: true, body: { uiFont } });
      await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
      expect(harness.writes[0]).toEqual({ status: 400, body: { error: "invalid_ui_font" } });
      expect(harness.updateCalls).toBe(0);
    }
  });

  it("PUT /global-settings stores language and preserves sibling general and plugin settings", async () => {
    const harness = createRouterHarness({ authorized: true, body: { language: "ko" }, general: { consolePortMode: "static", consoleStaticPort: 8080, theme: "instrument" }, plugins: { terminal: { fontSize: 14 } } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "static", consoleStaticPort: 8080, language: "ko", seenFeatureTours: [], theme: "instrument", uiFont: { source: "builtin", id: "manrope", size: 14 } } } });
    expect(harness.currentData()).toEqual({ version: 1, general: { consolePortMode: "static", consoleStaticPort: 8080, language: "ko", theme: "instrument" }, plugins: { terminal: { fontSize: 14 } } });
  });

  it("PUT /global-settings rejects an invalid language with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { language: "fr" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.body).toEqual({ error: "invalid_language" });
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings stores seen Feature Tour keys through the global settings path", async () => {
    const harness = createRouterHarness({
      authorized: true,
      body: { seenFeatureTours: ["example.spotlight", "example.walkthrough"] },
      general: { language: "ko" },
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });

    expect(harness.currentGeneral()?.seenFeatureTours).toEqual(["example.spotlight", "example.walkthrough"]);
    expect(harness.writes[0]?.body).toMatchObject({
      state: { seenFeatureTours: ["example.spotlight", "example.walkthrough"] },
    });
  });

  it("PUT /global-settings rejects malformed Feature Tour keys", async () => {
    const harness = createRouterHarness({ authorized: true, body: { seenFeatureTours: ["ok", 3] } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });

    expect(harness.writes[0]?.body).toEqual({ error: "invalid_seen_feature_tours" });
    expect(harness.updateCalls).toBe(0);
  });

  it("/api/v1/settings/global rejects non-GET/PUT methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("DELETE"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("returns false for unknown paths so the host can fall through", async () => {
    const harness = createRouterHarness();
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/global/unknown" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
  });
});

function createRouterHarness(options: RouterHarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  let data: ConsoleSettingsData = { version: 1, general: options.general ?? {}, plugins: options.plugins ?? {} };
  let updateCalls = 0;
  const router = createGlobalSettingsRouter({
    consoleSettingsStore: {
      path: "/fake/settings.json",
      load: () => data,
      save: (next) => { data = next; },
      update: (mutate) => { updateCalls += 1; data = mutate(data); return data; },
    },
    isAuthorized: () => options.authorized ?? true,
    onThemeChanged: options.onThemeChanged,
    readJsonBody: async () => (options.bodyNull ? null : (options.body ?? {})) as never,
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
  });
  return { router, writes, currentData: () => data, currentGeneral: () => data.general, get updateCalls() { return updateCalls; } };
}

function req(method: string, contentType?: string): http.IncomingMessage {
  return { method, headers: contentType ? { "content-type": contentType } : {} } as unknown as http.IncomingMessage;
}

function jsonReq(method: string): http.IncomingMessage {
  return req(method, "application/json");
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}
