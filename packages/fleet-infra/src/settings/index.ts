import { SettingsService } from "./service.js";
import {
  getSettingsService,
  initSettingsService,
  resetSettingsService,
} from "./runtime.js";
import * as runtime from "./runtime.js";
import * as store from "./store.js";
import * as types from "./types.js";

import type { CoreSettingsAPI } from "./types.js";

export * from "./types.js";
export * from "./store.js";
export * from "./runtime.js";
export { SettingsService } from "./service.js";

export function create(): CoreSettingsAPI {
  return new SettingsService();
}

export const settings = {
  create,
  runtime,
  store,
  types,
  getSettingsService,
  initSettingsService,
  resetSettingsService,
};
