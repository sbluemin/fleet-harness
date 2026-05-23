/**
 * fleet/carrier/request-blocks.ts — required request-block 런타임 검증
 *
 * carrier 실행 도구의 dispatch 단계에서
 * 필수 requestBlock 태그가 사용자 request에 포함되어 있는지 검사합니다.
 * opening tag, closing tag, 그리고 비어 있지 않은 본문까지 확인합니다.
 */

import type { CarrierMetadata } from "./types.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

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
