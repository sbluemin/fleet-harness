import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { DedicatedCliDefinition, DedicatedCliProfileOptions } from "../types.js";
import { createCodexEnv } from "./env.js";

export const codexCli: DedicatedCliDefinition = {
  defaultBin: "codex",
  envOverrideName: "CODEX_BIN",
  id: "codex",
  label: "Codex",
  async createProfile(options: DedicatedCliProfileOptions) {
    const { bin, prefixArgs } = resolveBinary("codex", "CODEX_BIN", options.env);
    return {
      args: [...prefixArgs, ...buildModelArgs(options.model)],
      bin,
      cwd: options.cwd,
      env: createChildEnv(options.env, createCodexEnv()),
      id: "codex",
      label: "Codex",
      messagePolicy: {
        bracketedPaste: true,
        lineTerminator: "\r",
        multilineStrategy: "paste-mode",
      },
      terminalName: "xterm-256color",
    };
  },
};

function buildModelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
}
