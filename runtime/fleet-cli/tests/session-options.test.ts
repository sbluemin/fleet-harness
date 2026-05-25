import { describe, expect, it } from "vitest";

import { parseAgentCliId } from "../src/agent-cli/registry.js";
import { parseFleetCliOptions } from "../src/cli-args.js";
import { resolveSessionOptions } from "../src/mission-control/options/resolver.js";
import { createSessionOptionsRuntime } from "../src/mission-control/options/runtime.js";
import type { SessionOptions } from "../src/mission-control/options/types.js";

const DEFAULTS: SessionOptions = {
  cliId: "claude",
  cursorSync: true,
  enableMetaphor: false,
  native: false,
  replaceSystemPrompt: true,
};

describe("session options resolver", () => {
  it("resolves argv over env over preset over defaults", () => {
    const resolved = resolveSessionOptions({
      argv: parseFleetCliOptions(["-n", "-rsp", "-em", "--disable-cursor-sync"], {}),
      cliIdOverride: "codex",
      defaults: DEFAULTS,
      env: {
        FLEET_AGENT_CLI: "claude-kimi",
        FLEET_CURSOR_SYNC: "1",
        FLEET_ENABLE_METAPHOR: "0",
        FLEET_NATIVE: "0",
        FLEET_REPLACE_SYSTEM_PROMPT: "0",
      },
      parseCliId: parseAgentCliId,
      preset: {
        version: 1,
        defaultCliId: "claude-zai",
        byCli: {
          codex: {
            cursorSync: true,
            enableMetaphor: false,
            model: "preset-model",
            native: false,
            replaceSystemPrompt: false,
          },
        },
      },
    });

    expect(resolved.values).toEqual({
      cliId: "codex",
      cursorSync: false,
      enableMetaphor: true,
      model: "preset-model",
      native: true,
      replaceSystemPrompt: false,
    });
    expect(resolved.sources).toEqual({
      cliId: "arg",
      cursorSync: "arg",
      enableMetaphor: "arg",
      model: "preset",
      native: "arg",
      replaceSystemPrompt: "arg",
    });
  });

  it("uses env above preset and preset above defaults", () => {
    const resolved = resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: { FLEET_AGENT_CLI: "codex", FLEET_CURSOR_SYNC: "0" },
      parseCliId: parseAgentCliId,
      preset: {
        version: 1,
        defaultCliId: "claude-zai",
        byCli: {
          codex: {
            enableMetaphor: true,
            model: "preset-model",
            native: true,
            replaceSystemPrompt: true,
          },
        },
      },
    });

    expect(resolved.values).toEqual({
      cliId: "codex",
      cursorSync: false,
      enableMetaphor: true,
      model: "preset-model",
      native: true,
      replaceSystemPrompt: true,
    });
    expect(resolved.sources).toMatchObject({
      cliId: "env",
      cursorSync: "env",
      enableMetaphor: "preset",
      model: "preset",
    });
  });

  it("ignores invalid preset default CLI IDs", () => {
    const presetResolved = resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      parseCliId: parseAgentCliId,
      preset: { version: 1, defaultCliId: "evil", byCli: {} },
    });

    expect(presetResolved.values.cliId).toBe("claude");
    expect(presetResolved.sources.cliId).toBe("default");
  });

  it("rejects invalid env CLI IDs", () => {
    expect(() => resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: { FLEET_AGENT_CLI: "evil" },
      parseCliId: parseAgentCliId,
      preset: { version: 1, byCli: {} },
    })).toThrow('Unsupported agent CLI "evil"');
  });

  it("does not mutate process.env while resolving", () => {
    const before = { ...process.env };

    resolveSessionOptions({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: { FLEET_CURSOR_SYNC: "0" },
      parseCliId: parseAgentCliId,
      preset: { version: 1, byCli: {} },
    });

    expect(process.env).toEqual(before);
  });
});

