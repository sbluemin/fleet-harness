import * as prompts from "./prompts.js";
import * as taskforceExecute from "./taskforce-execute.js";
import * as types from "./types.js";
import { buildTaskForceToolSpec } from "./tool-spec.js";

export * from "./prompts.js";
export * from "./taskforce-execute.js";
export * from "./types.js";

export { buildTaskForceToolSpec } from "./tool-spec.js";

export const taskforce = {
  prompts,
  taskforceExecute,
  types,
  buildToolSpec: buildTaskForceToolSpec,
};
