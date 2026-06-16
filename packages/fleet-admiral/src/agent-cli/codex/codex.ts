import { createChildEnv, resolveBinary } from "@dotobokuri/core-agent";

import type { AgentCliDefinition, AgentCliProfileOptions } from "../types.js";

export const codexCli: AgentCliDefinition = {
  id: "codex",
  label: "Codex",
  // Codex CLI도 세션 이름 변경 슬래시 명령 `/rename`을 지원한다.
  renameCommand: "/rename",
  async createProfile(options: AgentCliProfileOptions) {
    const { bin, prefixArgs } = resolveBinary("codex", "CODEX_BIN", options.env);
    return {
      args: [...prefixArgs, "--no-alt-screen", ...buildModelArgs(options.model)],
      bin,
      binPrefixArgs: prefixArgs,
      cwd: options.cwd,
      env: createChildEnv(options.env, {}),
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
