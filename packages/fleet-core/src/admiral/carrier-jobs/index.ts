import * as dispatch from "./dispatch.js";
import * as prompts from "./prompts.js";
import { buildCarrierJobsToolSpec } from "./tool-spec.js";
import * as types from "./types.js";
import {
  registerStreamHandler,
  unregisterStreamHandler,
} from "../_shared/carrier-job-events.js";
import * as streamingEvents from "../_shared/carrier-job-events.js";

export * from "./dispatch.js";
export * from "./prompts.js";
export { buildCarrierJobsToolSpec } from "./tool-spec.js";
export * from "./types.js";

export const streaming = {
  ...streamingEvents,
  register: registerStreamHandler,
  unregister: unregisterStreamHandler,
};

export const carrierJobs = {
  dispatch,
  prompts,
  types,
  buildToolSpec: buildCarrierJobsToolSpec,
  streaming,
};
