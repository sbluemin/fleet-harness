import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "../server/git-executor.js";
import { handleRepositoryRefs } from "../server/refs.js";

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
}

function makeRefsContext(theaterPath: string, writes: { status: number; payload: unknown }[]): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => ({ theaterId: "theater" }),
        writeJson: (_res: unknown, status: number, payload: unknown) => { writes.push({ status, payload }); },
      },
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
}

describe("handleRepositoryRefs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-refs-server-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a ref inventory for a bare repository without a current worktree path", async () => {
    const sourceDir = path.join(tmpDir, "source");
    const bareDir = path.join(tmpDir, "inventory.git");
    await fs.mkdir(sourceDir);
    await initGitRepo(sourceDir);
    await fs.writeFile(path.join(sourceDir, "entry.txt"), "history");
    await runGit(["add", "entry.txt"], { cwd: sourceDir });
    await runGit(["commit", "-m", "history"], { cwd: sourceDir });
    await runGit(["clone", "--bare", sourceDir, bareDir], { cwd: tmpDir });

    const writes: { status: number; payload: unknown }[] = [];
    await handleRepositoryRefs({ method: "POST" } as never, {} as never, makeRefsContext(bareDir, writes));

    expect(writes[0]?.status).toBe(200);
    const payload = writes[0]?.payload as { readonly branches: readonly { readonly ref: string; readonly current: boolean }[] };
    expect(payload.branches).toContainEqual(expect.objectContaining({ ref: expect.stringMatching(/^refs\/heads\//), current: true }));
    expect(payload).not.toHaveProperty("worktrees");
    expect(JSON.stringify(payload)).not.toContain(bareDir);
  });
});
