/**
 * 화면 밖으로 나가는 주소 판정 — 플러그인 메타데이터와 플러그인 README 정화가 같은 규칙을 쓴다.
 */

/** http(s) 만. 사용자·비밀번호가 섞인 주소와 상대 경로는 거절한다. */
export function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