describe("session options runtime", () => {
  it("saves only when S promotion path calls saveDraft", async () => {
    const calls: unknown[] = [];
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      parseCliId: parseAgentCliId,
      presetService: {
        load: () => ({ version: 1, byCli: {} }),
        resolveCliPreset: () => ({}),
        resetCliPreset: () => ({ version: 1, byCli: {} }),
        saveCliPreset: () => ({ version: 1, byCli: {} }),
        saveDefaultCliId: () => ({ version: 1, byCli: {} }),
        update: (mutation) => {
          calls.push(mutation);
          return {
            version: 1,
            defaultCliId: "claude",
            byCli: { claude: { model: "draft-model", cursorSync: true, enableMetaphor: false, native: false, replaceSystemPrompt: false } },
          };
        },
      },
    });

    runtime.setModel("draft-model");
    expect(calls).toEqual([]);
    await runtime.saveDraft();

    expect(calls).toEqual([{
      defaultCliId: "claude",
      cliId: "claude",
      values: {
        cursorSync: true,
        enableMetaphor: false,
        model: "draft-model",
        native: false,
        replaceSystemPrompt: true,
      },
    }]);
  });

  it("marks draft edits as session source before save", () => {
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      parseCliId: parseAgentCliId,
      presetService: {
        load: () => ({ version: 1, byCli: {} }),
        resolveCliPreset: () => ({}),
        resetCliPreset: () => ({ version: 1, byCli: {} }),
        saveCliPreset: () => ({ version: 1, byCli: {} }),
        saveDefaultCliId: () => ({ version: 1, byCli: {} }),
        update: () => ({ version: 1, byCli: {} }),
      },
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

  it("re-seeds fields from the selected CLI preset while preserving session edits", () => {
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      parseCliId: parseAgentCliId,
      presetService: {
        load: () => ({
          version: 1,
          defaultCliId: "claude",
          byCli: {
            claude: {
              model: "opus",
              native: false,
              replaceSystemPrompt: true,
            },
            codex: {
              cursorSync: false,
              model: "gpt-5.4",
              native: true,
              replaceSystemPrompt: false,
            },
          },
        }),
        resolveCliPreset: () => ({}),
        resetCliPreset: () => ({ version: 1, byCli: {} }),
        saveCliPreset: () => ({ version: 1, byCli: {} }),
        saveDefaultCliId: () => ({ version: 1, byCli: {} }),
        update: () => ({ version: 1, byCli: {} }),
      },
    });

    expect(runtime.getResolved().values).toMatchObject({
      cliId: "claude",
      model: "opus",
      native: false,
      replaceSystemPrompt: true,
    });

    runtime.setModel("session-model");
    runtime.selectCli("codex");

    expect(runtime.getResolved().values).toMatchObject({
      cliId: "codex",
      cursorSync: false,
      model: "session-model",
      native: true,
      replaceSystemPrompt: false,
    });
    expect(runtime.getResolved().sources).toMatchObject({
      cliId: "session",
      cursorSync: "preset",
      model: "session",
      native: "preset",
      replaceSystemPrompt: "preset",
    });
  });

  it("R reset clears transient override view", () => {
    const runtime = createSessionOptionsRuntime({
      argv: parseFleetCliOptions([], {}),
      defaults: DEFAULTS,
      env: {},
      parseCliId: parseAgentCliId,
      presetService: {
        load: () => ({ version: 1, defaultCliId: "claude", byCli: { claude: { model: "preset-model" } } }),
        resolveCliPreset: () => ({}),
        resetCliPreset: () => ({ version: 1, byCli: {} }),
        saveCliPreset: () => ({ version: 1, byCli: {} }),
        saveDefaultCliId: () => ({ version: 1, byCli: {} }),
        update: () => ({ version: 1, byCli: {} }),
      },
    });

    runtime.setModel("session-model");
    expect(runtime.getResolved().values).toMatchObject({ model: "session-model" });
    runtime.resetOverrides();
    expect(runtime.getResolved().values).toMatchObject({ cliId: "claude", model: "preset-model" });
  });
});
