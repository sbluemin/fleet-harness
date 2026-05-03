/**
 * fleet/carrier/prompts.ts — 개별 캐리어 도구 프롬프트 / Tier 1 · Tier 2
 *
 * Tier 1: 개별 캐리어 도구(carrier_<id>) 등록에 필요한 프롬프트 메타데이터와 TypeBox 파라미터 스키마.
 * Tier 2: carrier 메타데이터(permissions, principles, outputFormat)를 원본 request에
 *         주입하여 최종 request를 조립하는 유틸리티.
 *
 * 구조:
 *  Tier 1 — buildCarrierToolManifest / buildCarrierRoster / 내부 헬퍼
 *  Tier 2 — composeTier2Request / buildDirectiveSection
 */

import { Type } from "@sinclair/typebox";
import { SYSTEM_REMINDER_HINT } from "./constants.js";
import type { ToolPromptManifest } from "../../infra/tool-registry/index.js";
import { getRegisteredCarrierConfig } from "./framework.js";
import type { CarrierMetadata } from "./types.js";

// ═════════════════════════════════════════════════════════
// Tier 1 — 개별 캐리어 도구 프롬프트 / 스키마
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 공유 타입
// ─────────────────────────────────────────────────────────

/** buildCarrierRoster 호출 시 각 caller별 차이를 조정하는 옵션 */
export interface CarrierRosterOptions {
  /** 로스터 섹션 제목 (기본: "## Available Carriers") */
  heading?: string;
  /** 로스터 본문 앞에 추가할 안내 라인들 */
  preambleLines?: string[];
  /** 특정 carrierId에 대해 로스터 엔트리 뒤에 추가할 라인 생성기 */
  extraLines?: (carrierId: string, meta: CarrierMetadata | undefined) => string[];
}

// ─────────────────────────────────────────────────────────
// 1. 개별 캐리어 도구 Manifest 빌더
// ─────────────────────────────────────────────────────────

/**
 * CarrierMetadata에서 개별 캐리어 도구의 ToolPromptManifest를 생성합니다.
 * metadata의 Tier 1 필드를 사용하여 manifest의 description, whenToUse, whenNotToUse,
 * usageGuidelines, guardrails를 생성합니다.
 */
export function buildCarrierToolManifest(
  carrierId: string,
  displayName: string,
  metadata: CarrierMetadata,
): ToolPromptManifest {
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

/**
 * 캐리어 출격 시 시스템 프롬프트로 1회 주입되는 컨텍스트.
 * <system-reminder> 태그의 의미를 캐리어에게 알린다.
 */
export function buildCarrierSystemPrompt(): string {
  return SYSTEM_REMINDER_HINT.trim();
}

/**
 * 개별 캐리어 도구의 TypeBox `parameters` 스키마를 반환합니다.
 */
export function buildCarrierToolSchema() {
  return Type.Object({
    request: Type.String({
      description: "The task/prompt to send to this carrier",
    }),
  });
}

// ─────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * requestBlock 메타데이터를 compact multiline 가이드로 렌더링합니다.
 * Tier 1 routing 프롬프트 전용 — Tier 2 composition과는 독립적입니다.
 *
 * @returns 빈 배열 (requestBlocks가 없거나 모두 빈 태그인 경우)
 */
export function formatRequestBlocksGuide(meta: CarrierMetadata): string[] {
  if (meta.requestBlocks.length === 0) return [];
  return meta.requestBlocks.map((b) => {
    const sig = b.required ? `<${b.tag}>` : `<${b.tag}?>`;
    const label = b.required ? "required" : "optional";
    return `  - ${sig} ${label}: ${b.hint}`;
  });
}

/**
 * 등록된 carrier들의 CarrierMetadata Tier 1 정보를 읽어
 * compact roster 문자열을 생성합니다.
 *
 * 이 함수가 모든 carrier 로스터 렌더링의 SSoT입니다.
 * Admiral 시스템 프롬프트, squadron/taskforce promptGuidelines
 * 모두 이 함수를 통해 로스터를 생성합니다.
 *
 * @param carrierIds 렌더링할 carrier ID 목록
 * @param options heading, preambleLines, extraLines로 caller별 차이를 조정
 */
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
    // request-block 가이드 — 태그 서명 + hint 텍스트
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

/**
 * 개별 캐리어 도구의 usageGuidelines에 포함할 request-block 가이드라인을 생성합니다.
 */
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

// ═════════════════════════════════════════════════════════
// Tier 2 — request 조립 (permissions · principles · outputFormat 주입)
// ═════════════════════════════════════════════════════════

/**
 * Tier 2 자동 주입: 각 섹션을 묶어 단일 텍스트로 합친 후, 최종적으로
 * 전체 내용을 `<system-reminder>` 태그로 감싸서 반환합니다.
 * XML 래핑 책임은 이 함수가 일원적으로 보유하므로
 * carrier metadata의 `outputFormat`은 순수 내용만 담고 태그 래핑은 여기서 수행합니다.
 *
 * 주입 순서 (LLM의 primacy bias 활용):
 *  1. 원본 요청 (최상단, 가장 중요, 태그 없이 배치)
 *  2. `<permissions>` — 운영 권한/제약
 *  3. `<principles>` — 핵심 원칙
 *  4. `<output_format>` — 출력 형식 가이드 (최하단)
 */
export function composeTier2Request(metadata: CarrierMetadata, originalRequest: string): string {
  const parts: string[] = [];

  // 1. 원본 요청 — 최상단
  parts.push(originalRequest);

  // 2. 운영 권한/제약
  if (metadata.permissions.length > 0) {
    const body = metadata.permissions.map((item) => `- ${item}`).join("\n");
    parts.push(`<permissions>\n${body}\n</permissions>`);
  }

  // 3. 핵심 원칙
  const principles = metadata.principles ?? [];
  if (principles.length > 0) {
    const body = principles.map((item) => `- ${item}`).join("\n");
    parts.push(`<principles>\n${body}\n</principles>`);
  }

  // 4. 출력 형식 — 최하단
  if (metadata.outputFormat) {
    parts.push(`<output_format>\n${metadata.outputFormat.trim()}\n</output_format>`);
  }

  const composedContent = parts.join("\n\n");
  return `<system-reminder>\n${composedContent}\n</system-reminder>`;
}
