import { describe, expect, it } from "vitest";

import { extractFinalReport } from "../../src/jobs/report-extract.js";

describe("extractFinalReport", () => {
  it("정상 추출 — <report> 블록 본문을 반환한다", () => {
    expect(extractFinalReport("some narration\n<report>\nresult\n</report>")).toBe("result");
  });

  it("태그 부재 → null", () => {
    expect(extractFinalReport("no tags here")).toBeNull();
  });

  it("빈 문자열 → null", () => {
    expect(extractFinalReport("")).toBeNull();
  });

  it("다중 블록 → 마지막 완결 블록 반환", () => {
    expect(
      extractFinalReport("<report>first</report> narration <report>second</report>"),
    ).toBe("second");
  });

  it("미완결 태그(닫힘 없음) → null", () => {
    expect(extractFinalReport("<report>unfinished content")).toBeNull();
  });

  it("빈 본문(공백만) → null", () => {
    expect(extractFinalReport("<report>   </report>")).toBeNull();
    expect(extractFinalReport("<report>\n\t\n</report>")).toBeNull();
  });

  it("태그 앞뒤 내레이션 섞임 — 본문만 반환", () => {
    const text = "Step 1: done\nStep 2: done\n<report>\n## Report\nAll done.\n</report>\nEnd.";
    expect(extractFinalReport(text)).toBe("## Report\nAll done.");
  });

  it("완결 블록 뒤에 미완결 블록 — 마지막 완결 블록 반환", () => {
    expect(
      extractFinalReport("<report>first</report> <report>incomplete"),
    ).toBe("first");
  });

  it("대문자 REPORT → null (소문자만 인정)", () => {
    expect(extractFinalReport("<REPORT>content</REPORT>")).toBeNull();
    expect(extractFinalReport("<Report>content</Report>")).toBeNull();
  });

  it("속성 있는 태그 → null (속성 없는 태그만 인정)", () => {
    expect(extractFinalReport('<report class="x">content</report>')).toBeNull();
    expect(extractFinalReport('<report id="y">content</report>')).toBeNull();
  });

  it("TaskForce backend별 — 각 backend 직렬화 결과에 독립적으로 적용", () => {
    // extractFinalReport는 순수 함수이므로 backend별로 독립 호출
    const backendA = "narration A\n<report>result-A</report>";
    const backendB = "narration B\n<report>result-B</report>";
    expect(extractFinalReport(backendA)).toBe("result-A");
    expect(extractFinalReport(backendB)).toBe("result-B");
  });

  it("멀티라인 본문 — 내부 줄바꿈 보존", () => {
    const text = "<report>\nline 1\nline 2\nline 3\n</report>";
    expect(extractFinalReport(text)).toBe("line 1\nline 2\nline 3");
  });

  it("중첩처럼 보이는 구조 — 마지막 닫힘 기준으로 처리", () => {
    // <report>...</report> 안에 plain text로 report 태그가 있는 경우
    // 첫 번째 </report>에서 끊어진 후, 다음 <report>를 찾는다.
    // <report>outer <report>inner</report> rest</report>
    // → inner가 마지막 완결이 아니라 outer의 마지막 닫힘이 먼저 발견되므로 "outer <report>inner"
    // 본 구현은 단순 indexOf 기반 — 중첩을 파싱하지 않음.
    const text = "<report>outer <report>inner</report> rest</report>";
    // 첫 <report> + 첫 </report>: body = "outer <report>inner"
    // 두 번째 <report>(없음) → 루프 종료
    // 실제로 두 번째 "rest</report>"에 <report>가 없으므로 body = "outer <report>inner"
    expect(extractFinalReport(text)).toBe("outer <report>inner");
  });
});
