import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { DedicatedCliDefinition, DedicatedCliProfileOptions } from "../types.js";
import { createCodexEnv } from "./env.js";

export const codexCli: DedicatedCliDefinition = {
  defaultBin: "codex",
  envOverrideName: "CODEX_BIN",
  id: "codex",
  label: "Codex",
  createProfile(options: DedicatedCliProfileOptions) {
    return {
      args: [],
      bin: resolveBinary("codex", "CODEX_BIN", options.env),
      cwd: options.cwd,
      env: createChildEnv(options.env, createCodexEnv()),
      id: "codex",
      label: "Codex",
      terminalName: "xterm-256color",
    };
  },
};

