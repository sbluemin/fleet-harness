import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { DedicatedCliDefinition, DedicatedCliProfileOptions } from "../types.js";
import { createOpencodeEnv } from "./env.js";

export const opencodeCli: DedicatedCliDefinition = {
  defaultBin: "opencode",
  envOverrideName: "OPENCODE_BIN",
  id: "opencode",
  label: "OpenCode",
  createProfile(options: DedicatedCliProfileOptions) {
    return {
      args: [],
      bin: resolveBinary("opencode", "OPENCODE_BIN", options.env),
      cwd: options.cwd,
      env: createChildEnv(options.env, createOpencodeEnv()),
      id: "opencode",
      label: "OpenCode",
      terminalName: "xterm-256color",
    };
  },
};

