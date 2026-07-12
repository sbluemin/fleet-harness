import path from "node:path";
import { randomUUID } from "node:crypto";

import type { CliType, ProtocolType } from "@dotobokuri/core-unified-agent";

export type DispatchShape = "single" | "taskforce";

export interface DispatchBackendBindingInput {
  readonly cliType: CliType;
  /** Known only after one-shot readiness. */
  readonly protocol?: ProtocolType;
}

export interface DispatchBackendSession extends Required<DispatchBackendBindingInput> {
  readonly sessionId: string;
}

export interface DispatchContextBindingInput {
  readonly carrierId: string;
  readonly cwd: string;
  readonly shape: DispatchShape;
  readonly backends: readonly DispatchBackendBindingInput[];
}

export interface DispatchContextBinding {
  readonly carrierId: string;
  readonly cwd: string;
  readonly shape: DispatchShape;
  readonly backends: readonly Required<DispatchBackendBindingInput>[];
}

export interface DispatchContext {
  readonly binding: DispatchContextBinding;
  readonly sessions: ReadonlyMap<CliType, DispatchBackendSession>;
}

interface StoredDispatchContext extends DispatchContext {
  readonly updatedAt: number;
}

export type DispatchContextClaim =
  | { readonly accepted: true; readonly lease: DispatchContextLease; readonly resumeSessions: ReadonlyMap<CliType, string> | undefined }
  | { readonly accepted: false; readonly error: "busy" | "binding mismatch" | "not found" | "disposed" };

export interface DispatchContextLease {
  readonly contextId: string;
}

interface PendingClaim {
  readonly binding: Omit<DispatchContextBinding, "backends"> & { readonly backends: readonly DispatchBackendBindingInput[] };
  readonly resume: DispatchContext | undefined;
}

const CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DISPATCH_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_MAX_DISPATCH_CONTEXTS = 256;

/** Strict opaque public-token validation. It deliberately does not trim or normalize. */
export function isValidContextId(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 && CONTEXT_ID_PATTERN.test(value);
}

export function validateContextId(value: unknown): string | undefined {
  return isValidContextId(value) ? value : undefined;
}

export function createContextId(): string {
  return `ctx:${randomUUID()}`;
}

/** Process-local, runtime-owned metadata registry. Never persist this object or its entries. */
export class DispatchContextRegistry {
  #contexts = new Map<string, StoredDispatchContext>();
  #claims = new Map<string, PendingClaim>();
  #disposed = false;

  constructor(
    readonly maxContexts = DEFAULT_MAX_DISPATCH_CONTEXTS,
    readonly ttlMs = DISPATCH_CONTEXT_TTL_MS,
  ) {
    if (!Number.isSafeInteger(maxContexts) || maxContexts < 1) throw new Error("maxContexts must be a positive safe integer.");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be a positive safe integer.");
  }

