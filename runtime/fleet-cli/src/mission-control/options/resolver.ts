import type { FleetCliPreset } from "@dotobokuri/fleet-infra/preset";

import type { SessionOptions, SessionOptionsResolverInput, ResolvedSessionOptions, SessionOptionSource } from "./types.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function resolveSessionOptions(input: SessionOptionsResolverInput): ResolvedSessionOptions {
  const envCliId = input.parseCliId(input.env.FLEET_AGENT_CLI);
  const presetDefaultCliId = parsePresetCliId(input.parseCliId, input.preset.defaultCliId);
  const cliId = input.cliIdOverride ?? envCliId ?? presetDefaultCliId ?? input.defaults.cliId;
  const cliIdSource = sourceOf(
    input.cliIdOverride !== undefined,
    envCliId !== undefined,
    presetDefaultCliId !== undefined,
  );
  const cliPreset = input.preset.byCli[cliId] ?? {};

  return {
    values: {
      cliId,
      model: chooseString({
        arg: undefined,
        env: undefined,
        preset: cliPreset.model,
        fallback: input.defaults.model,
      }).value,
      native: chooseBoolean({
        arg: input.argv.argvOverrides.native ? input.argv.native : undefined,
        env: parseBooleanEnv(input.env.FLEET_NATIVE),
        preset: cliPreset.native,
        fallback: input.defaults.native,
      }).value,
      replaceSystemPrompt: chooseBoolean({
        arg: input.argv.argvOverrides.replaceSystemPrompt ? input.argv.replaceSystemPrompt : undefined,
        env: parseBooleanEnv(input.env.FLEET_REPLACE_SYSTEM_PROMPT),
        preset: cliPreset.replaceSystemPrompt,
        fallback: input.defaults.replaceSystemPrompt,
      }).value,
      enableMetaphor: chooseBoolean({
        arg: input.argv.argvOverrides.enableMetaphor ? input.argv.enableMetaphor : undefined,
        env: parseBooleanEnv(input.env.FLEET_ENABLE_METAPHOR),
        preset: cliPreset.enableMetaphor,
        fallback: input.defaults.enableMetaphor,
      }).value,
      cursorSync: chooseBoolean({
        arg: input.argv.argvOverrides.cursorSync ? input.argv.cursorSync : undefined,
        env: parseCursorSyncEnv(input.env.FLEET_CURSOR_SYNC),
        preset: cliPreset.cursorSync,
        fallback: input.defaults.cursorSync,
      }).value,
    },
    sources: {
      cliId: cliIdSource,
      model: chooseString({ arg: undefined, env: undefined, preset: cliPreset.model, fallback: input.defaults.model }).source,
      native: chooseBoolean({ arg: input.argv.argvOverrides.native ? input.argv.native : undefined, env: parseBooleanEnv(input.env.FLEET_NATIVE), preset: cliPreset.native, fallback: input.defaults.native }).source,
      replaceSystemPrompt: chooseBoolean({ arg: input.argv.argvOverrides.replaceSystemPrompt ? input.argv.replaceSystemPrompt : undefined, env: parseBooleanEnv(input.env.FLEET_REPLACE_SYSTEM_PROMPT), preset: cliPreset.replaceSystemPrompt, fallback: input.defaults.replaceSystemPrompt }).source,
      enableMetaphor: chooseBoolean({ arg: input.argv.argvOverrides.enableMetaphor ? input.argv.enableMetaphor : undefined, env: parseBooleanEnv(input.env.FLEET_ENABLE_METAPHOR), preset: cliPreset.enableMetaphor, fallback: input.defaults.enableMetaphor }).source,
      cursorSync: chooseBoolean({ arg: input.argv.argvOverrides.cursorSync ? input.argv.cursorSync : undefined, env: parseCursorSyncEnv(input.env.FLEET_CURSOR_SYNC), preset: cliPreset.cursorSync, fallback: input.defaults.cursorSync }).source,
    },
  };
}

export function toPresetFragment(options: SessionOptions): FleetCliPreset {
  return {
    ...(options.model !== undefined ? { model: options.model } : {}),
    native: options.native,
    replaceSystemPrompt: options.replaceSystemPrompt,
    enableMetaphor: options.enableMetaphor,
    cursorSync: options.cursorSync,
  };
}

function chooseBoolean(options: {
  readonly arg: boolean | undefined;
  readonly env: boolean | undefined;
  readonly preset: boolean | undefined;
  readonly fallback: boolean;
}): { readonly value: boolean; readonly source: SessionOptionSource } {
  if (options.arg !== undefined) return { value: options.arg, source: "arg" };
  if (options.env !== undefined) return { value: options.env, source: "env" };
  if (options.preset !== undefined) return { value: options.preset, source: "preset" };
  return { value: options.fallback, source: "default" };
}

function chooseString(options: {
  readonly arg: string | undefined;
  readonly env: string | undefined;
  readonly preset: string | undefined;
  readonly fallback: string | undefined;
}): { readonly value: string | undefined; readonly source: SessionOptionSource } {
  if (options.arg !== undefined) return { value: options.arg, source: "arg" };
  if (options.env !== undefined) return { value: options.env, source: "env" };
  if (options.preset !== undefined) return { value: options.preset, source: "preset" };
  return { value: options.fallback, source: "default" };
}

function sourceOf(hasArg: boolean, hasEnv: boolean, hasPreset: boolean): SessionOptionSource {
  if (hasArg) return "arg";
  if (hasEnv) return "env";
  if (hasPreset) return "preset";
  return "default";
}

function parseCursorSyncEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return parseBooleanEnv(value) ?? true;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function parsePresetCliId(
  parseCliId: (value: string | undefined) => SessionOptions["cliId"] | undefined,
  value: string | undefined,
): SessionOptions["cliId"] | undefined {
  try {
    return parseCliId(value);
  } catch {
    return undefined;
  }
}
