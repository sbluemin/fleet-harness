import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { DedicatedCliDefinition, DedicatedCliProfileOptions } from "../types.js";
import { createGeminiEnv } from "./env.js";

export const geminiCli: DedicatedCliDefinition = {
  defaultBin: "gemini",
  envOverrideName: "GEMINI_BIN",
  id: "gemini",
  label: "Gemini",
  createProfile(options: DedicatedCliProfileOptions) {
    return {
      args: [],
      bin: resolveBinary("gemini", "GEMINI_BIN", options.env),
      cwd: options.cwd,
      env: createChildEnv(options.env, createGeminiEnv()),
      id: "gemini",
      label: "Gemini",
      terminalName: "xterm-256color",
    };
  },
};

