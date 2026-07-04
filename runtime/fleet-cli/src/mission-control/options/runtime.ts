import { resolveSessionOptions } from "./resolver.js";
import type { CreateSessionOptionsRuntimeOptions, ResolvedSessionOptions, SessionOptions, SessionOptionsRuntime } from "./types.js";

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
