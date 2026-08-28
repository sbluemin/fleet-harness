import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* Chat의 서체 권위는 터미널 글꼴이고, 예외는 마크다운 본문 하나다. 그 계약은 CSS 한 줄이 아니라
   세 조각이 맞물려야 성립한다: (1) 루트가 토큰을 정의하고 그 토큰으로 font-family를 걸 것,
   (2) 로그 크롬이 전역 서체 토큰을 직접 소비하지 않을 것, (3) 마크다운 본문만 읽기 서체로 되돌릴 것.
   한 조각만 빠져도 증상은 조용하다 — 크롬이 옛 등폭으로 남거나, 반대로 읽기 면이 등폭으로 뒤집힌다.
   그래서 스타일시트 원문을 계약으로 읽는다. */

const chatCss = readFileSync(fileURLToPath(new URL("../client/agent/chat/chat.css", import.meta.url)), "utf8");
const chatView = readFileSync(fileURLToPath(new URL("../client/agent/chat/chat-view.tsx", import.meta.url)), "utf8");

describe("chat font authority", () => {
  it("roots the chat surface on the terminal font token with a mono default", () => {
    const root = chatCss.slice(chatCss.indexOf(".agent-chat {"), chatCss.indexOf("\n}", chatCss.indexOf(".agent-chat {")));

    // 인라인 값이 아직 없는 프레임(초기 렌더·테스트 DOM)에서도 등폭으로 서야 한다.
    expect(root).toMatch(/--agent-chat-font:\s*var\(--font-mono\);/);
    expect(root).toMatch(/font-family:\s*var\(--agent-chat-font\);/);
  });

  it("routes every chat chrome declaration through the token instead of a global font", () => {
    // 전역 토큰을 직접 쓰는 선언이 남아 있으면 그 표면만 터미널 글꼴을 따라오지 않는다.
    expect(chatCss).not.toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(chatCss).not.toMatch(/font-family:\s*var\(--font-display\)/);
    // 루트 1개 + 크롬 선언들. 토큰 경유 선언이 사라지면 계약이 빈 채로 통과하는 것을 막는다.
    expect(chatCss.match(/font-family:\s*var\(--agent-chat-font\)/g)?.length ?? 0).toBeGreaterThanOrEqual(30);
  });

  it("returns only the markdown body to the reading typeface", () => {
    const markdownRule = chatCss.slice(
      chatCss.indexOf(".agent-chat .markdown-body {"),
      chatCss.indexOf("\n}", chatCss.indexOf(".agent-chat .markdown-body {")),
    );

    expect(markdownRule).toMatch(/font-family:\s*var\(--font-body\);/);
  });

  it("feeds the token from the terminal font preference, not a chat-local constant", () => {
    expect(chatView).toMatch(/useTerminalFontFamily/);
    expect(chatView).toMatch(/"--agent-chat-font":\s*terminalFontFamily/);
  });
});
