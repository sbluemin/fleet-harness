import { agent } from "./agent/index.js";
import * as carrier from "./carrier/index.js";
import * as carrierJobs from "./carrier-jobs/index.js";
import * as constants from "../constants.js";
import * as mcp from "./mcp.js";
import * as prompts from "./prompts.js";
import * as protocols from "./protocols/index.js";
import * as squadron from "./squadron/index.js";
import * as store from "./store/index.js";
import * as taskforce from "./taskforce/index.js";

export * from "./prompts.js";
export * from "./protocols/index.js";
export * from "./protocols/standing-orders/index.js";

export const admiral = {
  agent,
  carrier,
  squadron,
  taskforce,
  carrierJobs,
  protocols,
  store,
  mcp,
  prompts,
  constants,
};
