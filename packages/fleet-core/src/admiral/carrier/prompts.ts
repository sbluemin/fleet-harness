/**
 * fleet/carrier/prompts.ts — carriers_sortie 프롬프트 / 스키마 관리 (Tier 1 · Tier 2)
 *
 * Tier 1: carriers_sortie 도구 등록에 필요한 프롬프트 메타데이터와 TypeBox 파라미터 스키마.
 * Tier 2: carrier 메타데이터(permissions, principles, outputFormat)를 원본 request에
 *         주입하여 최종 request를 조립하는 유틸리티.
 *
 * 구조:
 *  Tier 1 — 상수 프롬프트 / build 함수 / 내부 헬퍼
 *  Tier 2 — composeTier2Request / buildDirectiveSection
 */

import { Type, type TObject } from "@sinclair/typebox";
import { SYSTEM_REMINDER_HINT } from "./constants.js";
import type { ToolPromptManifest } from "../../services/tool-registry/index.js";
import { getRegisteredCarrierConfig } from "./framework.js";
import type { CarrierMetadata } from "./types.js";

// ═════════════════════════════════════════════════════════
// Tier 1 — carriers_sortie 도구 프롬프트 / 스키마
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 공유 타입
// ─────────────────────────────────────────────────────────

/** carriers_sortie 도구의 단일 carrier 배정 항목 */
export interface CarrierAssignment {
  carrier: string;
  request: string;
}

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
// 1. 상수 프롬프트
// ─────────────────────────────────────────────────────────

/**
 * carriers_sortie 도구 설명 (Tool Schema — LLM이 도구 선택 시 참조).
 * registerTool의 `description` 필드에 전달됩니다.
 */
export const SORTIE_MANIFEST: ToolPromptManifest = {
  id: "carriers_sortie",
  tag: "carriers_sortie",
  title: "carriers_sortie Tool Guidelines",
  description:
    `Register fire-and-forget carrier jobs for task execution — single or multiple(parallel).` +
    ` This is the only tool for delegating tasks to carrier agents.` +
    ` It returns a job_id immediately; results arrive through [carrier:result] push; carrier_jobs is fallback/explicit lookup only.` +
    ` Use it whenever you want to delegate implementation, analysis, exploration, or any coding task to one or more carriers.` +
    ` Always bundle all intended carriers into one call — never split a parallel batch into multiple sequential calls.`,
  promptSnippet:
    `carriers_sortie — Register 1+ carrier jobs for task delegation. Results arrive later via [carrier:result]; carrier_jobs is fallback/explicit lookup only.`,
  whenToUse: [
    `carriers_sortie is the only way to delegate tasks to carrier agents.` +
      ` Always use this tool — never attempt to invoke carriers directly.`,
    `You can launch a single carrier or multiple carriers in parallel — when launching multiple carriers, you MUST include all of them in a single carriers_sortie call.` +
      ` This tool provides unified progress tracking and registers detached work; carrier_jobs is fallback/explicit lookup only.`,
  ],
  whenNotToUse: [],
  usageGuidelines: [
    `carriers_sortie requires an expected_carrier_count field that MUST be set BEFORE filling the carriers array.` +
      ` Decide the total number of carriers you plan to launch first, write that number into expected_carrier_count, then fill the carriers array to match.` +
      ` The system will immediately hard-error if expected_carrier_count does not equal the actual carriers array length — the call will be rejected and you must resubmit with the correct count and all intended carriers.` +
      ` If a previous carriers_sortie call failed, retry with ALL originally intended carriers if the cause was a validation error or transient issue; if an inactive or unregistered carrier caused the failure, review alternatives or ask for clarification before retrying.`,
    `When composing a carrier request, provide only background, context, objective, and constraints.` +
      ` Do NOT prescribe implementation details or step-by-step instructions — trust the carrier's own reasoning.` +
      ` Use the Tags listed for each carrier to structure your request.`,
    `Each carrier ID may appear at most once per carriers_sortie call.` +
      ` Duplicate carrier IDs in the same call are rejected by the system and cause the entire sortie to fail.` +
      ` If you need two different workloads handled by carriers of the same type, assign each to a different carrier ID within the same call's carriers array.`,
    `Launch response schema is { job_id, accepted, error? } and never includes synchronous result content.` +
      ` Full output is available only through carrier_jobs(action:"result", format:"full"), is finalized-only, and remains read-many for 3h.`,
    `Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done.` +
      ` Continue independent work if available; otherwise stop tool use and wait passively for the [carrier:result] follow-up push.`,
    `Structure each carrier request using that carrier's required tags listed in <fleet section="roster">; missing required tags cause hard-error rejection by the dispatcher.`,
  ],
  guardrails: [
    `Multiple agents may be working on this codebase at the same time on a single filesystem and branch.` +
      ` Only touch changes you made — never revert or overwrite modifications made by others.` +
      ` Prefer precise edits (edit) over full-file writes (write).` +
      ` Always re-read a file before modifying it, as it may have changed since your last read.`,
  ],
};

