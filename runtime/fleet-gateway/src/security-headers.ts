import type http from "node:http";

export const GATEWAY_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

export function withSecurityHeaders(headers: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return { ...GATEWAY_SECURITY_HEADERS, ...headers };
}
