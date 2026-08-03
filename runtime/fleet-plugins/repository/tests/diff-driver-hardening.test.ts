import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { handleRepositoryCompareFile } from "../server/compare-file.js";
import { handleRepositoryCommitFile } from "../server/commit-file.js";
import { handleRepositoryFile } from "../server/diff.js";
import { runGit } from "../server/git-executor.js";

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface ContentPayload {
  readonly content: string;
}

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
}

function makeContext(theaterPath: string, body: Record<string, unknown>, writes: JsonWrite[]): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, payload: unknown) => { writes.push({ status, payload }); },
      },
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
}

// repo-local .gitattributes + .git/config의 custom diff driver/textconv가
// hunk 조회(브라우저 클릭)로 실행되지 않아야 한다 — --no-ext-diff/--no-textconv 회귀 가드.
describe("diff driver hardening", () => {
  let tmpDir: string;
  let theaterPath: string;
  let driverMarker: string;
  let textconvMarker: string;
  let headRef: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-diff-driver-"));
    theaterPath = path.join(tmpDir, "repo");
    driverMarker = path.join(tmpDir, "DRIVER_RAN");
    textconvMarker = path.join(tmpDir, "TEXTCONV_RAN");
    await fs.mkdir(theaterPath, { recursive: true });
    await initGitRepo(theaterPath);

    await fs.writeFile(path.join(theaterPath, "a.txt"), "one\n");
    await fs.writeFile(path.join(theaterPath, ".gitattributes"), "*.txt diff=owned\n");
    await runGit(["add", "."], { cwd: theaterPath });
    await runGit(["commit", "-m", "base"], { cwd: theaterPath });
    headRef = `refs/heads/${(await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: theaterPath })).stdout.trim()}`;

    await runGit(["checkout", "-b", "feature"], { cwd: theaterPath });
    await fs.writeFile(path.join(theaterPath, "a.txt"), "two\n");
    await runGit(["commit", "-am", "change"], { cwd: theaterPath });

    const driverScript = path.join(tmpDir, "hook.sh");
    const textconvScript = path.join(tmpDir, "tc.sh");
    await fs.writeFile(driverScript, `#!/bin/sh\ntouch "${driverMarker}"\nexit 0\n`, { mode: 0o755 });
    await fs.writeFile(textconvScript, `#!/bin/sh\ntouch "${textconvMarker}"\ncat "$1"\n`, { mode: 0o755 });
    await runGit(["config", "diff.owned.command", driverScript], { cwd: theaterPath });
    await runGit(["config", "diff.owned.textconv", textconvScript], { cwd: theaterPath });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function expectNoMarkers(): Promise<void> {
    await expect(fs.access(driverMarker)).rejects.toThrow();
    await expect(fs.access(textconvMarker)).rejects.toThrow();
  }

  it("compare-file hunks never invoke the repo-local driver or textconv", async () => {
    const writes: JsonWrite[] = [];
    const ctx = makeContext(theaterPath, { theaterId: "t1", base: headRef, head: "refs/heads/feature", filePath: "a.txt" }, writes);
    await handleRepositoryCompareFile({ method: "POST" } as never, {} as never, ctx);
    expect(writes[0]?.status).toBe(200);
    expect((writes[0]?.payload as ContentPayload).content).toContain("+two");
    await expectNoMarkers();
  });

  it("commit-file hunks never invoke the repo-local driver or textconv", async () => {
    const writes: JsonWrite[] = [];
    const featureSha = (await runGit(["rev-parse", "refs/heads/feature"], { cwd: theaterPath })).stdout.trim();
    const ctx = makeContext(theaterPath, { theaterId: "t1", ref: featureSha, filePath: "a.txt" }, writes);
    await handleRepositoryCommitFile({ method: "POST" } as never, {} as never, ctx);
    expect(writes[0]?.status).toBe(200);
    expect((writes[0]?.payload as ContentPayload).content).toContain("+two");
    await expectNoMarkers();
  });

  it("working-changes hunks never invoke the repo-local driver or textconv", async () => {
    await fs.writeFile(path.join(theaterPath, "a.txt"), "three\n");
    const writes: JsonWrite[] = [];
    const ctx = makeContext(theaterPath, { theaterId: "t1", filePath: "a.txt", mode: "unified" }, writes);
    await handleRepositoryFile({ method: "POST" } as never, {} as never, ctx);
    expect(writes[0]?.status).toBe(200);
    expect((writes[0]?.payload as ContentPayload).content).toContain("+three");
    await expectNoMarkers();
  });
});
