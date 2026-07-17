/**
 * dispatch/prompt.ts — 캐리어 시스템 프롬프트 조립 및 request-block 검증
 *
 * buildCarrierSystemPrompt는 캐리어 시스템 프롬프트 조립 SSoT입니다.
 * tool-spec.ts와 taskforce.ts가 단방향으로 참조합니다.
 */

import type { AuthEnvResolver } from "@dotobokuri/core-agent";
import type { WorkspaceChangeScanner } from "../jobs/workspace-manifest.js";
import type { CarrierMetadata, RequestBlock } from "./types.js";

/** 검증 성공 결과 */
export interface RequiredBlockValidationOk {
  ok: true;
}

/** 검증 실패 결과 */
export interface RequiredBlockValidationFail {
  ok: false;
  missing: string[];
  error: string;
}

export type RequiredBlockValidationResult =
  | RequiredBlockValidationOk
  | RequiredBlockValidationFail;

export interface CarrierToolSpecDeps {
  readonly authEnvResolver: AuthEnvResolver;
  readonly reservedExternalMcpServerIds?: readonly string[];
  readonly workspaceChangeScanner?: WorkspaceChangeScanner;
}

const CARRIER_FLEET_BACKGROUND = String.raw`You are an autonomous agent (Carrier) operating within a coordinated multi-agent Fleet system. The Admiral, your superior, dispatches specialized tasks to you and synthesizes your output for the user. Below is your identity, operational permissions, behavioral principles, and required output format. Your assigned task arrives in the user message channel below.`;

// 모든 캐리어 공통 응답 프로토콜 — metadata 유무와 무관하게 항상 주입한다.
const COMMON_RESPONSE_PROTOCOL = `<response_protocol>
Keep progress narration concise — at most one line per meaningful step. No verbose play-by-play or step-by-step essays (short streaming lines are acceptable for the live observation channel).

When the mission is complete, wrap the entire final output in a <report>...</report> tag and emit it exactly once, at the very end. The Admiral retrieves only the report block, so everything you need to convey — results, evidence, file paths, caveats — must be inside it. Your persona's output_format structure applies inside the report block as usual.

Do not mention or demonstrate the literal opening and closing report tag anywhere in the body outside that final block.
</response_protocol>`;

// ═════════════════════════════════════════════════════════
// 캐리어 시스템 프롬프트 (Tier 2)
// ═════════════════════════════════════════════════════════

export function buildCarrierSystemPrompt(metadata?: CarrierMetadata): string {
  const parts: string[] = [CARRIER_FLEET_BACKGROUND, COMMON_RESPONSE_PROTOCOL];

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

/**
 * 필수 requestBlock이 request 텍스트에 정상적으로 존재하는지 검사합니다.
 *
 * opening tag, closing tag, 비어 있지 않은 본문을 모두 확인합니다.
 * 속성이 포함된 태그도 허용합니다: `<task_refs source="kirov">...</task_refs>`
 *
 * @param meta carrier 메타데이터
 * @param request 사용자 요청 텍스트
 * @param carrierId 검증 실패 시 에러 메시지에 포함할 carrier 식별자
 */
export function validateRequiredRequestBlocks(
  meta: CarrierMetadata,
  request: string,
  carrierId: string,
): RequiredBlockValidationResult {
  const required = meta.requestBlocks.filter((b) => b.required);
  if (required.length === 0) return { ok: true };

  const missing: string[] = [];
  const details: string[] = [];

  for (const block of required) {
    const escaped = escapeRegExp(block.tag);
    const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`);
    const match = regex.exec(request);
    if (!match) {
      missing.push(block.tag);
      details.push(`<${block.tag}> (missing closing tag)`);
    } else if (!match[1]?.trim()) {
      missing.push(block.tag);
      details.push(`<${block.tag}> (empty body)`);
    }
  }

  if (missing.length === 0) return { ok: true };

  // 자기회복 폴백: 거절 에러가 해당 캐리어의 블록 계약 전문을 되돌려줘,
  // 호출자가 계약을 미리 로드하지 않았어도 로컬 왕복 1회로 재작성할 수 있게 한다.
  return {
    ok: false,
    missing,
    error:
      `Missing required request block(s) for carrier "${carrierId}": ${details.join(", ")}.` +
      ` Compose the request with this carrier's request-block contract and resubmit:\n` +
      formatRequestBlocksGuide(meta).join("\n"),
  };
}

/** 캐리어 request-block 계약을 로스터/스킬/에러 공용 가이드 라인 목록으로 렌더한다. */
export function formatRequestBlocksGuide(meta: CarrierMetadata): string[] {
  const allBlocks: RequestBlock[] = [...meta.requestBlocks];
  if (allBlocks.length === 0) return [];
  return allBlocks.map((b) => {
    const sig = b.required ? `<${b.tag}>` : `<${b.tag}?>`;
    const label = b.required ? "required" : "optional";
    return `  - ${sig} ${label}: ${b.hint}`;
  });
}

/** 정규식 특수문자를 이스케이프합니다 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
