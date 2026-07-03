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

  it("중첩처럼 보이는 구조 — 마지막 열림 태그의 완결 쌍을 반환", () => {
    // 역방향 앵커: 마지막 <report>(inner)부터 시도 → 그 뒤 첫 </report>와 짝
    // 본 구현은 단순 문자열 매칭 — 중첩을 재귀 파싱하지 않음.
    const text = "<report>outer <report>inner</report> rest</report>";
    expect(extractFinalReport(text)).toBe("inner");
  });

  it("stray 열림 태그가 앞선 내레이션에 섞여도 최종 블록만 추출한다", () => {
    // 전진 탐색이라면 stray <report>가 진짜 닫힘과 짝지어져 결과를 오염시키는 시나리오
    const text = "progress note accidentally mentions <report> here\nmore work...\n<report>real final report</report>";
    expect(extractFinalReport(text)).toBe("real final report");
  });

  it("마지막 블록이 빈 본문이면 그 앞 완결 블록으로 후퇴한다", () => {
    expect(
      extractFinalReport("<report>real</report> narration <report>   </report>"),
    ).toBe("real");
  });
});
