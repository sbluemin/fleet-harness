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

  it("keeps departure announcements on the warn channel token tiers", () => {
    const bubble = styles.match(/\.scuttlebutt-departure-bubble \{[\s\S]*?\n\}/)?.[0] ?? "";
    const label = styles.match(/\.scuttlebutt-departure-label \{[^}]*\}/)?.[0] ?? "";
    const focus = styles.match(/\.scuttlebutt-departure-open:focus-visible[^{]*\{[^}]*\}/)?.[0] ?? "";
    // 테두리는 alpha 조절로 amber hue를 지킨다 — hairline 믹스는 hue 보간이 그린에 착륙한다(실측).
    expect(bubble).toContain(
      "border: 1px solid color-mix(in oklch, var(--warn) 55%, transparent);",
    );
    // 팝업 판독성 계약(리퀴드 글래스 채널판): warn wash는 그대로 두고, 틴트·언더레이는
    // glass 채널로 소비한다 — 게이트가 닫히면 채널 기본값이 구 불투명 계약을 복원한다.
    expect(bubble).toContain(
      "color-mix(in oklch, var(--warn) 12%, var(--glass-tint-strong))",
    );
    expect(bubble).toMatch(/\),\s*var\(--glass-underlay\);/);
    expect(label).toContain("color: var(--warn-ink);");
    expect(label).not.toContain("72%");
    expect(focus).toContain("outline: 2px solid var(--warn);");
    // 닫기 액션도 같은 신호 채널의 포커스 규칙을 공유한다.
    expect(focus).toContain(".scuttlebutt-departure-dismiss:focus-visible");
  });

  it("keeps floating speech surfaces on the glass underlay channel", () => {
    for (const selector of [
      ".scuttlebutt-bird-tag",
      ".scuttlebutt-bird-say",
      ".scuttlebutt-arrival-bubble",
      ".scuttlebutt-answer-bubble",
      ".scuttlebutt-departure-bubble",
      ".scuttlebutt-chat-card",
    ]) {
      const escaped = selector.replace(/\./g, "\\.");
      const block = styles.match(new RegExp(`${escaped} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
      expect(block, selector).toMatch(/\),\s*var\(--glass-underlay\);/);
      expect(block, selector).toContain("backdrop-filter: var(--glass-backdrop-strong);");
    }
  });
});
