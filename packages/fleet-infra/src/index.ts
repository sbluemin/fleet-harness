import * as agent from "./agent/index.js";
import { auth } from "./auth/index.js";
import { dataDir } from "./data-dir/index.js";
import * as preset from "./preset/index.js";
import {
  executorPortRuntime,
  type ExecutorPortRuntime,
} from "./agent/index.js";
import { createPresetService, type PresetService } from "./preset/index.js";

export interface InfraServices {
  agent: typeof agent;
  auth: typeof auth;
  dataDir: typeof dataDir;
  preset: typeof preset;
  executorPortRuntime: ExecutorPortRuntime;
  presetService: PresetService;
}

export interface InfraServicesDeps {}

export * from "./agent/index.js";
export * from "./auth/index.js";
export * from "./data-dir/index.js";
export * from "./preset/index.js";

export const infra = {
  agent,
  auth,
  dataDir,
  preset,
};

export function createInfraServices(_deps: InfraServicesDeps = {}): InfraServices {
  const presetService = createPresetService();

  return {
    agent,
    auth,
    dataDir,
    preset,
    executorPortRuntime,
    presetService,
  };
}
