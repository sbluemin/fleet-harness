import * as prompts from "./prompts.js";
import * as requestDirectiveExecute from "./request-directive-execute.js";
import * as types from "./types.js";
import { buildRequestDirectiveToolSpec } from "./tool-spec.js";

export * from "./prompts.js";
export * from "./request-directive-execute.js";
export * from "./types.js";

export { buildRequestDirectiveToolSpec } from "./tool-spec.js";

export const requestDirective = {
  prompts,
  requestDirectiveExecute,
  types,
  buildToolSpec: buildRequestDirectiveToolSpec,
};
