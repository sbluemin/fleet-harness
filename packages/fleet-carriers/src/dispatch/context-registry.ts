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
