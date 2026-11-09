import { CHROME_CHANNEL, type ChromeAction, type ChromeColors, type ChromeRole, type ChromeUiState } from "../contract.js";
import { translator } from "../messages.js";

/** 문서 → main. 한 줄 JSON 이 `console-message` 로 나간다. main 은 고정 frame 과 문장 모양을 다시 검사한다. */
export function post(role: ChromeRole, action: ChromeAction["action"], body: Record<string, unknown> = {}): void {
  console.log(JSON.stringify([CHROME_CHANNEL, role, action, body]));
}

export type T = ReturnType<typeof translator>;
export const tr = (state: ChromeUiState): T => translator(state.lang);

/** 팔레트 토큰과 글꼴을 문서 루트 변수로. 키와 값은 main 이 거른 것뿐이다. */
export function paintColors(colors: ChromeColors | null): void {
  const root = document.documentElement;
  if (!colors) return;
  root.setAttribute("data-scheme", colors.scheme);
  for (const [token, color] of Object.entries(colors.tokens)) root.style.setProperty(`--${token}`, color);
  for (const [axis, font] of Object.entries(colors.fonts ?? {})) { root.style.setProperty(`--font-${axis}`, font.family); root.style.setProperty(`--font-${axis}-size`, `${font.size}px`); }
}

/** 스페이스 색 — 스페이스를 가리키는 표식일 뿐이라 id 에서 정한 색상환 하나다. */
export function spaceHue(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  return hash;
}
