import * as agent from "./agent/index.js";
import { auth } from "./auth/index.js";
import { dataDir } from "./data-dir/index.js";
import { log } from "./log/index.js";
import * as preset from "./preset/index.js";
import { settings } from "./settings/index.js";
import {
  executorPortRuntime,
  sessionRuntime,
  type ExecutorPortRuntime,
  type SessionRuntime,
} from "./agent/index.js";
import { createCoreLogStore, type CoreLogStore } from "./log/store.js";
import { createPresetService, type PresetService } from "./preset/index.js";
import { createSettingsRuntime, type SettingsRuntime } from "./settings/runtime.js";

export interface InfraServices {
  agent: typeof agent;
  auth: typeof auth;
  dataDir: typeof dataDir;
  log: typeof log;
  preset: typeof preset;
  settings: typeof settings;
  executorPortRuntime: ExecutorPortRuntime;
  settingsRuntime: SettingsRuntime;
  sessionRuntime: SessionRuntime;
  coreLogStore: CoreLogStore;
  presetService: PresetService;
}

export interface InfraServicesDeps {}

export * from "./agent/index.js";
export * from "./auth/index.js";
export * from "./data-dir/index.js";
export * from "./settings/index.js";
export * from "./log/index.js";
export * from "./preset/index.js";

export const infra = {
  agent,
  auth,
  dataDir,
  log,
  preset,
  settings,
};

export function createInfraServices(_deps: InfraServicesDeps = {}): InfraServices {
  const settingsRuntime = createSettingsRuntime();
  const presetService = createPresetService();

  return {
    agent,
    auth,
    dataDir,
    log,
    preset,
    settings,
    executorPortRuntime,
    settingsRuntime,
    sessionRuntime,
    coreLogStore: createCoreLogStore({ settingsRuntime }),
    presetService,
  };
}
