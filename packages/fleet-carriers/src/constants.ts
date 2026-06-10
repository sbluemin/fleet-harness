import { CLI_BACKENDS, getProviderModels } from "@dotobokuri/core-unified-agent";
import type { CliType } from "@dotobokuri/core-unified-agent";
import type { RequestBlock } from "./dispatch/types.js";

// CLI_DISPLAY_NAMES 조립 전용 내부 사본 — 공개 표면은 CLI_DISPLAY_NAMES만 유지한다.
const CLI_PROVIDER_DISPLAY_NAMES: Record<CliType, string> = Object.fromEntries(
  Object.keys(CLI_BACKENDS).map((cliType) => [
    cliType,
    getProviderModels(cliType as CliType).name,
  ]),
) as Record<CliType, string>;

const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  genesis: "Genesis",
  sentinel: "Sentinel",
  vanguard: "Vanguard",
};

export const CLI_DISPLAY_NAMES: Record<string, string> = {
  ...CLI_PROVIDER_DISPLAY_NAMES,
  ...CARRIER_DISPLAY_NAMES,
};

/**
 * Tier-2 carrier 원칙 SSoT — 모든 persona가 재사용하는 carrier_jobs 자기호출 교리.
 */
export const CARRIER_JOBS_SELF_CALL_HINT =
  `When the Admiral passes prior \`job_id\` references in <prior_jobs>, use the \`carrier_jobs\` tool` +
  ` (available via your MCP server) to self-fetch results.` +
  ` Full lookup: \`carrier_jobs(action:"result", format:"full", job_id:"<id>")\`.` +
  ` If archive content has expired (\`full_invalidated\` is true), fall back to` +
  ` \`carrier_jobs(action:"result", format:"summary", job_id:"<id>")\`.`;

/** <prior_jobs> 공용 요청 블록 — 모든 persona가 requestBlocks에 명시 첨부하는 선택 블록 */
export const PRIOR_JOBS_REQUEST_BLOCK: RequestBlock = {
  tag: "prior_jobs",
  hint: `Prior finalized carrier job IDs for context lookup. Fetch with carrier_jobs(action:"result", format:"full", job_id:...); use format:"summary" if archive content has expired.`,
  required: false,
};