  claim(
    contextId: string,
    input: DispatchContextBindingInput,
    now = Date.now(),
    requireExisting = false,
  ): DispatchContextClaim {
    if (this.#disposed) return { accepted: false, error: "disposed" };
    if (!isValidContextId(contextId)) throw new Error("Invalid context_id.");
    this.#prune(now);
    if (this.#claims.has(contextId)) return { accepted: false, error: "busy" };

    const binding = normalizeBinding(input);
    const committed = this.#contexts.get(contextId);
    if (requireExisting && !committed) return { accepted: false, error: "not found" };
    if (committed && !sameStaticBinding(committed.binding, binding)) {
      return { accepted: false, error: "binding mismatch" };
    }

    this.#claims.set(contextId, { binding, resume: committed });
    return {
      accepted: true,
      lease: { contextId },
      resumeSessions: committed ? new Map([...committed.sessions].map(([cliType, session]) => [cliType, session.sessionId])) : undefined,
    };
  }

  confirmReadiness(lease: DispatchContextLease, backends: readonly DispatchBackendSession[]): DispatchContextBinding {
    const claim = this.#getClaim(lease);
    const binding = completeBinding(claim.binding, backends);
    if (claim.resume && !sameBinding(claim.resume.binding, binding)) {
      throw new Error("context_id binding mismatch");
    }
    this.#claims.set(lease.contextId, { ...claim, binding });
    return binding;
  }

  commit(lease: DispatchContextLease, sessions: readonly DispatchBackendSession[], now = Date.now()): void {
    if (this.#disposed) return;
    const claim = this.#getClaim(lease);
    const binding = completeBinding(claim.binding, sessions);
    if (claim.resume) {
      if (!sameBinding(claim.resume.binding, binding) || !sameSessions(claim.resume.sessions, sessions)) {
        throw new Error("context_id binding mismatch");
      }
    }
    this.#contexts.delete(lease.contextId);
    this.#contexts.set(lease.contextId, {
      binding,
      sessions: new Map(sessions.map((session) => [session.cliType, freezeSession(session)])),
      updatedAt: now,
    });
    this.#prune(now);
    this.#claims.delete(lease.contextId);
  }

  release(lease: DispatchContextLease): void {
    this.#claims.delete(lease.contextId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#claims.clear();
    this.#contexts.clear();
  }

  get size(): number {
    this.#prune(Date.now());
    return this.#contexts.size;
  }

  #prune(now: number): void {
    for (const [contextId, context] of this.#contexts) {
      if (context.updatedAt + this.ttlMs <= now) this.#contexts.delete(contextId);
    }
    while (this.#contexts.size > this.maxContexts) {
      const oldest = this.#contexts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#contexts.delete(oldest);
    }
  }

  #getClaim(lease: DispatchContextLease): PendingClaim {
    if (this.#disposed) throw new Error("Dispatch context registry is disposed.");
    const claim = this.#claims.get(lease.contextId);
    if (!claim) throw new Error("Dispatch context lease is no longer active.");
    return claim;
  }
}

function normalizeBinding(input: DispatchContextBindingInput): PendingClaim["binding"] {
  if (!path.isAbsolute(input.cwd)) throw new Error("Dispatch cwd must be absolute.");
  const backends = [...input.backends]
    .map((backend) => ({ cliType: backend.cliType, protocol: backend.protocol }))
    .sort((left, right) => left.cliType.localeCompare(right.cliType));
  if (backends.length === 0 || new Set(backends.map((backend) => backend.cliType)).size !== backends.length) {
    throw new Error("Dispatch binding must contain each backend exactly once.");
  }
  return Object.freeze({
    carrierId: input.carrierId,
    cwd: path.normalize(input.cwd),
    shape: input.shape,
    backends: Object.freeze(backends),
  });
}

function completeBinding(input: PendingClaim["binding"], sessions: readonly DispatchBackendSession[]): DispatchContextBinding {
  const byCli = new Map(sessions.map((session) => [session.cliType, session]));
  if (byCli.size !== input.backends.length || input.backends.some((backend) => !byCli.has(backend.cliType))) {
    throw new Error("Readiness sessions do not match the dispatch binding.");
  }
  const backends = input.backends.map((backend) => {
    const session = byCli.get(backend.cliType)!;
    if (!session.sessionId || (backend.protocol && backend.protocol !== session.protocol)) {
      throw new Error("Readiness session does not match the dispatch binding.");
    }
    return Object.freeze({ cliType: backend.cliType, protocol: session.protocol });
  });
  return Object.freeze({ ...input, backends: Object.freeze(backends) });
}

function sameStaticBinding(left: DispatchContextBinding, right: PendingClaim["binding"]): boolean {
  return left.carrierId === right.carrierId
    && left.cwd === right.cwd
    && left.shape === right.shape
    && left.backends.length === right.backends.length
    && left.backends.every((backend, index) => backend.cliType === right.backends[index]?.cliType);
}

function sameBinding(left: DispatchContextBinding, right: DispatchContextBinding): boolean {
  return sameStaticBinding(left, right)
    && left.backends.every((backend, index) => backend.protocol === right.backends[index]?.protocol);
}

