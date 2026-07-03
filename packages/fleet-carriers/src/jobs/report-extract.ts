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
 * 역방향 앵커: **마지막 열림 태그**부터 시도해 그 뒤 첫 닫힘 태그와 짝짓고,
 * 미완결이거나 본문이 비어 있으면 그 앞 열림 태그로 후퇴한다. 진짜 최종 보고는
 * 항상 출력 끝에 완결 쌍으로 오므로, 앞선 진행 텍스트에 미매칭 열림 태그가 실수로
 * 섞여 있어도(전진 탐색이라면 그 stray 열림이 진짜 닫힘과 짝지어져 결과를
 * 오염시킨다) 최종 블록만 격리 추출된다.
 *
 * - 완결되고 비어 있지 않은 쌍이 없으면 null (폴백 유도).
 * - 대소문자: 정확히 소문자 `report`만 인정.
 * - 속성 없는 태그만 인정 (`<report>` 리터럴 매칭).
 */
export function extractFinalReport(text: string): string | null {
  let openIdx = text.lastIndexOf(REPORT_OPEN);

  while (openIdx !== -1) {
    const bodyStart = openIdx + REPORT_OPEN.length;
    const closeIdx = text.indexOf(REPORT_CLOSE, bodyStart);
    if (closeIdx !== -1) {
      const body = text.slice(bodyStart, closeIdx).trim();
      if (body) return body;
    }
    // 미완결 또는 빈 본문 — 그 앞 열림 태그로 후퇴
    openIdx = openIdx === 0 ? -1 : text.lastIndexOf(REPORT_OPEN, openIdx - 1);
  }

  return null;
}
