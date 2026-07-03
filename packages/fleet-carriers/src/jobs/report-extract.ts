/**
 * jobs/report-extract.ts — 캐리어 최종 보고 블록 파서
 *
 * 캐리어 출력에서 마지막 완결된 <report>...</report> 블록을 추출합니다.
 * 소문자 report, 속성 없는 태그만 인정합니다.
 */

const REPORT_OPEN = "<report>";
const REPORT_CLOSE = "</report>";

/**
 * 텍스트에서 마지막 완결된 <report>...</report> 블록의 본문(트림)을 반환합니다.
 *
 * - 열림/닫힘 쌍이 완결되지 않으면 null.
 * - 빈 본문(공백만)이면 null (폴백 유도).
 * - 대소문자: 정확히 소문자 `report`만 인정.
 * - 속성 없는 태그만 인정 (`<report>` 리터럴 매칭).
 */
export function extractFinalReport(text: string): string | null {
  const openLen = REPORT_OPEN.length;
  const closeLen = REPORT_CLOSE.length;

  let lastBodyStart = -1;
  let lastBodyEnd = -1;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const openIdx = text.indexOf(REPORT_OPEN, searchFrom);
    if (openIdx === -1) break;
    const bodyStart = openIdx + openLen;
    const closeIdx = text.indexOf(REPORT_CLOSE, bodyStart);
    if (closeIdx === -1) break; // 미완결 — 이전까지 찾은 마지막 완결 블록으로 귀환
    lastBodyStart = bodyStart;
    lastBodyEnd = closeIdx;
    searchFrom = closeIdx + closeLen;
  }

  if (lastBodyStart === -1) return null;
  const body = text.slice(lastBodyStart, lastBodyEnd).trim();
  if (!body) return null;
  return body;
}
