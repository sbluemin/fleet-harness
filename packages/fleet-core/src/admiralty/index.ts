import * as ipc from "./ipc/protocol.js";
import * as prompts from "./prompts.js";
import * as reporter from "./reporter.js";
import * as runtimeAccess from "./runtime-access.js";
import * as statusSource from "./status-source.js";
import * as textSanitize from "./text-sanitize.js";
import * as toolSpecs from "./tool-specs.js";
import * as types from "./types.js";

export * from "./ipc/protocol.js";
export * from "./prompts.js";
export * from "./reporter.js";
export * from "./status-source.js";
export * from "./text-sanitize.js";
export * from "./tool-specs.js";
export * from "./types.js";
export * from "./runtime-access.js";

export const admiralty = {
  ipc,
  prompts,
  reporter,
  statusSource,
  textSanitize,
  toolSpecs,
  runtimeAccess,
  types,
};
