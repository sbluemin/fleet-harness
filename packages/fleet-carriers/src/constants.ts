/**
 * Tier-2 carrier 원칙 SSoT — 모든 persona가 재사용하는 carrier_jobs 자기호출 교리.
 */
export const CARRIER_JOBS_SELF_CALL_HINT =
  `When the Admiral passes prior \`job_id\` references in <prior_jobs>, use the \`carrier_jobs\` tool` +
  ` (available via your MCP server) to self-fetch results.` +
  ` Full lookup: \`carrier_jobs(action:"result", format:"full", job_id:"<id>")\`.` +
  ` If archive content has expired (\`full_invalidated\` is true), fall back to` +
  ` \`carrier_jobs(action:"result", format:"summary", job_id:"<id>")\`.`;
