import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import type { CliExecutor } from "../server/cli.js";
import {
  extractSkillMarkdown,
  handleGetJob,
  handleInstalledFile,
  handleInstall,
  handleList,
  handlePaletteSearch,
  handlePreview,
  handleRemove,
  handleSearch,
  handleUpdate,
  redactJobOutput,
} from "../server/handlers.js";

// ─── mock helpers ─────────────────────────────────────────────────────────────

function makeUnauthorizedCtx(): FleetPluginServerContext {
  return {
    host: {
      security: {
        isTerminalAuthorized: () => false,
      },
      http: {
        writeJson: (res: http.ServerResponse, status: number, body: unknown) => {
          (res as unknown as { _status: number; _body: unknown })._status = status;
          (res as unknown as { _body: unknown })._body = body;
        },
        readJsonBody: async () => ({}),
      },
      paths: {
        resolveTheaterPath: () => null,
      },
    },
  } as unknown as FleetPluginServerContext;
}

function makeReq(method: string, url: string): http.IncomingMessage {
  return {
    method,
    url,
    headers: { host: "localhost" },
  } as unknown as http.IncomingMessage;
}

function makeRes(): http.ServerResponse & { _status?: number; _body?: unknown } {
  return {} as http.ServerResponse & { _status?: number; _body?: unknown };
}

// ─── 401 tests ───────────────────────────────────────────────────────────────

const unauthorizedCtx = makeUnauthorizedCtx();
const dummyExec: CliExecutor = async () => ({ stdout: "", stderr: "", exitCode: 0 });

describe("미인가 요청 401", () => {
  it("handleList → 401", async () => {
    const res = makeRes();
    await handleList(makeReq("GET", "/plugins/skills/list"), res, unauthorizedCtx, dummyExec);
    expect(res._status).toBe(401);
  });

  it("handleRemove → 401", async () => {
    const res = makeRes();
    await handleRemove(makeReq("POST", "/plugins/skills/remove"), res, unauthorizedCtx, dummyExec);
    expect(res._status).toBe(401);
  });
});

// ─── remove CLI 인자 계약 ─────────────────────────────────────────────────────

describe("handleRemove CLI 인자", () => {
  it("agent 플래그 없이 remove -s <skill> -y 로 실행한다 (-a '*'는 CLI가 거부 — 실측 고정)", async () => {
    const calls: string[][] = [];
    const spyExec: CliExecutor = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const ctx = {
      host: {
        security: { isTerminalAuthorized: () => true },
        http: {
          writeJson: (res: http.ServerResponse, status: number, body: unknown) => {
            (res as unknown as { _status: number })._status = status;
            (res as unknown as { _body: unknown })._body = body;
          },
          readJsonBody: async () => ({ scope: "global", skill: "pdf" }),
        },
        paths: { resolveTheaterPath: () => null },
      },
    } as unknown as FleetPluginServerContext;

    const res = makeRes();
    await handleRemove(makeReq("POST", "/plugins/skills/remove"), res, ctx, spyExec);

    expect(res._status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["remove", "-s", "pdf", "-y"]);
    expect(calls[0]).not.toContain("*");
  });
});

describe("project scope cwd", () => {
  it("resolves list's project command cwd from the canonical Theater root", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-routes-"));
    const theaterRoot = path.join(temporaryDirectory, "theater");
    const calls: string[] = [];
    await fs.mkdir(theaterRoot, { recursive: true });

    try {
      const ctx = {
        host: {
          security: { isTerminalAuthorized: () => true },
          http: {
            writeJson: (res: http.ServerResponse, status: number, body: unknown) => {
              (res as unknown as { _status: number })._status = status;
              (res as unknown as { _body: unknown })._body = body;
            },
            readJsonBody: async () => ({}),
          },
          paths: { resolveTheaterPath: () => theaterRoot },
        },
      } as unknown as FleetPluginServerContext;
      const executor: CliExecutor = async (_args, options) => {
        calls.push(options.cwd);
        return { stdout: "[]", stderr: "", exitCode: 0 };
      };
      const res = makeRes();

      await handleList(makeReq("GET", "/plugins/skills/list?theaterId=t1"), res, ctx, executor);

      expect(res._status).toBe(200);
      expect(calls).toContain(await fs.realpath(theaterRoot));
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

describe("legacy relPath rejection", () => {
  it("rejects every legacy query/body before Theater or CLI work", async () => {
    const resolveTheaterPath = vi.fn(() => "/theater");
    const executor = vi.fn<CliExecutor>(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = {
      host: {
        security: { isTerminalAuthorized: () => true },
        http: {
          writeJson: (res: http.ServerResponse, status: number, body: unknown) => {
            (res as unknown as { _status: number; _body: unknown })._status = status;
            (res as unknown as { _status: number; _body: unknown })._body = body;
          },
          readJsonBody: async () => ({ relPath: "nested" }),
        },
        paths: { resolveTheaterPath },
      },
    } as unknown as FleetPluginServerContext;

    const calls: Array<() => Promise<void>> = [
      () => handleList(makeReq("GET", "/plugins/skills/list?relPath=nested"), makeRes(), ctx, executor),
      () => handleSearch(makeReq("GET", "/plugins/skills/search?q=ts&relPath=nested"), makeRes(), ctx),
      () => handleGetJob(makeReq("GET", "/plugins/skills/jobs?jobId=x&relPath=nested"), makeRes(), ctx),
      () => handleInstall(makeReq("POST", "/plugins/skills/install"), makeRes(), ctx, executor),
      () => handleUpdate(makeReq("POST", "/plugins/skills/update"), makeRes(), ctx, executor),
      () => handleRemove(makeReq("POST", "/plugins/skills/remove"), makeRes(), ctx, executor),
      () => handlePreview(makeReq("POST", "/plugins/skills/preview"), makeRes(), ctx, executor),
      () => handleInstalledFile(makeReq("POST", "/plugins/skills/installed-file"), makeRes(), ctx, executor),
    ];

    for (const call of calls) await call();
    expect(resolveTheaterPath).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });
});

// ─── extractSkillMarkdown ─────────────────────────────────────────────────────

describe("job output redaction", () => {
  it("masks home, resolved cwd, plugin cache paths, and credential URLs before job output is stored", () => {
    const output = redactJobOutput(
      "cwd=/Users/operator/worktree/pkg cache=/Users/operator/.fleet/plugins/skills/cli/node_modules credential=https://alice:secret@example.com/pkg token=https://example.com/pkg?access_token=abc123",
      {
        cwd: "/Users/operator/worktree/pkg",
        homeDir: "/Users/operator",
        pluginDataDir: "/Users/operator/.fleet/plugins/skills",
      },
    );

    expect(output).not.toContain("/Users/operator");
    expect(output).not.toContain("alice:secret");
    expect(output).not.toContain("abc123");
    expect(output).toContain("[redacted path]");
    expect(output).toContain("[redacted credential URL]");
    expect(output).toContain("access_token=[redacted]");
  });
});
