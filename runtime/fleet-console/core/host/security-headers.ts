import type http from "node:http";

// connect-src에 https://api.github.com만 명시 허용한다 — GNB의 GitHub star 카운트가 토큰 없이 공개
// REST(stargazers_count)를 클라이언트에서 직접 읽기 위함. 와일드카드/서브도메인은 열지 않는다.
// img-src의 blob:은 Quick Launch 첨부 썸네일(object URL) 전용 허용이다 — blob URL은 같은 오리진
// 스크립트만 만들 수 있어 외부 로딩 표면을 넓히지 않고, data: 우회는 이미지 원본을 base64 문자열로
// 브라우저 상태에 눌러앉힌다.
export const CONSOLE_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://img.shields.io; font-src 'self' data:; connect-src 'self' ws: wss: https://api.github.com; object-src 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

export function withSecurityHeaders(headers: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return { ...CONSOLE_SECURITY_HEADERS, ...headers };
}