export const FLEET_SORTIE_DESCRIPTION = SORTIE_MANIFEST.description;

// ─────────────────────────────────────────────────────────
// 2. Build 함수
// ─────────────────────────────────────────────────────────

/**
 * carriers_sortie의 `promptSnippet` 값을 반환합니다.
 * 시스템 프롬프트 "Available tools" 섹션에 한 줄로 표시됩니다.
 */
export function buildSortieToolPromptSnippet(): string {
  return SORTIE_MANIFEST.promptSnippet;
}

/**
 * carriers_sortie의 `promptGuidelines` 배열을 반환합니다.
 *
 * 고정 3개 항목 + 등록된 carrier별 설명을 동적으로 합산하여
 * 시스템 프롬프트 "Guidelines" 섹션에 주입될 최종 배열을 구성합니다.
 *
 * @param carrierIds sortie 가능한 carrier ID 목록
 */
export function buildSortieToolPromptGuidelines(): string[] {
  return [
    ...SORTIE_MANIFEST.whenToUse,
    ...SORTIE_MANIFEST.whenNotToUse,
    ...SORTIE_MANIFEST.usageGuidelines,
    ...(SORTIE_MANIFEST.guardrails ?? []),
  ];
}

/**
 * carriers_sortie의 TypeBox `parameters` 스키마를 반환합니다.
 *
 * enabledIds를 기반으로 `carrier` 파라미터의 description을 동적으로 조합하여
 * LLM이 가용한 carrier ID를 정확히 파악할 수 있도록 합니다.
 *
 * @param enabledIds sortie 가능한 carrier ID 목록
 */
export function buildSortieToolSchema(enabledIds: string[]): TObject {
  const availableDesc =
    enabledIds.length > 0
      ? `Carrier ID to sortie. Available: ${enabledIds.join(", ")}`
      : `Carrier ID to sortie. (No carriers currently available)`;

  return Type.Object({
    expected_carrier_count: Type.Integer({
      minimum: 1,
      description:
        "Number of carriers you intend to launch in this call. " +
        "Set this FIRST before composing the carriers array. " +
        "Must exactly equal the length of the carriers array — a mismatch is a hard error and the call will be rejected.",
    }),
    carriers: Type.Array(
      Type.Object({
        carrier: Type.String({
          description: availableDesc,
        }),
        request: Type.String({
          description: "The task/prompt to send to this carrier",
        }),
      }),
      {
        minItems: 1,
        description:
          "Array of carrier assignments. Length must equal expected_carrier_count. " +
          "When launching multiple carriers in parallel, ALL intended carriers MUST be listed together here in a SINGLE fire-and-forget job registration call — never split a parallel batch into multiple sequential calls. " +
          "Example (single): [{\"carrier\": \"genesis\", \"request\": \"...\"}] " +
          "Example (parallel): [{\"carrier\": \"sentinel\", \"request\": \"...\"}, {\"carrier\": \"genesis\", \"request\": \"...\"}] " +
          "MUST be a native JSON array [...], NOT a stringified JSON string.",
      },
    ),
  });
}

/**
 * 캐리어 출격 시 시스템 프롬프트로 1회 주입되는 컨텍스트.
 * <system-reminder> 태그의 의미를 캐리어에게 알린다.
 */
export function buildCarrierSystemPrompt(): string {
  return SYSTEM_REMINDER_HINT.trim();
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
 * Admiral 시스템 프롬프트, sortie/squadron/taskforce promptGuidelines
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
