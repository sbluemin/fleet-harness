import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");

describe("Scuttlebutt design tokens", () => {
  // brass 채움 버튼은 전용 on-brass 텍스트 티어를 소비한다 — abyss 재결합은 라이트 테마에서
  // 페이지 배경 조정이 버튼 대비를 함께 끌어내리는 AA 회귀다(instrument-design-contract 동형 계약).
  it("keeps the send button text on the on-brass tier", () => {
    const block = styles.match(/\.scuttlebutt-send \{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("background: var(--brass);");
    expect(block).toContain("color: var(--text-on-brass);");
  });
});
