import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { DedicatedCliDefinition, DedicatedCliProfileOptions } from "../types.js";
import { createClaudeEnv } from "./env.js";

export const claudeCli: DedicatedCliDefinition = {
  defaultBin: "claude",
  envOverrideName: "CLAUDE_BIN",
  id: "claude",
  label: "Claude",
  createProfile(options: DedicatedCliProfileOptions) {
    const { bin, prefixArgs } = resolveBinary("claude", "CLAUDE_BIN", options.env);
    return {
      args: [...prefixArgs],
      bin,
      cwd: options.cwd,
      env: createChildEnv(options.env, createClaudeEnv()),
      id: "claude",
      label: "Claude",
      messagePolicy: {
        bracketedPaste: true,
        lineTerminator: "\r",
        multilineStrategy: "paste-mode",
      },
      terminalName: "xterm-256color",
    };
  },
};
