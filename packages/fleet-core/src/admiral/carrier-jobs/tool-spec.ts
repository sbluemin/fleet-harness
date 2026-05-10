import type { AgentToolSpec } from "../agent/types.js";
import { dispatchCarrierJobsAction } from "./dispatch.js";
import {
  CARRIER_JOBS_DOCTRINE,
  buildCarrierJobsSchema,
} from "./prompts.js";
import type { CarrierJobsParams } from "./types.js";

export function buildCarrierJobsToolSpec(): AgentToolSpec {
  return {
    ...CARRIER_JOBS_DOCTRINE,
    parameters: buildCarrierJobsSchema(),
    async execute(args: unknown) {
      const result = dispatchCarrierJobsAction(args as CarrierJobsParams);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        isError: false,
        details: result,
      };
    },
  };
}
