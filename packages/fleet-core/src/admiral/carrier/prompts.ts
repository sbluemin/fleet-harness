/**
 * carrier/prompts.ts — 캐리어 프롬프트 빌더
 *
 * buildCarrierRoster() — roster 섹션 렌더링
 * buildCarrierSystemPrompt() — 캐리어 세션 systemPrompt 본문 주입
 */

import { getRegisteredCarrierConfig } from "./framework.js";
import type { CarrierMetadata, RequestBlock } from "./types.js";

const CARRIER_FLEET_BACKGROUND = String.raw`You are an autonomous agent (Carrier) operating within a coordinated multi-agent Fleet system. The Admiral, your superior, dispatches specialized tasks to you and synthesizes your output for the user. Below is your identity, operational permissions, behavioral principles, and required output format. Your assigned task arrives in the user message channel below.`;

/** carrier_dispatch / carrier_squadron / carrier_taskforce의 공용 brevity 정책 SSoT — Host PI(Admiral)의 비대 request 안티패턴 억제. */
export const CARRIER_REQUEST_BREVITY_GUIDELINE =
  `Each request body MUST be ≤ ~300 words and each request block MUST be ≤ 5 sentences.` +
  ` MUST NOT paraphrase or copy your own analysis, reconnaissance output, or system-prompt content into the request.` +
  ` When referencing prior carrier work, pass the job_id(s) via <prior_jobs> instead of paraphrasing their output` +
  ` — the carrier will self-fetch full results using carrier_jobs(action:"result", format:"full", job_id:...).` +
  ` If archive content has expired (full_invalidated true / TTL exceeded), the carrier falls back to` +
  ` carrier_jobs(action:"result", format:"summary", job_id:...) to retrieve the summary.`;

/**
 * Tier-2 carrier 원칙 SSoT — 모든 persona가 spread 패턴으로 재사용하는 carrier_jobs 자기호출 교리.
 * 이 상수를 복사하지 말 것; persona의 principles 배열에 `[CARRIER_JOBS_SELF_CALL_HINT, ...existing]`으로 참조할 것.
 */
export const CARRIER_JOBS_SELF_CALL_HINT =
  `When the Admiral passes prior \`job_id\` references in <prior_jobs>, use the \`carrier_jobs\` tool` +
  ` (available via your MCP server) to self-fetch results.` +
  ` Full lookup: \`carrier_jobs(action:"result", format:"full", job_id:"<id>")\`.` +
  ` If archive content has expired (\`full_invalidated\` is true), fall back to` +
  ` \`carrier_jobs(action:"result", format:"summary", job_id:"<id>")\`.`;

/** <prior_jobs> 공용 요청 블록 — 로스터 렌더링 시 모든 carrier에 자동 합산되는 SSoT 선택 블록 */
export const PRIOR_JOBS_REQUEST_BLOCK: RequestBlock = {
  tag: "prior_jobs",
  hint: `Prior finalized carrier job IDs for context lookup. Fetch with carrier_jobs(action:"result", format:"full", job_id:...); use format:"summary" if archive content has expired.`,
  required: false,
};

/** 로스터 렌더링 시 모든 carrier에 공통 주입되는 기본 블록 목록 */
const CARRIER_COMMON_REQUEST_BLOCKS: RequestBlock[] = [PRIOR_JOBS_REQUEST_BLOCK];

// ═════════════════════════════════════════════════════════
// Types / Interfaces
// ═════════════════════════════════════════════════════════

/** buildCarrierRoster 호출 시 각 caller별 차이를 조정하는 옵션 */
export interface CarrierRosterOptions {
  /** 로스터 섹션 제목 (기본: "## Available Carriers") */
  heading?: string;
  /** 로스터 본문 앞에 추가할 안내 라인들 */
  preambleLines?: string[];
  /** 특정 carrierId에 대해 로스터 엔트리 뒤에 추가할 라인 생성기 */
  extraLines?: (carrierId: string, meta: CarrierMetadata | undefined) => string[];
}

// ═════════════════════════════════════════════════════════
// 캐리어 시스템 프롬프트 (Tier 2)
// ═════════════════════════════════════════════════════════

export function buildCarrierSystemPrompt(metadata?: CarrierMetadata): string {
  const parts: string[] = [CARRIER_FLEET_BACKGROUND];

  if (metadata) {
    parts.push(`<your_identity>\n${metadata.title}\n${metadata.summary}\n</your_identity>`);

    if (metadata.permissions.length > 0) {
      const body = metadata.permissions.map((item) => `- ${item}`).join("\n");
      parts.push(`<your_permissions>\n${body}\n</your_permissions>`);
    }

    const principles = metadata.principles ?? [];
    if (principles.length > 0) {
      const body = principles.map((item) => `- ${item}`).join("\n");
      parts.push(`<your_principles>\n${body}\n</your_principles>`);
    }

    if (metadata.outputFormat) {
      parts.push(`<output_format>\n${metadata.outputFormat.trim()}\n</output_format>`);
    }
  }

  return parts.join("\n\n");
}

// ═════════════════════════════════════════════════════════
// 로스터 렌더링
// ═════════════════════════════════════════════════════════

export function buildCarrierRoster(
  carrierIds: string[],
  options?: CarrierRosterOptions,
): string {
  const { heading, preambleLines, extraLines } = options ?? {};
  const lines: string[] = [];

  lines.push(heading ?? `## Available Carriers`);
  if (preambleLines) {
    for (const p of preambleLines) lines.push(p);
  }

  for (const carrierId of carrierIds) {
    const config = getRegisteredCarrierConfig(carrierId);
    if (!config) continue;

    const meta = config.carrierMetadata;
    if (!meta) {
      lines.push(`- **${carrierId}** (${config.displayName}): Delegate tasks to ${config.displayName}.`);
      lines.push(`  carrier_id: "${carrierId}"`);
      if (extraLines) {
        const extras = extraLines(carrierId, undefined);
        for (const e of extras) lines.push(e);
      }
      continue;
    }

    const name = config.displayName;
    lines.push(`- **${carrierId}** (${name} · ${meta.title}): ${meta.summary}`);
    lines.push(`  carrier_id: "${carrierId}"`);
    lines.push(`  Use for: ${meta.whenToUse.join(", ")}.`);
    if (meta.whenNotToUse.length > 0) {
      lines.push(`  NOT for:`);
      for (const item of meta.whenNotToUse) {
        lines.push(`    - ${item}`);
      }
    }
    const blockLines = formatRequestBlocksGuide(meta);
    if (blockLines.length > 0) {
      lines.push(`  Request blocks — wrap content in these (? = optional):`);
      lines.push(...blockLines);
    }
    if (extraLines) {
      const extras = extraLines(carrierId, meta);
      for (const e of extras) lines.push(e);
    }
  }

  return lines.join("\n");
}

export function formatRequestBlocksGuide(meta: CarrierMetadata): string[] {
  const allBlocks: RequestBlock[] = [
    ...meta.requestBlocks,
    ...(meta.commonRequestBlocks ?? []),
    ...CARRIER_COMMON_REQUEST_BLOCKS,
  ];
  if (allBlocks.length === 0) return [];
  return allBlocks.map((b) => {
    const sig = b.required ? `<${b.tag}>` : `<${b.tag}?>`;
    const label = b.required ? "required" : "optional";
    return `  - ${sig} ${label}: ${b.hint}`;
  });
}
