interface HeaderMap {
  [key: string]: string;
}

export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export function withSecurityHeaders(headers?: Record<string, string>): HeaderMap {
  return {
    ...SECURITY_HEADERS,
    ...(headers ?? {}),
  };
}
