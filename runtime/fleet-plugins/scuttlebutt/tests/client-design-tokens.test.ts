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
    // 팝업 판독성 계약: warn wash는 그대로 두고, 반투명 glass 아래 불투명 언더레이를 깐다.
    expect(bubble).toContain(
      "color-mix(in oklch, var(--warn) 12%, var(--surface-glass-strong))",
    );
    expect(bubble).toMatch(/\),\s*var\(--ink-deep\);/);
    expect(label).toContain("color: var(--warn-ink);");
    expect(label).not.toContain("72%");
    // 포커스는 신호 채널이 아니다 — warn 링은 "이 알림이 경고"인지 "여기에 키보드가 있는지"를
    // 같은 색으로 말하고 있었다. C1 이후 링은 brass 하나이며 표현은 --ring-shadow 하나다.
    expect(focus).toContain("var(--ring-shadow)");
    expect(focus).not.toContain("var(--warn)");
    // 닫기 액션도 같은 포커스 규칙을 공유한다.
    expect(focus).toContain(".scuttlebutt-departure-dismiss:focus-visible");
  });

  it("keeps floating speech surfaces opaque under translucent glass themes", () => {
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
      expect(block, selector).toMatch(/\),\s*var\(--ink-deep\);/);
    }
  });
});
