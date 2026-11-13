/** 이 가드 FILTER가 쓰는 scheme 와일드카드만 맞춘다. 다른 패턴은 조용히 놓치지 않고 던진다. */
export function webRequestUrlMatches(url: string, pattern: string): boolean {
  const spec = /^([a-z][a-z0-9+.-]*):\/\/\*\/\*$/u.exec(pattern);
  if (!spec?.[1]) throw new Error(`unsupported webRequest pattern: ${pattern}`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === `${spec[1]}:`;
}
