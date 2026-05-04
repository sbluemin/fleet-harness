/**
 * fleet/carrier/prompts.ts — 개별 캐리어 도구 프롬프트 / Tier 1 · Tier 2
 *
 * Tier 1: 개별 캐리어 도구(carrier_<id>) 등록에 필요한 프롬프트 메타데이터와 TypeBox 파라미터 스키마.
 * Tier 2: carrier 메타데이터(carrier identity · permissions · principles · outputFormat)를
 *         carrier 세션의 systemPrompt 본문에 주입한다. 매 sendMessage 마다 반복 전송하지 않고,
 *         systemPrompt 영역에서 한 번만 전송 + provider prompt caching 활용.
 *
 * 구조:
 *  Tier 1 — buildCarrierToolDoctrine / buildCarrierRoster / 내부 헬퍼
 *  Tier 2 — buildCarrierSystemPrompt(metadata)
 */

import { Type } from "@sinclair/typebox";
import { getRegisteredCarrierConfig } from "./framework.js";
import type { CarrierMetadata } from "./types.js";

const CARRIER_FLEET_BACKGROUND = String.raw`You are an autonomous agent (Carrier) operating within a coordinated multi-agent Fleet system. The Admiral, your superior, dispatches specialized tasks to you and synthesizes your output for the user. Below is your identity, operational permissions, behavioral principles, and required output format. Your assigned task arrives in the user message channel below.`;

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
// Tier 1 — 개별 캐리어 도구 프롬프트 / 스키마
// ═════════════════════════════════════════════════════════

export function buildCarrierToolDoctrine(
  carrierId: string,
  displayName: string,
  metadata: CarrierMetadata,
) {
  return {
    id: `carrier_${carrierId}`,
    tag: `carrier_${carrierId}`,
    title: `${displayName} Tool Guidelines`,
    description:
      `Register a fire-and-forget carrier job for ${displayName} (${metadata.title}).` +
      ` Returns a job_id immediately; results arrive through [carrier:result] push; carrier_jobs is fallback/explicit lookup only.`,
    promptSnippet:
      `carrier_${carrierId} — Register a ${displayName} carrier job for task delegation.` +
      ` Results arrive later via [carrier:result]; carrier_jobs is fallback/explicit lookup only.`,
    whenToUse: [
      `carrier_${carrierId} is the tool for delegating tasks to ${displayName} (${metadata.title}).` +
        ` Use it when: ${metadata.whenToUse.join(", ")}.`,
    ],
    whenNotToUse: metadata.whenNotToUse.map((item) =>
      `Do NOT use carrier_${carrierId} when: ${item}.`,
    ),
    usageGuidelines: [
      `When composing a request for ${displayName}, provide only background, context, objective, and constraints.` +
        ` Do NOT prescribe implementation details or step-by-step instructions — trust the carrier's own reasoning.`,
      `Launch response schema is { job_id, accepted, error? } and never includes synchronous result content.` +
        ` Full output is available only through carrier_jobs(action:"result", format:"full"), is finalized-only, and remains read-many for 3h.`,
      `Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done.` +
        ` Continue independent work if available; otherwise stop tool use and wait passively for the [carrier:result] follow-up push.`,
      ...buildRequestBlockGuidelines(carrierId, metadata),
    ],
    guardrails: [
      `Multiple agents may be working on this codebase at the same time on a single filesystem and branch.` +
        ` Only touch changes you made — never revert or overwrite modifications made by others.` +
        ` Prefer precise edits (edit) over full-file writes (write).` +
        ` Always re-read a file before modifying it, as it may have changed since your last read.`,
    ],
  };
}

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

export function buildCarrierToolSchema() {
  return Type.Object({
    request: Type.String({
      description: "The task/prompt to send to this carrier",
    }),
  });
}

// ═════════════════════════════════════════════════════════
// 내부 헬퍼
// ═════════════════════════════════════════════════════════

export function formatRequestBlocksGuide(meta: CarrierMetadata): string[] {
  if (meta.requestBlocks.length === 0) return [];
  return meta.requestBlocks.map((b) => {
    const sig = b.required ? `<${b.tag}>` : `<${b.tag}?>`;
    const label = b.required ? "required" : "optional";
    return `  - ${sig} ${label}: ${b.hint}`;
  });
}

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
      if (extraLines) {
        const extras = extraLines(carrierId, undefined);
        for (const e of extras) lines.push(e);
      }
      continue;
    }

    const name = config.displayName;
    lines.push(`- **${carrierId}** (${name} · ${meta.title}): ${meta.summary}`);
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

function buildRequestBlockGuidelines(
  carrierId: string,
  metadata: CarrierMetadata,
): string[] {
  if (metadata.requestBlocks.length === 0) return [];
  const requiredBlocks = metadata.requestBlocks.filter((b) => b.required);
  if (requiredBlocks.length === 0) return [];

  const tags = requiredBlocks.map((b) => `<${b.tag}>`).join(", ");
  return [
    `Structure your request using required tags: ${tags}.` +
      ` Missing required tags cause hard-error rejection by the dispatcher.`,
  ];
}

