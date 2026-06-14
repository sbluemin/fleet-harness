import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const BEARER_PREFIX = "Bearer ";

export function hasAdminBearer(request: IncomingMessage, token: string): boolean {
  const raw = request.headers.authorization;
  if (!raw?.startsWith(BEARER_PREFIX)) return false;
  return safeEqual(raw.slice(BEARER_PREFIX.length), token);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