function sameSessions(existing: ReadonlyMap<CliType, DispatchBackendSession>, sessions: readonly DispatchBackendSession[]): boolean {
  return existing.size === sessions.length && sessions.every((session) => existing.get(session.cliType)?.sessionId === session.sessionId);
}

function freezeSession(session: DispatchBackendSession): DispatchBackendSession {
  return Object.freeze({ ...session });
}

// ═════════════════════════════════════════════════════════
// Dispatch-flow helpers — bridge the runtime-owned registry to the launch path.
// Every helper is a no-op when no registry is present (untracked dispatch) or no
// lease was reserved, so single/Task Force launch code stays free of null checks.
// ═════════════════════════════════════════════════════════

/** Public `resume_context_id` parameter guidance — shared by the tool schema and prompt snippet. */
export const RESUME_CONTEXT_ID_DESCRIPTION =
  "Optional context_id returned by an earlier successful carrier_dispatch. Pass it to resume that real provider session in a fresh process; omit it to start a fresh session and receive a new context_id.";

export type DispatchClaimOutcome =
  | { readonly ok: true; readonly contextId?: string; readonly lease?: DispatchContextLease; readonly resumeSessions?: ReadonlyMap<CliType, string> }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve an optional `resume_context_id` against the runtime registry before a launch.
 * - Omitted input: issue and reserve a fresh context id.
 * - Present, valid, and free: reserve it and expose its provider resume sessions.
 * - No runtime registry: run fresh and untracked without advertising a context id.
 * - Invalid format or a rejected claim: `ok:false` with a public reason.
 */
export function claimDispatchContext(
  registry: DispatchContextRegistry | undefined,
  rawResumeContextId: string | undefined,
  binding: DispatchContextBindingInput,
): DispatchClaimOutcome {
  if (!registry) return { ok: true };
  const contextId = rawResumeContextId === undefined ? createContextId() : validateContextId(rawResumeContextId);
  if (!contextId) {
    return {
      ok: false,
      error: "Invalid resume_context_id: pass the context_id returned by a prior successful carrier_dispatch.",
    };
  }
  const claim = registry.claim(contextId, binding, Date.now(), rawResumeContextId !== undefined);
  if (!claim.accepted) return { ok: false, error: describeClaimError(claim.error) };
  return { ok: true, contextId, lease: claim.lease, resumeSessions: claim.resumeSessions };
}

function describeClaimError(error: "busy" | "binding mismatch" | "not found" | "disposed"): string {
  switch (error) {
    case "busy":
      return "resume_context_id is already in flight; wait for the prior dispatch to finish or omit it to start fresh.";
    case "binding mismatch":
      return "resume_context_id belongs to a different carrier, cwd, shape, or backend set; omit it to start fresh.";
    case "not found":
      return "resume_context_id is unknown or expired; omit it to start a fresh provider session.";
    case "disposed":
      return "Carrier runtime is shutting down; context resume is unavailable.";
  }
}

/** Confirm readiness protocol/session identity against a reserved lease; throws on binding drift. */
export function confirmDispatchReadiness(
  registry: DispatchContextRegistry | undefined,
  lease: DispatchContextLease | undefined,
  backends: readonly DispatchBackendSession[],
): void {
  if (!lease || !registry) return;
  registry.confirmReadiness(lease, backends);
}

/** Commit a completed-turn mapping for a reserved lease. */
export function commitDispatchLease(
  registry: DispatchContextRegistry | undefined,
  lease: DispatchContextLease | undefined,
  backends: readonly DispatchBackendSession[],
): void {
  if (!lease || !registry) return;
  registry.commit(lease, backends);
}

/** Release a reserved lease without committing; retains any prior committed mapping. */
export function releaseDispatchLease(
  registry: DispatchContextRegistry | undefined,
  lease: DispatchContextLease | undefined,
): void {
  if (!lease || !registry) return;
  registry.release(lease);
}
