import * as store from "./store.js";
import * as types from "./types.js";
import { getLogAPI } from "./store.js";
import { DEFAULT_LOG_CATEGORY } from "./types.js";

export * from "./types.js";
export * from "./store.js";

export const log = {
  ...store,
  store,
  types,
  DEFAULT_LOG_CATEGORY,
  getLogAPI,
};
