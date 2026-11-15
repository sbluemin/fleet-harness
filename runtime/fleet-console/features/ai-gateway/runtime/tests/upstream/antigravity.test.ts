import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fetchAntigravityUsage } from "../../src/index.js";
import type { CredentialResolverDeps } from "../../src/index.js";
import type { AntigravityCliSpawn } from "../../src/upstream/antigravity/quota.js";

const USAGE = {
  status: "SUCCESS",
  num_turns: 0,
  conversation_id: "",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", remaining_fraction: 0.5, reset_time: "2026-11-21T07:28:17Z" },
            { id: "gemini-5h", remaining_fraction: 0.75, reset_time: "2026-11-15T20:58:32Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", remaining_fraction: 1, reset_time: "2026-11-22T17:11:35Z" },
            { id: "3p-5h", remaining_fraction: 1, reset_time: "2026-11-15T22:11:35Z" },
          ],
        },
      ],
    },
  },
};

const FAKE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = process.env.AGY_FAKE_LOG;
const args = process.argv.slice(2);
if (log) appendFileSync(log, JSON.stringify(args) + "\\n");
const mode = process.env.AGY_FAKE_MODE ?? "ok";
if (args[0] === "--version") {
  process.stdout.write((process.env.AGY_FAKE_VERSION ?? "1.5.9") + "\\n");
  process.exit(0);
}
if (mode === "auth-stderr") {
  process.stderr.write("Authentication required. Please visit the URL to log in:\\n  https://example.invalid/login\\n");
  setInterval(() => {}, 60_000);
} else if (mode === "auth-json") {
  process.stdout.write(JSON.stringify({ status: "ERROR", num_turns: 0, error: "authentication failed or timed out" }));
  process.exit(1);
} else if (mode === "other-error") {
  process.stdout.write(JSON.stringify({ status: "ERROR", num_turns: 0, error: "upstream unavailable" }));
  process.exit(1);
} else if (mode === "turns") {
  process.stdout.write(JSON.stringify({ status: "SUCCESS", num_turns: 1, command: { name: "usage", data: { groups: [{ buckets: [] }] } } }));
  process.exit(0);
} else if (mode === "no-buckets") {
  process.stdout.write(JSON.stringify({ status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [{ name: "Gemini" }] } } }));
  process.exit(0);
} else {
  process.stdout.write(process.env.AGY_FAKE_USAGE ?? "");
  process.exit(0);
}
`;

function credentialDeps(env: NodeJS.ProcessEnv): CredentialResolverDeps {
  return {
    platform: "darwin",
    homedir: () => "/home/tester",
    env,
    readBounded: async () => null,
    execFile: async () => "",
  };
}

describe("antigravity quota", () => {
  let directory = "";
  let binary = "";
  let stamp = 1_700_000_000_000;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agy-fake-"));
    binary = path.join(directory, "agy");
    await writeFile(binary, FAKE);
    await chmod(binary, 0o755);
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function touch(): Promise<void> {
    stamp += 1_000;
    const at = new Date(stamp);
    await utimes(binary, at, at);
  }

  function env(mode: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const log = path.join(directory, `${mode}-${stamp}.log`);
    return {
      ...process.env,
      FLEET_ANTIGRAVITY_CLI: binary,
      AGY_FAKE_MODE: mode,
      AGY_FAKE_LOG: log,
      AGY_FAKE_USAGE: JSON.stringify(USAGE),
      ...extra,
    };
  }

  async function calls(mode: string): Promise<readonly string[][]> {
    const log = path.join(directory, `${mode}-${stamp}.log`);
    const text = await readFile(log, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  }

  it("reads Gemini windows from agy /usage and caches the version", async () => {
    await touch();
    const now = 1_700_000_000_000;
    const result = await fetchAntigravityUsage({
      credentials: credentialDeps(env("ok")),
      now: () => now,
    });
    expect(result).toEqual({
      status: "ok",
      fetchedAt: now,
      windows: [
        {
          id: "session",
          label: "Gemini",
          usedPercent: 25,
          resetsAt: Date.parse("2026-11-15T20:58:32Z"),
          period: {
            durationMs: 18_000_000,
            durationBasis: "catalog",
            startsAt: Date.parse("2026-11-15T20:58:32Z") - 18_000_000,
            startsAtBasis: "derived",
          },
        },
        {
          id: "weekly",
          label: "Gemini",
          usedPercent: 50,
          resetsAt: Date.parse("2026-11-21T07:28:17Z"),
          period: {
            durationMs: 604_800_000,
            durationBasis: "catalog",
            startsAt: Date.parse("2026-11-21T07:28:17Z") - 604_800_000,
            startsAtBasis: "derived",
          },
        },
      ],
    });
    expect(result).not.toHaveProperty("plan");
    expect(result).not.toHaveProperty("method");
    expect(await calls("ok")).toEqual([["--version"], ["-p", "/usage", "--output-format", "json"]]);

    await fetchAntigravityUsage({ credentials: credentialDeps(env("ok")), now: () => now });
    expect(await calls("ok")).toEqual([
      ["--version"],
      ["-p", "/usage", "--output-format", "json"],
      ["-p", "/usage", "--output-format", "json"],
    ]);
  });

  it("reports signed_out when agy cannot be spawned", async () => {
    const spawn = vi.fn<AntigravityCliSpawn>(() => {
      throw Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    });
    const result = await fetchAntigravityUsage({
      credentials: credentialDeps({ FLEET_ANTIGRAVITY_CLI: binary }),
      stat: async () => ({ mtimeMs: stamp + 50_000 }),
      spawn,
    });
    expect(result).toEqual({ status: "signed_out" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(binary, ["--version"], expect.objectContaining({
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: expect.objectContaining({ AGY_CLI_DISABLE_AUTO_UPDATE: "1" }),
    }));
  });

  it("does not send /usage to an agy older than 1.1.11", async () => {
    await touch();
    const result = await fetchAntigravityUsage({
      credentials: credentialDeps(env("ok", { AGY_FAKE_VERSION: "1.1.10" })),
    });
    expect(result).toEqual({ status: "error", message: "agy 1.1.11 or newer is required" });
    expect(await calls("ok")).toEqual([["--version"]]);
  });

  it("rejects a payload that spent a turn or omitted buckets", async () => {
    await touch();
    const turns = await fetchAntigravityUsage({ credentials: credentialDeps(env("turns")) });
    expect(turns).toEqual({ status: "error", message: "agy /usage failed" });

    await touch();
    const missing = await fetchAntigravityUsage({ credentials: credentialDeps(env("no-buckets")) });
    expect(missing).toEqual({ status: "error", message: "agy /usage failed" });
  });

  it("stops a not-signed-in agy when stderr asks for authentication", async () => {
    await touch();
    const started = Date.now();
    const result = await fetchAntigravityUsage({ credentials: credentialDeps(env("auth-stderr")) });
    expect(result).toEqual({ status: "signed_out" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reads the not-signed-in JSON error as signed_out and any other error as error", async () => {
    await touch();
    const signedOut = await fetchAntigravityUsage({ credentials: credentialDeps(env("auth-json")) });
    expect(signedOut).toEqual({ status: "signed_out" });

    await touch();
    const other = await fetchAntigravityUsage({ credentials: credentialDeps(env("other-error")) });
    expect(other).toEqual({ status: "error", message: "agy /usage failed" });
  });
});
