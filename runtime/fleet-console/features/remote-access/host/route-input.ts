/**
 * 라우트 입력의 공통 가드 — 경로 한 칸의 id와 JSON 요청 본문.
 *
 * 원격 접속 라우트 여러 갈래가 같은 규칙을 쓴다. id는 경로 한 칸으로만 오고(슬래시가 섞이면 다른
 * 세그먼트다), 깨진 퍼센트 인코딩은 id로 읽지 않는다 — 어느 라우트가 받든 해석이 같아야 한다.
 * 본문은 객체일 때만 필드를 읽는다.
 */

/** Percent-encoded 경로 한 칸 → id. 슬래시는 id가 될 수 없고, 깨진 인코딩은 빈 문자열이 된다. */
export function decodeHandle(raw: string): string {
  if (raw.includes("/")) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** 필드로 읽을 수 있는 JSON 본문인가. 배열·null·원시값은 본문이 아니다. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
