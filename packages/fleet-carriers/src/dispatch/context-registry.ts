import path from "node:path";

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

export type DispatchContextClaim =
  | { readonly accepted: true; readonly lease: DispatchContextLease; readonly resumeSessions: ReadonlyMap<CliType, string> | undefined }
  | { readonly accepted: false; readonly error: "busy" | "binding mismatch" | "disposed" };

export interface DispatchContextLease {
  readonly dispatchId: string;
}

interface PendingClaim {
  readonly binding: Omit<DispatchContextBinding, "backends"> & { readonly backends: readonly DispatchBackendBindingInput[] };
  readonly resume: DispatchContext | undefined;
}

const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Strict opaque public-token validation. It deliberately does not trim or normalize. */
export function isValidDispatchId(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 && DISPATCH_ID_PATTERN.test(value);
}

export function validateDispatchId(value: unknown): string | undefined {
  return isValidDispatchId(value) ? value : undefined;
}

/** Process-local, runtime-owned metadata registry. Never persist this object or its entries. */
export class DispatchContextRegistry {
  #contexts = new Map<string, DispatchContext>();
  #claims = new Map<string, PendingClaim>();
  #disposed = false;

  claim(dispatchId: string, input: DispatchContextBindingInput): DispatchContextClaim {
    if (this.#disposed) return { accepted: false, error: "disposed" };
    if (!isValidDispatchId(dispatchId)) throw new Error("Invalid dispatch_id.");
    if (this.#claims.has(dispatchId)) return { accepted: false, error: "busy" };

    const binding = normalizeBinding(input);
    const committed = this.#contexts.get(dispatchId);
    if (committed && !sameStaticBinding(committed.binding, binding)) {
      return { accepted: false, error: "binding mismatch" };
    }

    this.#claims.set(dispatchId, { binding, resume: committed });
    return {
      accepted: true,
      lease: { dispatchId },
      resumeSessions: committed ? new Map([...committed.sessions].map(([cliType, session]) => [cliType, session.sessionId])) : undefined,
    };
  }

  confirmReadiness(lease: DispatchContextLease, backends: readonly DispatchBackendSession[]): DispatchContextBinding {
    const claim = this.#getClaim(lease);
    const binding = completeBinding(claim.binding, backends);
    if (claim.resume && !sameBinding(claim.resume.binding, binding)) {
      throw new Error("dispatch_id binding mismatch");
    }
    this.#claims.set(lease.dispatchId, { ...claim, binding });
    return binding;
  }

  commit(lease: DispatchContextLease, sessions: readonly DispatchBackendSession[]): void {
    if (this.#disposed) return;
    const claim = this.#getClaim(lease);
    const binding = completeBinding(claim.binding, sessions);
    if (claim.resume) {
      if (!sameBinding(claim.resume.binding, binding) || !sameSessions(claim.resume.sessions, sessions)) {
        throw new Error("dispatch_id binding mismatch");
      }
    } else {
      this.#contexts.set(lease.dispatchId, {
        binding,
        sessions: new Map(sessions.map((session) => [session.cliType, freezeSession(session)])),
      });
    }
    this.#claims.delete(lease.dispatchId);
  }

  release(lease: DispatchContextLease): void {
    this.#claims.delete(lease.dispatchId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#claims.clear();
    this.#contexts.clear();
  }

  get size(): number {
    return this.#contexts.size;
  }

  #getClaim(lease: DispatchContextLease): PendingClaim {
    if (this.#disposed) throw new Error("Dispatch context registry is disposed.");
    const claim = this.#claims.get(lease.dispatchId);
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

/** Public `dispatch_id` parameter guidance — shared by the tool schema and prompt snippet. */
export const DISPATCH_ID_DESCRIPTION =
  "Optional opaque resume token. Omit for a fresh, untracked context; reuse the same value to resume the same real provider session in a new process. " +
  "Must be a 1–128 byte ASCII token matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ with no surrounding whitespace.";

export type DispatchClaimOutcome =
  | { readonly ok: true; readonly lease?: DispatchContextLease; readonly resumeSessions?: ReadonlyMap<CliType, string> }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve an optional `dispatch_id` against the runtime registry before a launch.
 * - Omitted `dispatch_id`, or no runtime registry: a fresh untracked context (ok, no lease).
 * - Present, valid, and free: a synchronous reservation (ok, lease plus optional resume sessions).
 * - Invalid format or a rejected claim: `ok:false` with a public reason.
 */
export function claimDispatchContext(
  registry: DispatchContextRegistry | undefined,
  rawDispatchId: string | undefined,
  binding: DispatchContextBindingInput,
): DispatchClaimOutcome {
  if (rawDispatchId === undefined || !registry) return { ok: true };
  const dispatchId = validateDispatchId(rawDispatchId);
  if (!dispatchId) {
    return {
      ok: false,
      error: "Invalid dispatch_id: must be a 1–128 byte ASCII token matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ with no surrounding whitespace.",
    };
  }
  const claim = registry.claim(dispatchId, binding);
  if (!claim.accepted) return { ok: false, error: describeClaimError(claim.error) };
  return { ok: true, lease: claim.lease, resumeSessions: claim.resumeSessions };
}

function describeClaimError(error: "busy" | "binding mismatch" | "disposed"): string {
  switch (error) {
    case "busy":
      return "dispatch_id is already in flight; wait for the prior dispatch to finish or use a new dispatch_id.";
    case "binding mismatch":
      return "dispatch_id was bound to a different carrier, cwd, shape, or backend set; use a new dispatch_id to start over.";
    case "disposed":
      return "Carrier runtime is shutting down; dispatch_id resume is unavailable.";
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
