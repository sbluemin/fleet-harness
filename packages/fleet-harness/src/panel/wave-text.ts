/**
 * panel/wave-text.ts — 파도 그라데이션 텍스트 헬퍼
 *
 * RGB 색상 기반으로 문자열에 파도 형태의 그라데이션을 적용합니다.
 */

export function waveText(
  text: string,
  rgb: [number, number, number],
  frame: number,
  startOffset = 0,
  options?: { speed?: number; allowDim?: boolean },
): string {
  const [r, g, b] = rgb;
  const speed = options?.speed ?? 0.35;
  const allowDim = options?.allowDim ?? false;
  let result = "";
  let idx = startOffset;

  for (const ch of text) {
    const phase = idx * 0.4 - frame * speed;
    const raw = Math.sin(phase);

    if (allowDim) {
      const bright = Math.pow(Math.max(0, raw), 3) * 0.4;
      const dim = Math.min(0, raw) * 0.25;
      const factor = bright + dim;
      const cr = Math.min(255, Math.max(0, Math.round(
        factor >= 0 ? r + (255 - r) * factor : r + r * factor,
      )));
      const cg = Math.min(255, Math.max(0, Math.round(
        factor >= 0 ? g + (255 - g) * factor : g + g * factor,
      )));
      const cb = Math.min(255, Math.max(0, Math.round(
        factor >= 0 ? b + (255 - b) * factor : b + b * factor,
      )));
      result += `\x1b[38;2;${cr};${cg};${cb}m${ch}`;
    } else {
      const wave = Math.max(0, raw);
      const boost = wave * 0.5;
      const cr = Math.min(255, Math.round(r + (255 - r) * boost));
      const cg = Math.min(255, Math.round(g + (255 - g) * boost));
      const cb = Math.min(255, Math.round(b + (255 - b) * boost));
      result += `\x1b[38;2;${cr};${cg};${cb}m${ch}`;
    }
    idx++;
  }

  return result;
}
