import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { runGit } = await import("../server/git-executor.js");
const mockedSpawn = vi.mocked(spawn);

function makeChild(): EventEmitter & {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn>;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

describe("runGit hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GIT_DIR", "/attacker/git-dir");
    vi.stubEnv("git_work_tree", "/attacker/work-tree");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_OPTIONAL_LOCKS", "1");
    vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
    vi.stubEnv("LC_ALL", "ko_KR.UTF-8");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefixes hardened argv and passes only approved Git variables with the C locale", async () => {
    const child = makeChild();
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 0));
      return child as unknown as ReturnType<typeof spawn>;
    });

    await expect(runGit(["status", "--porcelain"], { cwd: "/theater" })).resolves.toEqual({
      stdout: "",
      stderr: "",
      truncated: false,
      stderrTruncated: false,
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockedSpawn.mock.calls[0]!;
    expect(command).toBe("git");
    expect(args).toEqual([
      "-c",
      "core.fsmonitor=false",
      "--no-optional-locks",
      "status",
      "--porcelain",
    ]);
    const environment = (options as { readonly env?: NodeJS.ProcessEnv }).env ?? {};
    expect(environment.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    // 알 수 없는 remote helper의 zero-click 실행을 막는 default-deny transport allowlist.
    expect(environment.GIT_ALLOW_PROTOCOL).toBe("ssh:git:http:https:file");
    expect(environment.LC_ALL).toBe("C");
    expect(environment).not.toHaveProperty("GIT_DIR");
    expect(environment).not.toHaveProperty("git_work_tree");
    expect(environment).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(Object.keys(environment).filter((key) => key.toUpperCase().startsWith("GIT_")).sort()).toEqual([
      "GIT_ALLOW_PROTOCOL",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
    ]);
    expect(process.env.GIT_DIR).toBe("/attacker/git-dir");
  });

  it("caps stderr at one megabyte and reports truncation", async () => {
    const child = makeChild();
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.alloc(1024 * 1024 + 17, "x"));
        child.emit("close", 0);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });

    const result = await runGit(["status"], { cwd: "/theater" });

    expect(result.stderr).toHaveLength(1024 * 1024);
    expect(result.stderrTruncated).toBe(true);
    expect(result.truncated).toBe(false);
  });
});
