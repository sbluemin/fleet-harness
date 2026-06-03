import { describe, expect, it } from "vitest";

import type { GlobalOptionsData } from "@dotobokuri/fleet-infra/global-options";
import { parseAgentCliId } from "../src/agent-cli/registry.js";
import { parseFleetCliOptions } from "../src/cli-args.js";
import { resolveSessionOptions } from "../src/mission-control/options/resolver.js";
import { createSessionOptionsRuntime } from "../src/mission-control/options/runtime.js";
import type { SessionOptions } from "../src/mission-control/options/types.js";

const DEFAULTS: SessionOptions = {
  cliId: "claude",
  enableMetaphor: false,
  native: false,
  replaceSystemPrompt: true,
};
const EMPTY_GLOBAL_OPTIONS = {
  version: 1 as const,
};

describe("session options resolver", () => {
  it("resolves env, global options, and defaults in priority order", () => {
    const resolved = resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      cliIdOverride: "codex",
      defaults: DEFAULTS,
      env: {
        FLEET_AGENT_CLI: "claude-kimi",
        FLEET_ENABLE_METAPHOR: "1",
        FLEET_NATIVE: "1",
        FLEET_REPLACE_SYSTEM_PROMPT: "0",
      },
      globalOptions: {
        version: 1,
        native: false,
        replaceSystemPrompt: true,
        enableMetaphor: false,
      },
      parseCliId: parseAgentCliId,
    });

    expect(resolved.values).toEqual({
      cliId: "codex",
      enableMetaphor: true,
      native: true,
      replaceSystemPrompt: false,
    });
    expect(resolved.sources).toEqual({
      cliId: "arg",
      enableMetaphor: "env",
      model: "default",
      native: "env",
      replaceSystemPrompt: "env",
    });
  });

  it("uses env CLI above the code default and ignores global options for CLI selection", () => {
    const resolved = resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: { FLEET_AGENT_CLI: "claude-kimi" },
      globalOptions: {
        version: 1,
        native: true,
        replaceSystemPrompt: true,
        enableMetaphor: true,
      },
      parseCliId: parseAgentCliId,
    });

    expect(resolved.values.cliId).toBe("claude-kimi");
    expect(resolved.sources.cliId).toBe("env");
    expect(resolved.sources.native).toBe("global-options");
  });

  it("rejects invalid env CLI IDs", () => {
    expect(() => resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: { FLEET_AGENT_CLI: "evil" },
      globalOptions: EMPTY_GLOBAL_OPTIONS,
      parseCliId: parseAgentCliId,
    })).toThrow('Unsupported agent CLI "evil"');
  });

  it("does not mutate process.env while resolving", () => {
    const before = { ...process.env };

    resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: { FLEET_NATIVE: "1" },
      globalOptions: EMPTY_GLOBAL_OPTIONS,
      parseCliId: parseAgentCliId,
    });

    expect(process.env).toEqual(before);
  });

  it("keeps runtime defaults for fresh empty global options", () => {
    const resolved = resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      globalOptions: EMPTY_GLOBAL_OPTIONS,
      parseCliId: parseAgentCliId,
    });

    expect(resolved.values.replaceSystemPrompt).toBe(true);
    expect(resolved.sources.replaceSystemPrompt).toBe("default");
  });
});

describe("session options runtime", () => {
  it("persists boolean toggles as field-merged global options without persisting model", async () => {
    const calls: unknown[] = [];
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      globalOptionsService: {
        load: () => EMPTY_GLOBAL_OPTIONS,
        save: (data) => {
          calls.push(data);
          return data;
        },
        update: (mutate) => {
          const next = mutate(EMPTY_GLOBAL_OPTIONS);
          calls.push(next);
          return next;
        },
      },
      parseCliId: parseAgentCliId,
    });

    runtime.setModel("draft-model");
    runtime.toggleNative();
    await Promise.resolve();

    expect(calls).toEqual([{
      version: 1,
      native: true,
    }]);
  });

  it("marks draft edits as session source before save completes", () => {
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      globalOptionsService: createMemoryGlobalOptionsService(),
      parseCliId: parseAgentCliId,
    });

    runtime.toggleEnableMetaphor();
    runtime.setModel("draft-model");

    expect(runtime.getResolved().values).toMatchObject({
      enableMetaphor: true,
      model: "draft-model",
    });
    expect(runtime.getResolved().sources).toMatchObject({
      enableMetaphor: "session",
      model: "session",
    });
  });

  it("re-seeds CLI from the selected session row while preserving session model", () => {
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      globalOptionsService: createMemoryGlobalOptionsService(),
      parseCliId: parseAgentCliId,
    });

    runtime.setModel("gpt-5.4");
    runtime.selectCli("codex");

    expect(runtime.getDraft()).toMatchObject({
      cliId: "codex",
      model: "gpt-5.4",
    });
    expect(runtime.getResolved().sources.cliId).toBe("session");
  });

  it("keeps the latest rapid toggle snapshot", async () => {
    const calls: unknown[] = [];
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      globalOptionsService: {
        load: () => EMPTY_GLOBAL_OPTIONS,
        save: (data) => {
          calls.push(data);
          return data;
        },
        update: (mutate) => {
          const current = (calls.at(-1) as GlobalOptionsData | undefined) ?? EMPTY_GLOBAL_OPTIONS;
          const next = mutate(current);
          calls.push(next);
          return next;
        },
      },
      parseCliId: parseAgentCliId,
    });

    runtime.toggleNative();
    runtime.toggleEnableMetaphor();
    await Promise.resolve();

    expect(calls.at(-1)).toEqual({
      version: 1,
      native: true,
      enableMetaphor: true,
    });
  });

  it("surfaces save failures without rolling back optimistic state", async () => {
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      globalOptionsService: {
        load: () => EMPTY_GLOBAL_OPTIONS,
        save: () => {
          throw new Error("disk full");
        },
        update: () => {
          throw new Error("disk full");
        },
      },
      parseCliId: parseAgentCliId,
    });

    runtime.toggleNative();
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getDraft().native).toBe(true);
    expect(runtime.getStatusLines()).toEqual(["Save failed: disk full"]);
  });
});

function createMemoryGlobalOptionsService() {
  let data: GlobalOptionsData = EMPTY_GLOBAL_OPTIONS;
  return {
    load: () => data,
    save: (next: GlobalOptionsData) => {
      data = next;
      return data;
    },
    update: (mutate: (current: GlobalOptionsData) => GlobalOptionsData) => {
      data = mutate(data);
      return data;
    },
  };
}
