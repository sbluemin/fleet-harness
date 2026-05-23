import { agent } from "./agent/index.js";
import { carrier, carrierJobs, store, taskforce } from "@sbluemin/fleet-carriers";
import * as constants from "../constants.js";
import * as mcp from "./mcp.js";
import * as prompts from "./prompts.js";
import * as protocols from "./protocols/index.js";

export * from "./prompts.js";
export * from "./protocols/index.js";
export * from "./protocols/standing-orders/index.js";

export const admiral = {
  agent,
  carrier,
  taskforce,
  carrierJobs,
  protocols,
  store,
  mcp,
  prompts,
  constants,
};
