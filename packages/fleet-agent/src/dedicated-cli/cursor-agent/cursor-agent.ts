import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { DedicatedCliDefinition, DedicatedCliProfileOptions } from "../types.js";
import { createCursorAgentEnv } from "./env.js";

export const cursorAgentCli: DedicatedCliDefinition = {
  defaultBin: "cursor-agent",
  envOverrideName: "CURSOR_AGENT_BIN",
  id: "cursor-agent",
  label: "Cursor Agent",
  createProfile(options: DedicatedCliProfileOptions) {
    return {
      args: [],
      bin: resolveBinary("cursor-agent", "CURSOR_AGENT_BIN", options.env),
      cwd: options.cwd,
      env: createChildEnv(options.env, createCursorAgentEnv()),
      id: "cursor-agent",
      label: "Cursor Agent",
      terminalName: "xterm-256color",
    };
  },
};

