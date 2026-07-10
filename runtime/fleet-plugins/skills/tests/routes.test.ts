import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it } from "vitest";

import type { CliExecutor } from "../server/cli.js";
import {
  extractSkillMarkdown,
  handleGetJob,
  handleInstalledFile,
  handleInstall,
  handleList,
  handlePreview,
  handleRemove,
  handleSearch,
  handleUpdate,
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

  it("handleSearch → 401", async () => {
    const res = makeRes();
    await handleSearch(makeReq("GET", "/plugins/skills/search?q=ts"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleInstall → 401", async () => {
    const res = makeRes();
    await handleInstall(makeReq("POST", "/plugins/skills/install"), res, unauthorizedCtx, dummyExec);
    expect(res._status).toBe(401);
  });

  it("handleUpdate → 401", async () => {
    const res = makeRes();
    await handleUpdate(makeReq("POST", "/plugins/skills/update"), res, unauthorizedCtx, dummyExec);
    expect(res._status).toBe(401);
  });

  it("handleGetJob → 401", async () => {
    const res = makeRes();
    await handleGetJob(makeReq("GET", "/plugins/skills/jobs?jobId=x"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleRemove → 401", async () => {
    const res = makeRes();
    await handleRemove(makeReq("POST", "/plugins/skills/remove"), res, unauthorizedCtx, dummyExec);
    expect(res._status).toBe(401);
  });

  it("handlePreview → 401", async () => {
    const res = makeRes();
    await handlePreview(makeReq("POST", "/plugins/skills/preview"), res, unauthorizedCtx, dummyExec);
    expect(res._status).toBe(401);
  });

  it("handleInstalledFile → 401", async () => {
    const res = makeRes();
    await handleInstalledFile(makeReq("POST", "/plugins/skills/installed-file"), res, unauthorizedCtx, dummyExec);
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
  it("resolves list's project command cwd from relPath", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-routes-"));
    const theaterRoot = path.join(temporaryDirectory, "theater");
    const selectedDirectory = path.join(theaterRoot, "nested");
    const calls: string[] = [];
    await fs.mkdir(selectedDirectory, { recursive: true });

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

      await handleList(makeReq("GET", "/plugins/skills/list?theaterId=t1&relPath=nested"), res, ctx, executor);

      expect(res._status).toBe(200);
      expect(calls).toContain(await fs.realpath(selectedDirectory));
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

// ─── extractSkillMarkdown ─────────────────────────────────────────────────────

describe("extractSkillMarkdown", () => {
  it("태그 사이 본문만 반환한다", () => {
    const raw = "some prefix\n<SKILL.md>\n# Hello\nworld\n</SKILL.md>\nsome suffix";
    expect(extractSkillMarkdown(raw)).toBe("# Hello\nworld");
  });

  it("태그 없으면 전체 trim 반환한다", () => {
    const raw = "  # Plain markdown\n  ";
    expect(extractSkillMarkdown(raw)).toBe("# Plain markdown");
  });

  it("ANSI 코드를 제거한다", () => {
    const raw = "\x1B[32m<SKILL.md>\x1B[0m\ncontent\n</SKILL.md>";
    expect(extractSkillMarkdown(raw)).toBe("content");
  });

  it("닫는 태그가 없으면 전체 trim 반환한다", () => {
    const raw = "<SKILL.md>\nno closing";
    expect(extractSkillMarkdown(raw)).toBe("<SKILL.md>\nno closing");
  });

  it("빈 태그 본문은 빈 문자열을 반환한다", () => {
    const raw = "<SKILL.md></SKILL.md>";
    expect(extractSkillMarkdown(raw)).toBe("");
  });
});
