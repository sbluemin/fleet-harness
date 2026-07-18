import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ensureWorkspaceDirectory } from "@dotobokuri/core-infra/workspace-dir";
import { createPlanWorkspaceServerBindings, getPlanToolSpecs } from "@dotobokuri/fleet-plans";

import { createPlansRouter } from "../core/host/plans/routes.js";

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

interface PlansTestContext {
  readonly router: ReturnType<typeof createPlansRouter>;
}

let tmpDir: string;
let theaterPath: string;
let fleetDataDir: string;

beforeAll(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "plans-sec-"));
  theaterPath = path.join(tmpDir, "theater");
  fleetDataDir = path.join(tmpDir, "fleet-data");
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
    const plansPath = workspacePlansPath(theaterPath);
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

  it("returns 403 when reading a symlinked workspace Plan", async () => {
    const { ctx, responses } = createContext({ theaterId: "theater", name: "escape.md" }, () => theaterPath);

    await handlePlansRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(responses).toEqual([{ status: 403, body: { error: "unsafe_path" } }]);
  });

  it("lists an oversized plan without parsing its body", async () => {
    const plansPath = workspacePlansPath(theaterPath);
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
    const plansPath = workspacePlansPath(theaterPath);
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
    const plansPath = workspacePlansPath(theaterPath);
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

  it("keeps Plans Theater-wide and excludes nested workspace Plans", async () => {
    const nestedPath = path.join(theaterPath, "worktrees", "feature");
    await fs.promises.mkdir(nestedPath, { recursive: true });
    const nestedPlansPath = workspacePlansPath(nestedPath);
    await fs.promises.writeFile(path.join(nestedPlansPath, "nested.md"), "# Nested Plan");

    const rootList = createContext({ theaterId: "theater" }, () => theaterPath);
    await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, rootList.ctx);
    const rootPlans = (rootList.responses[0] as { body: { plans: Array<{ name: string }> } }).body.plans;
    expect(rootPlans.map((plan) => plan.name)).not.toContain("nested.md");
    const nestedRead = createContext({ theaterId: "theater", name: "nested.md" }, () => theaterPath);
    await handlePlansRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, nestedRead.ctx);
    expect(nestedRead.responses).toEqual([{ status: 404, body: { error: "not_found" } }]);
  });

  it("shows a Plan written from a Carrier worktree through the active Theater routes", async () => {
    const carrierCwd = path.join(theaterPath, ".fleet", "worktrees", "carrier-topic");
    await fs.promises.mkdir(carrierCwd, { recursive: true });
    const specs = getPlanToolSpecs({ dataDir: fleetDataDir });
    const serverBindings = createPlanWorkspaceServerBindings(fleetDataDir, theaterPath);
    const markdown = `# Objective

Keep the Plan visible from its active Theater.

# File Ownership

- W1-A owns plans/**

# Execution Topology

- Execution mode: Sequential
- Shared mutable resources: Theater PlanStore

# Waves

## Wave 1 — Theater visibility

### Lane W1-A — Theater Plan binding

- Exact write set:
  - plans/**
- Read dependencies:
  - Not applicable
- Dependency/start condition: Theater root resolved
- Eligible concurrent lanes: none
- Integration gate: Theater routes return the Plan
- Handoff: Theater-visible Plan
- Rollback unit: Plan fixture
- Implementation summary:
  - [ ] W1-A-T1 — Write the Theater-bound Plan
- Verification/static checks:
  - plan lint
- Escalation triggers: Theater binding unavailable

# Dispatch Manifest

- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only
- Lane W1-A — exact write set, dependencies, gate, handoff, and rollback from W1-A

# QA Gates

- The Theater list and read routes return the written Plan.

# Acceptance Criteria

- A Carrier worktree write resolves to the Theater PlanStore.

# Documentation Updates

- No documentation update required.

# Final Review Loop

- Verify the Theater route response contains the Plan.
`;

    const written = await specs.write.execute({
      plan_id: "theater-bound",
      markdown,
    }, { cwd: carrierCwd, serverBindings });
    const list = createContext({ theaterId: "theater" }, () => theaterPath);
    const read = createContext({ theaterId: "theater", name: "theater-bound.md" }, () => theaterPath);
    await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, list.ctx);
    await handlePlansRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, read.ctx);

    expect(written).toMatchObject({ ok: true });
    expect((list.responses[0] as { readonly body: { readonly plans: Array<{ readonly name: string }> } }).body.plans).toEqual(expect.arrayContaining([expect.objectContaining({ name: "theater-bound.md" })]));
    expect(read.responses).toEqual([expect.objectContaining({ status: 200, body: expect.objectContaining({ markdown }) })]);
    expect(JSON.stringify({ list: list.responses, read: read.responses })).not.toContain(carrierCwd);
    expect(JSON.stringify({ list: list.responses, read: read.responses })).not.toContain("fleet-plans.workspace-ref");
  });

  it("rejects legacy or path-shaped Plan scope before Theater lookup", async () => {
    for (const relPath of [null, "worktrees/feature", "/tmp", "../outside", "nested/../outside"]) {
      const resolveTheaterPath = vi.fn(() => theaterPath);
      const { ctx, responses } = createContext({ theaterId: "theater", relPath }, resolveTheaterPath);

      await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

      expect(responses).toEqual([{ status: 400, body: { error: "invalid_request" } }]);
      expect(resolveTheaterPath).not.toHaveBeenCalled();
    }
  });

  it("rejects an escaping plans-directory symlink beneath a Theater workspace", async () => {
    const outsidePlansPath = path.join(tmpDir, "outside-plans");
    await fs.promises.mkdir(outsidePlansPath);
    await fs.promises.writeFile(path.join(outsidePlansPath, "outside.md"), "# Outside");

    const plansEscapeTheater = path.join(tmpDir, "plans-escape-theater");
    await fs.promises.mkdir(plansEscapeTheater);
    const plansEscapeWorkspace = ensureWorkspaceDirectory(fleetDataDir, plansEscapeTheater);
    await fs.promises.symlink(outsidePlansPath, path.join(plansEscapeWorkspace.path, "plans"));
    const plansEscape = createContext({ theaterId: "plans-escape" }, () => plansEscapeTheater);
    await handlePlansList({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, plansEscape.ctx);
    expect(plansEscape.responses).toEqual([{ status: 403, body: { error: "unsafe_path" } }]);
  });

  it("returns an empty list when the workspace Plan directory does not exist", async () => {
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
): { ctx: PlansTestContext; responses: JsonResponse[] } {
  const responses: JsonResponse[] = [];
  const ctx: PlansTestContext = {
    router: createPlansRouter({
      dataDir: fleetDataDir,
      isAuthorized: () => true,
      readJsonBody: vi.fn().mockResolvedValue(body),
      resolveTheaterPath: (theaterId) => resolveTheaterPath(theaterId) ?? null,
      writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => {
        responses.push({ status, body: responseBody });
      },
    }),
  };

  return { ctx, responses };
}

function workspacePlansPath(cwd: string): string {
  const workspace = ensureWorkspaceDirectory(fleetDataDir, cwd);
  const plansPath = path.join(workspace.path, "plans");
  fs.mkdirSync(plansPath, { recursive: true });
  return plansPath;
}

async function handlePlansList(req: http.IncomingMessage, res: http.ServerResponse, ctx: PlansTestContext): Promise<void> {
  await ctx.router({ req, res, pathname: "/api/v1/plans/list" });
}

async function handlePlansRead(req: http.IncomingMessage, res: http.ServerResponse, ctx: PlansTestContext): Promise<void> {
  await ctx.router({ req, res, pathname: "/api/v1/plans/read" });
}
