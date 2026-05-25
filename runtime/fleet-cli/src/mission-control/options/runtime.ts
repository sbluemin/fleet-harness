import { resolveSessionOptions, toPresetFragment } from "./resolver.js";
import type { CreateSessionOptionsRuntimeOptions, ResolvedSessionOptions, SessionOptions, SessionOptionsRuntime } from "./types.js";

type SessionOptionsField = keyof SessionOptions;

export function createSessionOptionsRuntime(options: CreateSessionOptionsRuntimeOptions): SessionOptionsRuntime {
  let preset = options.presetService.load();
  let resolved = resolve();
  let sessionFields = new Set<SessionOptionsField>();
  let draft: SessionOptions = { ...resolved.values };

  return {
    getResolved: () => toDraftResolved(),
    getDraft: () => draft,
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
    toggleNative: () => {
      draft = { ...draft, native: !draft.native };
      markSession("native");
    },
    toggleReplaceSystemPrompt: () => {
      draft = { ...draft, replaceSystemPrompt: !draft.replaceSystemPrompt };
      markSession("replaceSystemPrompt");
    },
    toggleEnableMetaphor: () => {
      draft = { ...draft, enableMetaphor: !draft.enableMetaphor };
      markSession("enableMetaphor");
    },
    toggleCursorSync: () => {
      draft = { ...draft, cursorSync: !draft.cursorSync };
      markSession("cursorSync");
    },
    setModel: (model) => {
      draft = { ...draft, model: model && model.length > 0 ? model : undefined };
      markSession("model");
    },
    saveDraft: async () => {
      preset = options.presetService.update({
        defaultCliId: draft.cliId,
        cliId: draft.cliId,
        values: toPresetFragment(draft),
      });
      resolved = resolve();
      sessionFields = new Set();
      draft = { ...resolved.values };
      return resolved;
    },
    resetOverrides: () => {
      preset = options.presetService.load();
      resolved = resolveWithoutArg();
      sessionFields = new Set();
      draft = { ...resolved.values };
    },
  };

  function resolve(): ResolvedSessionOptions {
    return resolveSessionOptions({
      argv: options.argv,
      defaults: options.defaults,
      env: options.env,
      parseCliId: options.parseCliId,
      preset,
    });
  }

  function resolveWithoutArg(): ResolvedSessionOptions {
    return resolveSessionOptions({
      argv: {
        ...options.argv,
        argvOverrides: {
          cursorSync: false,
        },
      },
      defaults: options.defaults,
      env: options.env,
      parseCliId: options.parseCliId,
      preset,
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
      parseCliId: options.parseCliId,
      preset,
    });
  }

  function markSession(field: SessionOptionsField): void {
    sessionFields = new Set(sessionFields).add(field);
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
}
