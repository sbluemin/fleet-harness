import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShellTerminalLaunchResolver, ensureNodePtySpawnHelpersExecutable } from "../server/shared/pty.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("createShellTerminalLaunchResolver", () => {
  it("advertises truecolor without replacing the compatible TERM entry", async () => {
    const resolve = createShellTerminalLaunchResolver({
      cwd: "/work",
      env: { COLORTERM: "256color", SHELL: "/bin/sh" } as NodeJS.ProcessEnv,
      platform: "linux",
    });

    const spec = await resolve();

    expect(spec.env).toMatchObject({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
  });
});

describe("ensureNodePtySpawnHelpersExecutable", () => {
  it("repairs the selected macOS spawn helper when install scripts left it non-executable", () => {
    const packageRoot = makePackageRoot();
    const helper = path.join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper");
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, "fixture", { mode: 0o644 });
    chmodSync(helper, 0o644);

    ensureNodePtySpawnHelpersExecutable(packageRoot, "darwin", "arm64");

    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it.each(["linux", "win32"] as const)("does not change helpers on %s", (platform) => {
    const packageRoot = makePackageRoot();
    const helper = path.join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper");
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, "fixture", { mode: 0o644 });
    chmodSync(helper, 0o644);

    ensureNodePtySpawnHelpersExecutable(packageRoot, platform, "arm64");

    expect(statSync(helper).mode & 0o777).toBe(0o644);
  });
});

function makePackageRoot(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-node-pty-"));
  temporaryDirectories.push(directory);
  return directory;
}
