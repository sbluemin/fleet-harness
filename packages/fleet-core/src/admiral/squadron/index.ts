import * as prompts from "./prompts.js";
import * as squadronExecute from "./squadron-execute.js";
import * as types from "./types.js";
import { buildSquadronToolSpec } from "./tool-spec.js";

export * from "./prompts.js";
export * from "./squadron-execute.js";
export * from "./types.js";

export { buildSquadronToolSpec } from "./tool-spec.js";

export const squadron = {
  prompts,
  squadronExecute,
  types,
  buildToolSpec: buildSquadronToolSpec,
};
