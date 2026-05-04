/**
 * carriers/vanguard — Vanguard carrier (CVN-06)
 * @specialization 정찰 스페셜리스트 — 코드베이스 탐색 · 심볼 추적 · 웹 리서치 특화
 *
 * Vanguard carrier를 프레임워크에 등록합니다.
 */

import { CARRIER_JOBS_SELF_CALL_HINT } from "../prompts.js";
import type { CarrierMetadata } from "../types.js";

export const CARRIER_METADATA: CarrierMetadata = {
  // ── Tier 1: Routing ──
  title: "Captain · Scout Specialist",
  summary: "Fast reconnaissance — codebase exploration, symbol tracing, web research. As the Captain (함장) of this Carrier, Vanguard leads forward scouting and fast intelligence gathering before heavier operations begin.",
  category: "operations",
  whenToUse: [
    "codebase reconnaissance — exploration, multi-file scanning, symbol tracing",
    "web research and external knowledge gathering",
    "preparation for heavier operations (Nimitz, Genesis, Kirov) requiring local intelligence first",
  ],
  whenNotToUse: [
    "ANY code modification or file editing (→genesis)",
    "GitHub repo deep-dives (→tempest)",
  ],
  requestBlocks: [
    { tag: "objective", hint: "What intelligence is needed — question to answer or target to locate.", required: true },
    { tag: "search_space", hint: "Directories, files, URLs, or domains to focus the search on.", required: false },
    { tag: "hints", hint: "Known symbols, keywords, file patterns, or prior findings to narrow the scan.", required: false },
    { tag: "depth", hint: "'quick' for surface scan, 'thorough' for exhaustive. Default: 'medium'.", required: false },
  ],

  // ── Tier 2: Composition ──
  permissions: [
    "CRITICAL: Strictly read-only. NEVER modify files, write code, or execute mutating commands under any circumstances.",
    "Full access to read the codebase and execute read-only commands for exploration.",
    "If the request fails (timeout/connection error), retry up to 3 times before reporting failure.",
  ],
  outputFormat:
    `Report findings as a structured reconnaissance report.\n` +
    `[Required] always include:\n` +
    `  **Thoroughness** — quick / medium / thorough (indicate scan depth performed).\n` +
    `  **Findings** — Organized list of discoveries. For code exploration:\n` +
    `    - Use absolute file paths with line references (e.g., /abs/path/file.ts:42).\n` +
    `    - Group by relevance — most important findings first.\n` +
    `[If applicable] omit if not relevant:\n` +
    `  **Key observations** — 3-5 bullets stating factual patterns or anomalies discovered. Strictly descriptive — no recommendations, no inferred intent, no suggested actions.\n` +
    `Keep the report concise — bullets and short lines only. No narrative paragraphs. Never suggest follow-up actions; routing decisions belong to the orchestrator.`,
  principles: [
    CARRIER_JOBS_SELF_CALL_HINT,
    "When reporting code exploration, always use absolute file paths for direct actionability.",
  ],
};
