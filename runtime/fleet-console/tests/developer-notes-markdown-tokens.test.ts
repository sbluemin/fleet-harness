import fs from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * `markdown/styles.css`는 자기 타입 스케일을 `.markdown-body` 요소 자신에게 직접 공급한다
 * (non-codex 표면도 codex와 동일 렌더하도록). 그래서 조상 스코프에 같은 토큰을 선언해도
 * 요소 자신의 선언이 이겨 아무 효과가 없다 — 축소하려면 `.markdown-body`를 직접 겨냥한
 * 더 높은 특이성이어야 한다. 이 함정은 빌드·타입체크를 모두 통과하고 화면에서만 드러난다.
 */
const MARKDOWN_STYLES = new URL("../markdown/styles.css", import.meta.url);
const DEVELOPER_NOTES_STYLES = new URL("../core/client/src/styles/developer-notes.css", import.meta.url);

const SHARED_SCALE_PATTERN = /\.markdown-body,\s*\n\.diagram-lightbox\s*\{([\s\S]*?)\n\}/;
const SHEET_SCALE_PATTERN = /\.developer-notes-body \.markdown-body\s*\{([\s\S]*?)\n\}/;

function read(url: URL): string {
  return fs.readFileSync(url, "utf8");
}

function fontSizes(block: string): ReadonlyMap<string, number> {
  return new Map([...block.matchAll(/(--font-size-[a-z0-9-]+):\s*([0-9.]+)px/g)].map((match) => [match[1]!, Number(match[2]!)]));
}

describe("developer notes markdown type scale", () => {
  it("overrides the scale on .markdown-body itself, not on an ancestor", () => {
    // 조상 스코프 선언은 무력하다 — 여기서 특이성을 잃으면 시트가 조용히 문서 스케일로 돌아간다.
    const css = read(DEVELOPER_NOTES_STYLES);
    expect(SHEET_SCALE_PATTERN.test(css), ".developer-notes-body .markdown-body rule must carry the scale").toBe(true);
    const sheetRule = /\.developer-notes-sheet\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(fontSizes(sheetRule).size, "the sheet ancestor must not carry font-size tokens — they never apply").toBe(0);
  });

  it("shrinks every font size the shared stylesheet supplies", () => {
    const shared = fontSizes(SHARED_SCALE_PATTERN.exec(read(MARKDOWN_STYLES))?.[1] ?? "");
    const sheet = fontSizes(SHEET_SCALE_PATTERN.exec(read(DEVELOPER_NOTES_STYLES))?.[1] ?? "");
    expect(shared.size).toBeGreaterThan(0);
    const notShrunk = [...sheet].filter(([token, size]) => {
      const base = shared.get(token);
      return base !== undefined && size >= base;
    });
    expect(notShrunk, `these overrides do not shrink the shared scale: ${notShrunk.map(([token]) => token).join(", ")}`).toEqual([]);
  });

  it("keeps the sheet body below the console chrome size", () => {
    // 시트는 문서가 아니라 알림이다. 본문이 크롬(14px)보다 커지면 위계가 뒤집힌다.
    const sheet = fontSizes(SHEET_SCALE_PATTERN.exec(read(DEVELOPER_NOTES_STYLES))?.[1] ?? "");
    expect(sheet.get("--font-size-body")).toBeLessThanOrEqual(14);
  });

  it("covers every font size the shared stylesheet supplies to markdown bodies", () => {
    // 공유 시트가 토큰을 추가하면 시트도 함께 축소해야 한다 — 빠진 토큰은 문서 스케일로 남는다.
    const shared = fontSizes(SHARED_SCALE_PATTERN.exec(read(MARKDOWN_STYLES))?.[1] ?? "");
    const sheet = fontSizes(SHEET_SCALE_PATTERN.exec(read(DEVELOPER_NOTES_STYLES))?.[1] ?? "");
    // 2xs는 다이어그램 캡션 전용이라 노트 본문 경로에 나타나지 않는다.
    const missing = [...shared.keys()].filter((token) => token !== "--font-size-2xs" && !sheet.has(token));
    expect(missing, `the notes sheet leaves these at document scale: ${missing.join(", ")}`).toEqual([]);
  });
});
