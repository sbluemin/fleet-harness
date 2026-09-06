import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import { handleFilesGitStatus } from "../server/tree-services.js";
import { parseGitStatusPorcelainV1Z, readTheaterGitStatus, scopeGitStatusesToTheater } from "../server/tree-services.js";

describe("readTheaterGitStatus", () => {
  it("disables fsmonitor and optional locks while removing Git override environment", async () => {
    const contaminatedEnvironment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      GIT_DIR: "/attacker/git-dir",
      GIT_COMMON_DIR: "/attacker/common-dir",
      GIT_OBJECT_DIRECTORY: "/attacker/objects",
      GIT_CEILING_DIRECTORIES: "/attacker",
      GIT_WORK_TREE: "/attacker/work-tree",
      GIT_INDEX_FILE: "/attacker/index",
      GIT_CONFIG: "/attacker/config",
      GIT_CONFIG_GLOBAL: "/attacker/global-config",
      GIT_CONFIG_SYSTEM: "/attacker/system-config",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/attacker/hook",
      GIT_OPTIONAL_LOCKS: "1",
    };
    const execGit = vi.fn(async () => "");

    const result = await readTheaterGitStatus("/theater", {
      environment: contaminatedEnvironment,
      execGit,
      realpath: async () => "/real/theater",
    });

    expect(result).toEqual({ ok: true, gitAvailable: true, statuses: [] });
    expect(execGit).toHaveBeenCalledTimes(2);
    const calls = execGit.mock.calls as unknown as Array<[
      readonly string[],
      { readonly env: NodeJS.ProcessEnv; readonly killSignal: string },
    ]>;
    for (const [args, options] of calls) {
      expect(args.slice(0, 5)).toEqual([
        "-c",
        "core.fsmonitor=false",
        "--no-optional-locks",
        "-C",
        "/real/theater",
      ]);
      expect(options.killSignal).toBe("SIGKILL");
      expect(options.env).toMatchObject({ PATH: "/usr/bin", GIT_OPTIONAL_LOCKS: "0" });
      expect(options.env).not.toHaveProperty("GIT_DIR");
      expect(options.env).not.toHaveProperty("GIT_COMMON_DIR");
      expect(options.env).not.toHaveProperty("GIT_OBJECT_DIRECTORY");
      expect(options.env).not.toHaveProperty("GIT_CEILING_DIRECTORIES");
      expect(options.env).not.toHaveProperty("GIT_WORK_TREE");
      expect(options.env).not.toHaveProperty("GIT_INDEX_FILE");
      expect(options.env).not.toHaveProperty("GIT_CONFIG");
      expect(options.env).not.toHaveProperty("GIT_CONFIG_GLOBAL");
      expect(options.env).not.toHaveProperty("GIT_CONFIG_SYSTEM");
      expect(options.env).not.toHaveProperty("GIT_CONFIG_COUNT");
      expect(options.env).not.toHaveProperty("GIT_CONFIG_KEY_0");
      expect(options.env).not.toHaveProperty("GIT_CONFIG_VALUE_0");
    }
    const statusArgs = calls.find(([args]) => args.includes("status"))?.[0];
    expect(statusArgs).toContain("--untracked-files=all");
    expect(contaminatedEnvironment.GIT_DIR).toBe("/attacker/git-dir");
  });

  it("caps returned statuses at 10,000 and marks the response truncated", async () => {
    const statusOutput = Array.from({ length: 10_001 }, (_, index) => `?? file-${index}.ts`).join("\0") + "\0";
    const execGit = vi.fn(async (args: readonly string[]) => args.includes("status") ? statusOutput : "");

    const result = await readTheaterGitStatus("/theater", {
      execGit,
      realpath: async () => "/real/theater",
    });

    expect(result.gitAvailable).toBe(true);
    expect(result.statuses).toHaveLength(10_000);
    expect(result).toHaveProperty("truncated", true);
  });
});

describe("handleFilesGitStatus", () => {
  it("returns gitAvailable false for a directory that is not a repository", async () => {
    const theaterPath = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-file-git-status-"));
    const writes: Array<{ readonly status: number; readonly body: unknown }> = [];
    const ctx = {
      host: {
        http: {
          readJsonBody: async () => ({ theaterId: "theater-a" }),
          writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { writes.push({ status, body }); },
        },
        paths: { resolveTheaterPath: () => theaterPath },
        security: { isTerminalAuthorized: () => true },
      },
    } as unknown as FleetPluginServerContext;

    try {
      await handleFilesGitStatus(
        { method: "POST" } as http.IncomingMessage,
        {} as http.ServerResponse,
        ctx,
      );

      expect(writes).toEqual([{
        status: 200,
        body: { ok: true, gitAvailable: false, statuses: [] },
      }]);
    } finally {
      await fs.rm(theaterPath, { recursive: true, force: true });
    }
  });
});
