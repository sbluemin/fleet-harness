import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGit } from "../server/git-executor.js";
import { handleRepositorySearch, parseRepositorySearchOutput } from "../server/search.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "repository-search-"));
  await runGit(["init"], { cwd: temporaryDirectory });
  await runGit(["config", "user.email", "test@example.com"], { cwd: temporaryDirectory });
  await runGit(["config", "user.name", "Test"], { cwd: temporaryDirectory });
  await fs.writeFile(path.join(temporaryDirectory, "one.txt"), "one");
  await runGit(["add", "."], { cwd: temporaryDirectory });
  await runGit(["commit", "-m", "Needle commit"], { cwd: temporaryDirectory });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { force: true, recursive: true });
});

describe("Repository palette search", () => {
  it("returns only logical repository ids and commit metadata", async () => {
    const writes: Array<{ readonly status: number; readonly body: unknown }> = [];
    const ctx = context({ theaterId: "theater-a", repoRel: "", query: "needle", limit: 8 }, writes);

    await handleRepositorySearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.status).toBe(200);
    expect(writes[0]?.body).toEqual({
      repoRel: "",
      commits: [expect.objectContaining({ subject: "Needle commit" })],
    });
    const serialized = JSON.stringify(writes[0]?.body);
    expect(serialized).not.toContain(temporaryDirectory);
    expect(serialized).not.toContain(await fs.realpath(temporaryDirectory));
  });

  it("rejects option-like revision input before Theater or Git resolution", async () => {
    const resolveTheaterPath = vi.fn(() => temporaryDirectory);
    const writes: Array<{ readonly status: number; readonly body: unknown }> = [];
    const ctx = context({ theaterId: "theater-a", repoRel: "", query: "needle", limit: 8, ref: "--all" }, writes, resolveTheaterPath);

    await handleRepositorySearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes).toEqual([{ status: 400, body: { error: "invalid_request" } }]);
    expect(resolveTheaterPath).not.toHaveBeenCalled();
  });

  it("matches subjects and SHA tokens while honoring the requested limit", () => {
    const stdout = [
      `${"a".repeat(40)}\0${"a".repeat(9)}\0Needle one`,
      `${"b".repeat(40)}\0${"b".repeat(9)}\0Needle two`,
    ].join("\n");
    expect(parseRepositorySearchOutput(stdout, "needle", 1)).toEqual([{
      fullHash: "a".repeat(40),
      shortHash: "a".repeat(9),
      subject: "Needle one",
    }]);
    expect(parseRepositorySearchOutput(stdout, "bbbb", 8)).toHaveLength(1);
  });
});

function context(
  body: Record<string, unknown>,
  writes: Array<{ readonly status: number; readonly body: unknown }>,
  resolveTheaterPath: (theaterId: string) => string | null = () => temporaryDirectory,
): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => writes.push({ status, body: responseBody }),
      },
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath },
    },
  } as unknown as FleetPluginServerContext;
}
