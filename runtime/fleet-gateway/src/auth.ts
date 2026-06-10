import type { GatewayTokenLookup } from "./tenant-store.js";

export interface GatewayAuthContext {
  readonly token: string;
  readonly lookup: GatewayTokenLookup | null;
}

export function readBearerToken(headers: { readonly authorization?: string | string[] }): string | null {
  const header = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}
