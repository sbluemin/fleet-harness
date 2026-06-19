import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildConsoleAttentionHookCommand, buildConsoleAutoNameHookCommand, buildConsoleCaptureHookCommand } from "../src/terminal/host-hooks.js";

describe("console terminal host hooks", () => {
  it("builds capture hook commands for JavaScript entries without a tsx loader", () => {
    const exec = buildConsoleCaptureHookCommand({
      entryPath: "/app/fleet-console/dist/cli.mjs",
      execPath: "/usr/local/bin/node",
    }, "claude");

    expect(exec).toEqual({
      command: "/usr/local/bin/node",
      args: ["/app/fleet-console/dist/cli.mjs", "hook", "capture-session", "claude"],
    });
  });

  it("builds capture hook commands for TypeScript entries with a tsx loader", () => {
    const exec = buildConsoleCaptureHookCommand({
      entryPath: "/app/fleet-console/src/cli.ts",
      execPath: "/usr/local/bin/node",
      tsxLoaderPath: "/app/fleet-console/node_modules/tsx/dist/loader.mjs",
    }, "codex");

    expect(exec).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "--import",
        pathToFileURL("/app/fleet-console/node_modules/tsx/dist/loader.mjs").href,
        "/app/fleet-console/src/cli.ts",
        "hook",
        "capture-session",
        "codex",
      ],
    });
  });

  it("builds attention hook commands for the input-waiting signal", () => {
    const exec = buildConsoleAttentionHookCommand({
      entryPath: "/app/fleet-console/dist/cli.mjs",
      execPath: "/usr/local/bin/node",
    });

    expect(exec).toEqual({
      command: "/usr/local/bin/node",
      args: ["/app/fleet-console/dist/cli.mjs", "hook", "attention"],
    });
  });

  it("builds auto-name hook commands for the operation auto-naming signal", () => {
    const exec = buildConsoleAutoNameHookCommand({
      entryPath: "/app/fleet-console/dist/cli.mjs",
      execPath: "/usr/local/bin/node",
    });

    expect(exec).toEqual({
      command: "/usr/local/bin/node",
      args: ["/app/fleet-console/dist/cli.mjs", "hook", "auto-name"],
    });
  });
});
