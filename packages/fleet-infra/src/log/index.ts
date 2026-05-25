import * as store from "./store.js";
import * as types from "./types.js";
import { getLogAPI } from "./store.js";
import { readRecentLogFiles } from "./reader.js";
import { DEFAULT_LOG_CATEGORY } from "./types.js";

export * from "./types.js";
export * from "./store.js";
export * from "./reader.js";

export const log = {
  ...store,
  store,
  types,
  DEFAULT_LOG_CATEGORY,
  getLogAPI,
  readRecentLogFiles,
};
