/**
 * 시드 고정 난수(mulberry32) — 지도의 초기 배치와 WebGL 렌더러의 먼지 구름이 같은 알고리즘을 쓴다.
 * 같은 시드면 같은 수열이어야 하므로 사본을 두지 않는다.
 */
export function rng32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
