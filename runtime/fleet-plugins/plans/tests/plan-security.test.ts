import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handlePlansList, handlePlansRead } from "../server/handlers.js";

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

let tmpDir: string;
let theaterPath: string;

beforeAll(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "plans-sec-"));
  theaterPath = path.join(tmpDir, "theater");
  await fs.promises.mkdir(theaterPath);
});

afterAll(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe("Plans handlers — security", () => {
  it("rejects traversal-shaped plan names before Theater lookup", async () => {
    const resolveTheaterPath = vi.fn();
    const { ctx, responses } = createContext({ theaterId: "theater", name: "../secret.md" }, resolveTheaterPath);

    await handlePlansRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(responses).toEqual([{ status: 400, body: { error: "invalid_name" } }]);
    expect(resolveTheaterPath).not.toHaveBeenCalled();
  });

  it("skips an escaping symlink in the list while keeping conforming plans", async () => {
    const plansPath = path.join(theaterPath, ".fleet", "plans");
    const outsidePath = path.join(tmpDir, "outside.md");
    await fs.promises.mkdir(plansPath, { recursive: true });
    await fs.promises.writeFile(outsidePath, "# Outside");
    await fs.promises.symlink(outsidePath, path.join(plansPath, "escape.md"));
    await fs.promises.writeFile(path.join(plansPath, "good.md"), "# Good Plan\n\n- [x] done task\n- [ ] open task\n");

    const { ctx, responses } = createContext({ theaterId: "theater" }, () => theaterPath);
    await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(responses).toHaveLength(1);
    const response = responses[0] as { status: number; body: { plans: Array<{ name: string }> } };
    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan) => plan.name)).toEqual(["good.md"]);
  });

  it("returns 403 when reading a plan symlink that resolves outside its Theater", async () => {
    const { ctx, responses } = createContext({ theaterId: "theater", name: "escape.md" }, () => theaterPath);

    await handlePlansRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(responses).toEqual([{ status: 403, body: { error: "path_outside_theater" } }]);
  });

  it("lists an oversized plan without parsing its body", async () => {
    const plansPath = path.join(theaterPath, ".fleet", "plans");
    const oversizedPath = path.join(plansPath, "huge.md");
    const handle = await fs.promises.open(oversizedPath, "w");
    await handle.truncate(2 * 1024 * 1024 + 1);
    await handle.close();

    const { ctx, responses } = createContext({ theaterId: "theater" }, () => theaterPath);
    await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    const response = responses[0] as { status: number; body: { plans: Array<{ name: string; waveCount: number; tasksTotal: number; sizeBytes: number }> } };
    expect(response.status).toBe(200);
    const huge = response.body.plans.find((plan) => plan.name === "huge.md");
    expect(huge).toMatchObject({ waveCount: 0, tasksTotal: 0, sizeBytes: 2 * 1024 * 1024 + 1 });
  });

  it("excludes plan names that cannot be read through the API", async () => {
    const plansPath = path.join(theaterPath, ".fleet", "plans");
    await fs.promises.writeFile(path.join(plansPath, ".hidden.md"), "# Hidden");
    await fs.promises.writeFile(path.join(plansPath, "road map.md"), "# Road map");

    const { ctx, responses } = createContext({ theaterId: "theater" }, () => theaterPath);
    await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    const response = responses[0] as { status: number; body: { plans: Array<{ name: string }> } };
    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan) => plan.name)).not.toContain(".hidden.md");
    expect(response.body.plans.map((plan) => plan.name)).not.toContain("road map.md");
  });

  it("returns document-wide task totals when reading a plan", async () => {
    const plansPath = path.join(theaterPath, ".fleet", "plans");
    await fs.promises.writeFile(path.join(plansPath, "totals.md"), `
# Totals
- [x] preparation
## Wave 1: Build
- [ ] implementation
# Review
- [x] sign-off
`);

    const { ctx, responses } = createContext({ theaterId: "theater", name: "totals.md" }, () => theaterPath);
    await handlePlansRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(responses).toHaveLength(1);
    const response = responses[0] as { status: number; body: { tasksDone: number; tasksTotal: number } };
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tasksDone: 2, tasksTotal: 3 });
  });

  it("returns an empty list when .fleet/plans does not exist", async () => {
    const emptyTheaterPath = path.join(tmpDir, "empty-theater");
    await fs.promises.mkdir(emptyTheaterPath);
    const { ctx, responses } = createContext({ theaterId: "empty" }, () => emptyTheaterPath);

    await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(responses).toEqual([{ status: 200, body: { plans: [] } }]);
  });
});

function createContext(
  body: unknown,
  resolveTheaterPath: (theaterId: string) => string | undefined,
): { ctx: FleetPluginServerContext; responses: JsonResponse[] } {
  const responses: JsonResponse[] = [];
  const ctx = {
    host: {
      http: {
        readJsonBody: vi.fn().mockResolvedValue(body),
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => {
          responses.push({ status, body: responseBody });
        },
      },
      paths: { resolveTheaterPath },
      security: { isTerminalAuthorized: () => true },
    },
  } as unknown as FleetPluginServerContext;

  return { ctx, responses };
}
