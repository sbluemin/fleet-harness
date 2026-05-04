import { directiveRefinement } from "./directive-refinement/index.js";
import { operationName } from "./operation-name/index.js";
import * as prompts from "./prompts.js";
import * as worldview from "./worldview.js";

export * from "./prompts.js";
export * from "./worldview.js";
export * from "./operation-name/compose.js";
export * from "./directive-refinement/execute.js";
export * as operationNameConstants from "./operation-name/constants.js";
export * as operationNamePrompts from "./operation-name/prompts.js";
export * as operationNameSettings from "./operation-name/settings.js";
export * as directiveRefinementConstants from "./directive-refinement/constants.js";
export * as directiveRefinementExecute from "./directive-refinement/execute.js";
export * as directiveRefinementPrompts from "./directive-refinement/prompts.js";
export * as directiveRefinementSettings from "./directive-refinement/settings.js";

export const metaphor = {
  prompts,
  worldview,
  operationName,
  directiveRefinement,
};
