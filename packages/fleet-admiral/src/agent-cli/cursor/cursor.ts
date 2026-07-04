import { createChildEnv, resolveBinary } from "@dotobokuri/core-agent";

import type { AgentCliDefinition, AgentCliProfileOptions } from "../types.js";

export const cursorCli: AgentCliDefinition = {
  id: "cursor",
  label: "Cursor",
  async createProfile(options: AgentCliProfileOptions) {
    const { bin, prefixArgs } = resolveBinary("cursor-agent", "CURSOR_AGENT_BIN", options.env);
    return {
      args: [...prefixArgs, ...buildModelArgs(options.model)],
      bin,
      binPrefixArgs: prefixArgs,
      cwd: options.cwd,
      env: createChildEnv(options.env, {}),
      id: "cursor",
      label: "Cursor",
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
