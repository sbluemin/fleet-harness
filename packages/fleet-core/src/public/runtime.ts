import {
  resetServiceStatus,
} from "@sbluemin/unified-agent";
import { initStore } from "../admiral/store/fleet-store.js";
import { initRuntime as initAgentSessionRuntime } from "../admiral/agent/internal/session-runtime.js";
import {
  initSettingsService,
  resetSettingsService,
} from "../services/settings/runtime.js";
import { SettingsService } from "../services/settings/service.js";
import { setFleetCoreBootMode } from "../runtime-flags.js";
import {
  createFleetServices,
  shutdownFleetMcp,
  type FleetServices,
} from "./fleet-services.js";
import {
  createGrandFleetServices,
  type GrandFleetServices,
} from "./grand-fleet-services.js";
import {
  createJobServices,
  type FleetJobServices,
} from "./job-services.js";
import {
  createLogServices,
  type FleetLogServices,
} from "./log-services.js";
import {
  createMetaphorServices,
  type FleetMetaphorServices,
} from "./metaphor-services.js";
import {
  createSettingsServices,
  type FleetSettingsServices,
} from "./settings-services.js";

export type { FleetServices } from "./fleet-services.js";
export type { GrandFleetServices } from "./grand-fleet-services.js";
export type { FleetJobServices } from "./job-services.js";
export type { FleetLogServices } from "./log-services.js";
export type { FleetMetaphorServices } from "./metaphor-services.js";
export type { FleetSettingsServices } from "./settings-services.js";

export interface FleetCoreRuntimeOptions {
  readonly dataDir: string;
  readonly bootMode?: "dev" | "normal";
}

export interface FleetCoreRuntimeContext {
  readonly fleet: FleetServices;
  readonly grandFleet: GrandFleetServices;
  readonly metaphor: FleetMetaphorServices;
  readonly jobs: FleetJobServices;
  readonly log: FleetLogServices;
  readonly settings: FleetSettingsServices;
  shutdown(): Promise<void>;
}

export function createFleetCoreRuntime(
  options: FleetCoreRuntimeOptions,
): FleetCoreRuntimeContext {
  setFleetCoreBootMode(options.bootMode ?? "normal");
  initAgentSessionRuntime(options.dataDir);
  initStore(options.dataDir);
  const settings = new SettingsService();
  initSettingsService(settings);

  let fleet: FleetServices;
  try {
    fleet = createFleetServices();
  } catch (error) {
    resetSettingsService(settings);
    throw error;
  }

  resetServiceStatus();

  return {
    fleet,
    grandFleet: createGrandFleetServices(),
    metaphor: createMetaphorServices(),
    jobs: createJobServices(),
    log: createLogServices(),
    settings: createSettingsServices(settings),
    async shutdown() {
      await shutdownFleetMcp();
      resetSettingsService(settings);
      resetServiceStatus();
    },
  };
}
