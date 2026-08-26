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
  handleInstalledPackage,
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

  it("handleInstalledPackage → 401", async () => {
    const res = makeRes();
    await handleInstalledPackage(makeReq("POST", "/plugins/skills/installed-package"), res, unauthorizedCtx, dummyExec);
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

describe("palette installed-skill search", () => {
  it("hydrates the cache before searching when no list is cached", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-search-empty-"));
    const theaterRoot = path.join(temporaryDirectory, "theater");
    await fs.mkdir(theaterRoot, { recursive: true });
    try {
      const executor = vi.fn<CliExecutor>(async (args, options) => ({
        stdout: args.includes("-g") ? "[]" : JSON.stringify([{
          name: "needle-browser",
          path: path.join(options.cwd, ".claude", "skills", "needle-browser"),
          scope: "project",
          agents: ["Claude Code"],
        }]),
        stderr: "",
        exitCode: 0,
      }));
      const ctx = {
        host: {
          security: { isTerminalAuthorized: () => true },
          http: {
            writeJson: (res: http.ServerResponse, status: number, body: unknown) => {
              (res as unknown as { _status: number; _body: unknown })._status = status;
              (res as unknown as { _status: number; _body: unknown })._body = body;
            },
            readJsonBody: async () => ({ theaterId: "uncached-theater", query: "needle", limit: 8 }),
          },
          paths: { resolveTheaterPath: () => theaterRoot },
        },
      } as unknown as FleetPluginServerContext;
      const res = makeRes();

      await handlePaletteSearch(makeReq("POST", "/plugins/skills/palette-search"), res, ctx, executor);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ skills: [{ name: "needle-browser", scope: "project" }] });
      expect(executor).toHaveBeenCalled();
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("returns only cached logical names and scopes without invoking the CLI", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-search-"));
    const theaterRoot = path.join(temporaryDirectory, "theater");
    await fs.mkdir(theaterRoot, { recursive: true });
    try {
      const ctx = {
        host: {
          security: { isTerminalAuthorized: () => true },
          http: {
            writeJson: (res: http.ServerResponse, status: number, body: unknown) => {
              (res as unknown as { _status: number; _body: unknown })._status = status;
              (res as unknown as { _status: number; _body: unknown })._body = body;
            },
            readJsonBody: async () => ({ theaterId: "theater-a", query: "needle", limit: 8 }),
          },
          paths: { resolveTheaterPath: () => theaterRoot },
        },
      } as unknown as FleetPluginServerContext;
      const executor: CliExecutor = async (args, options) => ({
        stdout: JSON.stringify([{
          name: args.includes("-g") ? "needle-global" : "needle-project",
          path: path.join(options.cwd, "absolute", "SKILL.md"),
          scope: args.includes("-g") ? "global" : "project",
          agents: ["codex"],
        }]),
        stderr: "",
        exitCode: 0,
      });
      const executorSpy = vi.fn(executor);
      const listRes = makeRes();
      await handleList(makeReq("GET", "/plugins/skills/list?theaterId=theater-a"), listRes, ctx, executorSpy);
      expect(listRes._status).toBe(200);
      executorSpy.mockClear();

      const res = makeRes();
      await handlePaletteSearch(makeReq("POST", "/plugins/skills/palette-search"), res, ctx, executorSpy);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({
        skills: [
          { name: "needle-global", scope: "global" },
          { name: "needle-project", scope: "project" },
        ],
      });
      expect(executorSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(res._body)).not.toContain(temporaryDirectory);
      expect(JSON.stringify(res._body)).not.toContain(await fs.realpath(theaterRoot));
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

describe("list DTO carries the description the card needs", () => {
  it("reads SKILL.md frontmatter from the CLI-reported path without leaking that path", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-desc-"));
    const theaterRoot = path.join(temporaryDirectory, "theater");
    const described = path.join(theaterRoot, ".claude", "skills", "console-e2e");
    const bare = path.join(theaterRoot, ".claude", "skills", "no-frontmatter");
    await fs.mkdir(described, { recursive: true });
    await fs.mkdir(bare, { recursive: true });
    await fs.writeFile(
      path.join(described, "SKILL.md"),
      "---\nname: console-e2e\ndescription: Drive a headless real-browser end-to-end test.\n---\n\n# body\n",
      "utf-8",
    );
    await fs.writeFile(path.join(bare, "SKILL.md"), "# no frontmatter here\n", "utf-8");

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

      const executor: CliExecutor = async (args) => ({
        stdout: args.includes("-g") ? "[]" : JSON.stringify([
          { name: "console-e2e", path: described, scope: "project", agents: ["Claude Code"] },
          { name: "no-frontmatter", path: bare, scope: "project", agents: ["Claude Code"] },
        ]),
        stderr: "",
        exitCode: 0,
      });

      const res = makeRes();
      await handleList(makeReq("GET", "/plugins/skills/list?theaterId=t1"), res, ctx, executor);

      expect(res._status).toBe(200);
      const skills = (res._body as { skills: Array<Record<string, unknown>> }).skills;
      expect(skills).toHaveLength(2);

      const described_dto = skills.find((s) => s.name === "console-e2e");
      expect(described_dto?.description).toBe("Drive a headless real-browser end-to-end test.");
      // 절대 경로는 서버 안에만 남는다 — 설명을 실어 보내려고 경로를 함께 흘리지 않는다.
      expect("path" in (described_dto ?? {})).toBe(false);
      expect(JSON.stringify(skills)).not.toContain(temporaryDirectory);

      // frontmatter가 없으면 키 자체를 생략한다 — 빈 문자열을 만들어 카드에 빈 줄을 그리지 않는다.
      const bare_dto = skills.find((s) => s.name === "no-frontmatter");
      expect("description" in (bare_dto ?? {})).toBe(false);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

describe("lock file provenance", () => {
  async function listWith(lockName: string | null, lockBody: unknown): Promise<Array<Record<string, unknown>>> {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-lock-"));
    const theaterRoot = path.join(temporaryDirectory, "theater");
    const skillDir = path.join(theaterRoot, ".claude", "skills", "agent-browser");
    await fs.mkdir(skillDir, { recursive: true });
    if (lockName !== null) {
      await fs.mkdir(path.dirname(path.join(theaterRoot, lockName)), { recursive: true });
      const body = typeof lockBody === "string" ? lockBody : JSON.stringify(lockBody);
      await fs.writeFile(path.join(theaterRoot, lockName), body, "utf-8");
    }

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
      const executor: CliExecutor = async (args) => ({
        stdout: args.includes("-g") ? "[]" : JSON.stringify([
          { name: "agent-browser", path: skillDir, scope: "project", agents: ["Claude Code"] },
        ]),
        stderr: "",
        exitCode: 0,
      });
      const res = makeRes();
      await handleList(makeReq("GET", "/plugins/skills/list?theaterId=t1"), res, ctx, executor);
      return (res._body as { skills: Array<Record<string, unknown>> }).skills;
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  }

  async function listWithoutLock(): Promise<Array<Record<string, unknown>>> {
    return listWith(null, null);
  }

  it("reads the v3 nested lock shape", async () => {
    // 실제 파일은 v3다. v1 모양만 읽으면 설치 출처가 있는 스킬까지 전부 출처 없음으로 보인다.
    const skills = await listWith(path.join(".agents", ".skill-lock.json"), {
      version: 3,
      skills: { "agent-browser": { source: "vercel-labs/agent-browser", sourceType: "github" } },
      dismissed: [],
    });
    expect(skills[0]?.source).toBe("vercel-labs/agent-browser");
  });

  it("still reads the v1 flat lock shape", async () => {
    const skills = await listWith("skills-lock.json", {
      "agent-browser": { source: "vercel-labs/agent-browser" },
    });
    expect(skills[0]?.source).toBe("vercel-labs/agent-browser");
  });

  it("marks a skill absent from a readable lock as unmanaged, not as having a source", async () => {
    const skills = await listWith("skills-lock.json", { version: 3, skills: {} });
    expect("source" in (skills[0] ?? {})).toBe(false);
    expect(skills[0]?.unmanaged).toBe(true);
  });

  it("claims neither source nor unmanaged when the lock cannot be read", async () => {
    // 손상된/모르는 스키마의 lock은 "출처 없음"이 아니라 "출처 미상"이다. unmanaged를 세우면
    // 스키마가 또 바뀌는 날 레지스트리 설치 스킬까지 전부 직접 작성이라고 단언하게 된다.
    const skills = await listWith("skills-lock.json", "not json at all");
    expect("source" in (skills[0] ?? {})).toBe(false);
    expect("unmanaged" in (skills[0] ?? {})).toBe(false);
  });

  it("claims neither source nor unmanaged when no lock file exists at all", async () => {
    const skills = await listWithoutLock();
    expect("source" in (skills[0] ?? {})).toBe(false);
    expect("unmanaged" in (skills[0] ?? {})).toBe(false);
  });

  it("treats an unrecognized lock shape as unreadable rather than empty", async () => {
    const skills = await listWith("skills-lock.json", { version: 9, entries: ["agent-browser"] });
    expect("unmanaged" in (skills[0] ?? {})).toBe(false);
  });

  it.each([
    ["an array skills table", { version: 9, skills: [] }],
    ["a populated array skills table", { version: 9, skills: [{ source: "owner/repo" }] }],
    ["a scalar skills table", { version: 9, skills: "owner/repo" }],
    ["a null skills table", { version: 9, skills: null }],
    ["a top-level array", ["agent-browser"]],
    ["a v1-looking file whose entries carry no source", { version: 9, meta: {}, config: { debug: true } }],
  ])("does not accept %s as a readable lock", async (_label, body) => {
    // 배열도 typeof "object"라 이 한 글자를 놓치면 "읽어낸 빈 lock"으로 통과하고,
    // 설치된 스킬 전부가 다시 관리 밖(=로컬)으로 단언된다.
    const skills = await listWith("skills-lock.json", body);
    expect("source" in (skills[0] ?? {})).toBe(false);
    expect("unmanaged" in (skills[0] ?? {})).toBe(false);
  });

  it("still accepts a v3 file whose declared skills table is an empty record", async () => {
    // v3는 `skills` 키로 표를 스스로 선언한다 — 비어 있어도 읽어낸 lock이다.
    const skills = await listWith("skills-lock.json", { version: 3, skills: {} });
    expect(skills[0]?.unmanaged).toBe(true);
  });
});
