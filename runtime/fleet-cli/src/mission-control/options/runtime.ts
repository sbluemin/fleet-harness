import type { AgentCliId } from "@dotobokuri/fleet-admiral";
import type { GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/core-infra/data-dir/settings";

import type { FleetCliOptions } from "../../cli-args.js";

export type SessionOptionSource = "arg" | "env" | "global-options" | "default" | "session";

export interface SessionOptions {
  readonly cliId: AgentCliId;
  readonly model?: string;
  readonly enableMetaphor: boolean;
}

export interface ResolvedSessionOptions {
  readonly values: SessionOptions;
  readonly sources: Record<keyof SessionOptions, SessionOptionSource>;
}

export interface SessionOptionsResolverInput {
  readonly argv: FleetCliOptions;
  readonly cliIdOverride?: AgentCliId;
  readonly defaults: SessionOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly globalOptions: GlobalOptionsData;
  readonly parseCliId: (value: string | undefined) => AgentCliId | undefined;
}

export interface SessionOptionsRuntime {
  readonly getResolved: () => ResolvedSessionOptions;
  readonly getDraft: () => SessionOptions;
  readonly getStatusLines: () => readonly string[];
  readonly selectCli: (cliId: AgentCliId) => void;
  readonly toggleEnableMetaphor: () => void;
  readonly setModel: (model: string | undefined) => void;
}

export interface CreateSessionOptionsRuntimeOptions {
  readonly argv: FleetCliOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly globalOptionsService: GlobalOptionsService;
  readonly defaults: SessionOptions;
  readonly onStatusChange?: () => void;
  readonly parseCliId: (value: string | undefined) => AgentCliId | undefined;
}

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

type SessionOptionsField = keyof SessionOptions;

export function createSessionOptionsRuntime(options: CreateSessionOptionsRuntimeOptions): SessionOptionsRuntime {
  let globalOptions = options.globalOptionsService.load();
  let resolved = resolve();
  let sessionFields = new Set<SessionOptionsField>();
  let draft: SessionOptions = { ...resolved.values };
  let statusLines: readonly string[] = [];

  return {
    getResolved: () => toDraftResolved(),
    getDraft: () => draft,
    getStatusLines: () => statusLines,
    selectCli: (cliId) => {
      const previousDraft = draft;
      const nextResolved = resolveForCli(cliId);
      resolved = nextResolved;
      draft = {
        ...nextResolved.values,
        ...Object.fromEntries([...sessionFields]
          .filter((field) => field !== "cliId")
          .map((field) => [field, previousDraft[field]])),
        cliId,
      } as SessionOptions;
      markSession("cliId");
    },
    toggleEnableMetaphor: () => updateBoolean("enableMetaphor", !draft.enableMetaphor),
    setModel: (model) => {
      draft = { ...draft, model: model && model.length > 0 ? model : undefined };
      markSession("model");
    },
  };

  function resolve(): ResolvedSessionOptions {
    return resolveSessionOptions({
      argv: options.argv,
      defaults: options.defaults,
      env: options.env,
      globalOptions,
      parseCliId: options.parseCliId,
    });
  }

  function resolveForCli(cliId: SessionOptions["cliId"]): ResolvedSessionOptions {
    return resolveSessionOptions({
      argv: options.argv,
      cliIdOverride: cliId,
      defaults: {
        ...options.defaults,
        cliId,
      },
      env: options.env,
      globalOptions,
      parseCliId: options.parseCliId,
    });
  }

  function markSession(field: SessionOptionsField): void {
    sessionFields = new Set(sessionFields).add(field);
  }

  function persistGlobalOptions(field: "enableMetaphor", value: boolean): void {
    statusLines = [];
    void Promise.resolve()
      .then(() => {
        globalOptions = options.globalOptionsService.update((current) => ({ ...current, [field]: value }));
      })
      .catch((error: unknown) => {
        statusLines = [`Save failed: ${formatSaveError(error)}`];
      })
      .finally(() => {
        options.onStatusChange?.();
      });
  }

  function toDraftResolved(): ResolvedSessionOptions {
    return {
      sources: {
        ...resolved.sources,
        ...Object.fromEntries([...sessionFields].map((field) => [field, "session"])),
      } as ResolvedSessionOptions["sources"],
      values: draft,
    };
  }

  function updateBoolean(field: "enableMetaphor", value: boolean): void {
    globalOptions = { ...globalOptions, [field]: value };
    resolved = resolve();
    draft = { ...draft, [field]: value };
    markSession(field);
    persistGlobalOptions(field, value);
  }
}

function formatSaveError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Failed to save Fleet options.";
}
