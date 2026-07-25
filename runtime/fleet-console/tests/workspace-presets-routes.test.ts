import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOperationStore } from "../core/host/operations/store.js";
import { TheaterRegistry, type TheaterRegistration } from "../core/host/theaters.js";
import { createWorkspacePresetsRouter } from "../core/host/workspace-presets/routes.js";
import { createWorkspacePresetStore } from "../core/host/workspace-presets/store.js";

const THEATER: TheaterRegistration = {
  id: "theater",
  path: "/work/theater",
  realpath: "/work/theater",
  label: "theater",
  registeredAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
};

describe("Workspace Preset routes", () => {
  let body: unknown;
  let authorized: boolean;
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    body = null;
    authorized = true;
    harness = createHarness(
      () => body,
      () => authorized,
    );
  });

  it("supports Theater-scoped CRUD behind the existing write gate without path-bearing DTOs", async () => {
    body = { name: "Review", layout: makeLayout() };
    const created = await request("POST", "/api/v1/theaters/theater/workspace-presets");
    expect(created.status).toBe(201);
    const preset = (created.payload as { readonly workspacePreset: { readonly id: string } }).workspacePreset;
    expect(harness.persist).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(created.payload)).not.toContain(THEATER.path);
    expect(JSON.stringify(created.payload)).not.toMatch(/"(?:cwd|realpath|providerSession|transcriptPath)":/);

    const listed = await request("GET", "/api/v1/theaters/theater/workspace-presets");
    expect(listed).toMatchObject({ status: 200, payload: { workspacePresets: [{ id: preset.id, name: "Review" }] } });

    body = { name: "Implementation" };
    const renamed = await request("PATCH", `/api/v1/theaters/theater/workspace-presets/${preset.id}`);
    expect(renamed).toMatchObject({ status: 200, payload: { workspacePreset: { id: preset.id, name: "Implementation" } } });

    const deleted = await request("DELETE", `/api/v1/theaters/theater/workspace-presets/${preset.id}`);
    expect(deleted).toEqual({ status: 200, payload: { ok: true } });
    expect(harness.store.list(THEATER.id)).toEqual([]);

    authorized = false;
    body = { name: "Denied", layout: makeLayout() };
    await expect(request("POST", "/api/v1/theaters/theater/workspace-presets")).resolves.toEqual({
      status: 401,
      payload: { error: "unauthorized" },
    });
  });

  it("applies only the current Theater intersection with one persistence and reports missing ids", async () => {
    const sourceLayout = makeLayout();
    const preset = harness.store.create(THEATER.id, "Review", sourceLayout);
    harness.operations.create(makeOperation("op-a"));
    harness.operations.create(makeOperation("op-new"));
    const originalPresetGeometry = preset.layout.operationGeometries["op-a"];

    const response = await request("POST", `/api/v1/theaters/theater/workspace-presets/${preset.id}/apply`);

    expect(response).toMatchObject({
      status: 200,
      payload: {
        preset: { id: preset.id, name: "Review" },
        appliedOperationIds: ["op-a"],
        missingOperationIds: ["op-missing"],
      },
    });
    expect(harness.operations.get("op-a")?.geometry).toEqual(sourceLayout.operationGeometries["op-a"]);
    expect(harness.operations.get("op-a")?.geometry).not.toBe(originalPresetGeometry);
    expect(harness.operations.get("op-new")?.geometry).toBeNull();
    expect(harness.store.get(THEATER.id, preset.id)).toEqual(preset);
    expect(harness.persist).toHaveBeenCalledTimes(1);
  });

  async function request(method: string, pathname: string): Promise<{ readonly status: number; readonly payload: unknown }> {
    harness.writeJson.mockClear();
    await harness.router({
      req: { method } as never,
      res: {} as never,
      pathname,
    });
    const call = harness.writeJson.mock.calls.at(-1);
    if (!call) throw new Error("expected JSON response");
    return { status: call[1] as number, payload: call[2] };
  }
});

function createHarness(readBody: () => unknown, isAuthorized: () => boolean) {
  const clock = { value: 1_000 };
  const theaters = new TheaterRegistry();
  theaters.restore([THEATER]);
  const operations = createOperationStore({ now: () => clock.value });
  const store = createWorkspacePresetStore({
    now: () => clock.value++,
    randomId: () => `preset-${clock.value}`,
  });
  const persist = vi.fn();
  const writeJson = vi.fn();
  const router = createWorkspacePresetsRouter({
    store,
    operations,
    theaters,
    isAuthorized: () => isAuthorized(),
    readJsonBody: async () => readBody() as never,
    writeJson,
    persist,
  });
  return { operations, persist, router, store, writeJson };
}

function makeLayout() {
  return {
    viewport: { x: 4, y: 8, zoom: 0.75 },
    operationGeometries: {
      "op-a": { x: 10, y: 20, width: 600, height: 360, zIndex: 4 },
      "op-missing": { x: 30, y: 40, width: 500, height: 320, zIndex: 5 },
    },
    minimizedOperationIds: ["op-a"],
    rail: { activePanelId: "plans", chromeExpanded: true, panelWidth: 440 },
    sidebar: { statusAxis: "status" as const },
  };
}

function makeOperation(id: string) {
  return {
    id,
    theaterId: THEATER.id,
    type: "agent",
    pluginId: "terminal",
    title: id,
    payload: { cwd: THEATER.path },
    geometry: null,
  };
}
