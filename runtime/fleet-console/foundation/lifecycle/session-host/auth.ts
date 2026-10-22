import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { SESSION_HOST_START_MS } from "@fleet-console/protocol/session-host";
import type { SessionRpcPeer } from "./rpc.js";

export interface SessionAuthIdentity {
  readonly wire: number;
  readonly hostId: string;
  readonly role: string;
  readonly [key: string]: unknown;
}
export interface SessionAuthChallenge { readonly identity: SessionAuthIdentity; readonly clientNonce: string; }
const NONCE = /^[a-f0-9]{64}$/;
export function sessionNonce(): string { return randomBytes(32).toString("hex"); }
export function sessionProof(secret: string, label: string, context: unknown): string {
  return createHmac("sha256", secret).update(JSON.stringify(["fleet-session-auth-v2", label, context])).digest("hex");
}
export function verifySessionProof(proof: unknown, secret: string, label: string, context: unknown): boolean {
  if (typeof proof !== "string" || !NONCE.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(sessionProof(secret, label, context), "hex"));
}
export function sessionChannelKeys(secret: string, context: unknown): { client: Buffer; server: Buffer } {
  const binding = Buffer.from(JSON.stringify(["fleet-session-auth-v2", context]));
  const derive = (direction: string) => Buffer.from(hkdfSync("sha256", Buffer.from(secret), binding, Buffer.from(`fleet-session-channel-v2/${direction}`), 32));
  return { client: derive("client-to-server"), server: derive("server-to-client") };
}
export function validSessionNonce(value: unknown): value is string { return typeof value === "string" && NONCE.test(value); }
/** 서버 증명을 먼저 확인하므로 위조 pipe에 client/owner proof를 보내지 않는다. 원문 secret은 wire에 없다. */
export async function authenticateSessionPeer<T>(peer: SessionRpcPeer, identity: SessionAuthIdentity, secret: string, ownerToken?: string): Promise<T> {
  const challenge: SessionAuthChallenge = { identity, clientNonce: sessionNonce() };
  const reply = await peer.call<{ serverNonce: string; proof: string }>("auth-challenge", challenge, SESSION_HOST_START_MS);
  if (!validSessionNonce(reply.serverNonce)) throw new Error("session_auth_server_unverified");
  const context = [challenge, reply.serverNonce];
  if (!verifySessionProof(reply.proof, secret, "server", context)) throw new Error("session_auth_server_unverified");
  const finishing = peer.call<{ value: T; proof: string }>("auth-finish", {
    proof: sessionProof(secret, "client", context),
    ...(ownerToken ? { ownerProof: sessionProof(ownerToken, "owner", context) } : {}),
  }, SESSION_HOST_START_MS);
  const keys = sessionChannelKeys(secret, context); peer.secure(keys.client, keys.server);
  const result = await finishing;
  if (!verifySessionProof(result.proof, secret, "accepted", context)) throw new Error("session_auth_server_unverified");
  return result.value;
}
