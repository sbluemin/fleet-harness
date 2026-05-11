import * as framework from "./framework.js";
import * as frameworkAccess from "./framework-access.js";
import * as overlayTypes from "./overlay-types.js";
import * as personas from "./personas/index.js";
import * as prompts from "./prompts.js";
import * as sortieExecute from "./sortie-execute.js";
import * as statusOverlayController from "./status-overlay-controller.js";
import * as types from "./types.js";
import { buildCarrierDispatchToolSpec } from "./tool-spec.js";

export * from "./framework.js";
export * from "./framework-access.js";
export * from "./overlay-types.js";
export * from "./personas/index.js";
export * from "./prompts.js";
export * from "./sortie-execute.js";
export * from "./status-overlay-controller.js";
export * from "./types.js";

export { buildCarrierDispatchToolSpec } from "./tool-spec.js";
export { personas };

export const carrier = {
  ...framework,
  framework,
  frameworkAccess,
  overlayTypes,
  personas,
  prompts,
  sortieExecute,
  statusOverlayController,
  types,
  buildToolSpecs: buildCarrierDispatchToolSpec,
};
