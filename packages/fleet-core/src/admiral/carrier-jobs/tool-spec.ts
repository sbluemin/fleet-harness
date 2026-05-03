import type { AgentToolSpec } from "../../infra/tool-registry/types.js";
import { registerToolPromptManifest } from "../../infra/tool-registry/index.js";
import { dispatchCarrierJobsAction } from "./dispatch.js";
import {
  CARRIER_JOBS_DESCRIPTION,
  CARRIER_JOBS_MANIFEST,
  buildCarrierJobsPromptGuidelines,
  buildCarrierJobsPromptSnippet,
  buildCarrierJobsSchema,
} from "./prompts.js";
import type { CarrierJobsParams } from "./types.js";

export function buildCarrierJobsToolSpec(): AgentToolSpec {
  registerToolPromptManifest(CARRIER_JOBS_MANIFEST);

  return {
    name: "carrier_jobs",
    label: "Carrier Jobs",
    description: CARRIER_JOBS_DESCRIPTION,
    promptSnippet: buildCarrierJobsPromptSnippet(),
    promptGuidelines: buildCarrierJobsPromptGuidelines(),
    parameters: buildCarrierJobsSchema(),
    async execute(args: unknown) {
      const result = dispatchCarrierJobsAction(args as CarrierJobsParams);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: false,
        details: result,
      };
    },
  };
}
