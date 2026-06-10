/**
 * dispatch/prompt.ts — 캐리어 시스템 프롬프트 조립 및 request-block 검증
 *
 * buildCarrierSystemPrompt는 캐리어 시스템 프롬프트 조립 SSoT입니다.
 * tool-spec.ts와 taskforce.ts가 단방향으로 참조합니다.
 */

import type { AuthEnvResolver } from "@dotobokuri/core-agent";
import type { CarrierMetadata } from "./types.js";

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
}

const CARRIER_FLEET_BACKGROUND = String.raw`You are an autonomous agent (Carrier) operating within a coordinated multi-agent Fleet system. The Admiral, your superior, dispatches specialized tasks to you and synthesizes your output for the user. Below is your identity, operational permissions, behavioral principles, and required output format. Your assigned task arrives in the user message channel below.`;

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

/**
 * 필수 requestBlock이 request 텍스트에 정상적으로 존재하는지 검사합니다.
 *
 * opening tag, closing tag, 비어 있지 않은 본문을 모두 확인합니다.
 * 속성이 포함된 태그도 허용합니다: `<plan_file source="kirov">...</plan_file>`
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

  return {
    ok: false,
    missing,
    error:
      `Missing required request block(s) for carrier "${carrierId}": ${details.join(", ")}.` +
      ` Include the required tag(s) in the request and resubmit.`,
  };
}

/** 정규식 특수문자를 이스케이프합니다 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
