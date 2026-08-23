import { createGlobalOptionsService, type GlobalOptionsService } from "./data-dir/settings/store.js";

export interface InfraServices {
  globalOptionsService: GlobalOptionsService;
}

export * from "./data-dir/paths.js";
export * from "./fs-store/index.js";
export * from "./workspace-dir/workspace-dir.js";
export {
  createGlobalOptionsService,
  createGlobalOptionsStore,
  sanitizeGlobalOptionsData,
} from "./data-dir/settings/store.js";
export type {
  ClaudeCodeSystemPromptMode,
  GlobalOptionsData,
  GlobalOptionsService,
  GlobalOptionsStore,
  GlobalOptionsValidationResult,
} from "./data-dir/settings/store.js";

export function createInfraServices(): InfraServices {
  return {
    globalOptionsService: createGlobalOptionsService(),
  };
}
