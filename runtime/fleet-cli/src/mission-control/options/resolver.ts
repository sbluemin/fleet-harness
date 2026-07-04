import type { ResolvedSessionOptions, SessionOptionSource, SessionOptionsResolverInput } from "./types.js";

type NonArgSessionOptionSource = Exclude<SessionOptionSource, "arg" | "session">;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function resolveSessionOptions(input: SessionOptionsResolverInput): ResolvedSessionOptions {
  const envCliId = input.parseCliId(input.env.FLEET_AGENT_CLI);
  const cliId = input.cliIdOverride ?? envCliId ?? input.defaults.cliId;
  const cliIdSource = input.cliIdOverride !== undefined ? "arg" : envCliId !== undefined ? "env" : "default";
  const enableMetaphor = chooseBooleanWithoutArg({
    env: parseBooleanEnv(input.env.FLEET_ENABLE_METAPHOR),
    globalOptions: input.globalOptions.enableMetaphor,
    fallback: input.defaults.enableMetaphor,
  });

  return {
    values: {
      cliId,
      model: input.defaults.model,
      enableMetaphor: enableMetaphor.value,
    },
    sources: {
      cliId: cliIdSource,
      model: "default",
      enableMetaphor: enableMetaphor.source,
    },
  };
}

function chooseBooleanWithoutArg(options: {
  readonly env: boolean | undefined;
  readonly globalOptions: boolean | undefined;
  readonly fallback: boolean;
}): { readonly value: boolean; readonly source: NonArgSessionOptionSource } {
  if (options.env !== undefined) return { value: options.env, source: "env" };
  if (options.globalOptions !== undefined) return { value: options.globalOptions, source: "global-options" };
  return { value: options.fallback, source: "default" };
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}
