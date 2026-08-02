import type { NodeRuntimeManifest } from "../node-bootstrap.js";
import type { RegistryChecker } from "../registry-check.js";
import { RemoteRuntimeError, type RemoteCancellation, type RemoteRuntimePhaseCallback } from "./contracts.js";
import { inspectRemoteLock, type RemoteConsoleLock, type RemoteLockOwner } from "./lock.js";
import { provisionRemoteRuntime, type ProvisionRemoteRuntimeDependencies } from "./provisioner.js";
import { startRemoteService, stopOwnedRemoteService, type RemoteServiceLaunch } from "./service.js";
import type { OpenSshAdapter } from "./ssh.js";
import { openSamePortTunnel, openTunnelWithReroll, type RemoteTunnel } from "./tunnel.js";
import { parseSshTarget, type ValidatedSshTarget } from "./contracts.js";

const PAIRING_IDENTITY_PATH = "/api/v1/pairing-identity";
const PAIRING_RETRY_MS = 200;
const PAIRING_READY_TIMEOUT_MS = 20_000;
const PAIRING_ATTEMPT_TIMEOUT_MS = 3_000;

export type PairingIdentityFetcher = (input: string, init?: { readonly signal?: AbortSignal }) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export interface ManagedRemoteSession {
  readonly target: ValidatedSshTarget;
  readonly origin: string;
  commit(): void;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ManagedRemoteDependencies extends ProvisionRemoteRuntimeDependencies {
  readonly ssh: OpenSshAdapter;
  readonly manifest: NodeRuntimeManifest;
  readonly ownerId: string;
  readonly protocolVersion: number;
  readonly desktopVersion: string;
  readonly consoleDirRel: string;
  readonly onPhase?: RemoteRuntimePhaseCallback;
  readonly fetch?: PairingIdentityFetcher;
  readonly cancellation?: RemoteCancellation;
}

/** Electron-free composition of the managed SSH candidate. */
export async function connectManagedRemote(input: string, dependencies: ManagedRemoteDependencies): Promise<ManagedRemoteSession> {
  const emit = dependencies.onPhase ?? (() => undefined);
  emit("validating_target");
  const target = parseSshTarget(input);
  emit("connecting");
  const earlyUpdate = await dependencies.registry.check("");
  const offline = earlyUpdate.latest === null;
  const expectedEarlyOwner: RemoteLockOwner = offline ? { id: dependencies.ownerId } : ownerFor(dependencies.ownerId, earlyUpdate.latest)!;
  let lock = await inspectRemoteLock(dependencies.ssh, target, expectedEarlyOwner, offline ? { versionAgnostic: true } : undefined);
  if (lock.kind === "remote_console_owned_elsewhere" || lock.kind === "remote_console_lock_conflict") throw new Error(lock.kind);

  let created = false;
  let service: RemoteConsoleLock;
  let launch: RemoteServiceLaunch | null = null;
  if (lock.kind === "same_owner") {
    // A live same-owner Console is deliberately not provisioned or restarted. The
    // registry observation is still made so its normal policy state remains current.
    service = lock.lock;
  } else if (lock.kind === "same_owner_version_mismatch") {
    // Preserve the live same-owner service until the replacement runtime has
    // been fully provisioned; a failed download or install leaves it usable.
    const runtime = await provisionRemoteRuntime(target, dependencies, emit);
    await stopOwnedRemoteService(dependencies.ssh, target, lock.lock, ownerFor(dependencies.ownerId, lock.lock.version)!);
    launch = launchFor(runtime.console.version, runtime.console.root, runtime.node.nodeBin, runtime.console.cli, dependencies);
    emit("starting_service");
    service = await startCandidateService(dependencies.ssh, target, launch);
    created = true;
  } else {
    if (lock.kind === "stale") await dependencies.ssh.run(target, { operation: "remove_console_lock", args: [String(lock.lock.pid)] });
    const runtime = await provisionRemoteRuntime(target, dependencies, emit);
    emit("starting_service");
    launch = launchFor(runtime.console.version, runtime.console.root, runtime.node.nodeBin, runtime.console.cli, dependencies);
    service = await startCandidateService(dependencies.ssh, target, launch);
    created = true;
  }

  emit("opening_tunnel");
  let activeService = service;
  let opened: { readonly tunnel: RemoteTunnel; readonly service: RemoteConsoleLock };
  try {
    opened = await openTunnelWithReroll(
    service,
    async (port) => openSamePortTunnel(dependencies.ssh, target, port),
    async (current) => {
      // `current` was either started by this candidate or positively classified as
      // same-owner. The service helper re-checks pid and owner before signalling.
      await stopOwnedRemoteService(dependencies.ssh, target, current, ownerFor(dependencies.ownerId, current.version)!);
      if (!launch) {
        // Reused service metadata is enough to recreate the exact managed launch.
        launch = launchFor(current.version, ".fleet/desktop/runtime/console/latest", ".fleet/desktop/runtime/node/bin/node", ".fleet/desktop/runtime/console/latest/dist/cli.mjs", dependencies);
      }
      created = true;
      activeService = await startCandidateService(dependencies.ssh, target, launch);
      return activeService;
    },
    );
  } catch (error) {
    if (created) await stopOwnedRemoteService(dependencies.ssh, target, activeService, ownerFor(dependencies.ownerId, activeService.version)!).catch(() => undefined);
    throw error;
  }
  activeService = opened.service;
  const candidate = candidateSession(target, opened.tunnel, activeService, dependencies, created);
  emit("verifying_pairing");
  try {
    await waitForPairingReadiness(candidate.origin, dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init)), dependencies.cancellation);
    return candidate;
  } catch (error) {
    await candidate.rollback().catch(() => undefined);
    throw error;
  }
}

function candidateSession(target: ValidatedSshTarget, tunnel: RemoteTunnel, service: RemoteConsoleLock, dependencies: ManagedRemoteDependencies, ownsService: boolean): ManagedRemoteSession {
  let closed = false;
  let committed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.dispose();
    // A live same-owner service is adopted on commit and cleaned on a normal later
    // switch/quit; a pre-commit rollback only tears down services this candidate made.
    if (ownsService || committed) await stopOwnedRemoteService(dependencies.ssh, target, service, ownerFor(dependencies.ownerId, service.version)!).catch(() => undefined);
  };
  return { target, origin: `http://127.0.0.1:${tunnel.port}`, commit: () => { committed = true; }, rollback: close, dispose: close };
}

function ownerFor(id: string, serviceVersion: string | null): RemoteLockOwner | null { return serviceVersion ? { id, serviceVersion } : null; }
function launchFor(serviceVersion: string, serviceRootRel: string, nodeBinRel: string, cliRel: string, dependencies: ManagedRemoteDependencies): RemoteServiceLaunch {
  return { serviceRootRel, nodeBinRel, cliRel, ownerId: dependencies.ownerId, protocolVersion: dependencies.protocolVersion, desktopVersion: dependencies.desktopVersion, serviceVersion, consoleDirRel: dependencies.consoleDirRel };
}

async function startCandidateService(adapter: OpenSshAdapter, target: ValidatedSshTarget, launch: RemoteServiceLaunch): Promise<RemoteConsoleLock> {
  try { return await startRemoteService(adapter, target, launch); } catch (error) {
    const owner = ownerFor(launch.ownerId, launch.serviceVersion)!;
    const lock = await inspectRemoteLock(adapter, target, owner).catch(() => null);
    if (lock?.kind === "same_owner") await stopOwnedRemoteService(adapter, target, lock.lock, owner).catch(() => undefined);
    throw error;
  }
}

async function waitForPairingReadiness(origin: string, fetcher: PairingIdentityFetcher, cancellation: RemoteCancellation | undefined): Promise<void> {
  const deadline = Date.now() + PAIRING_READY_TIMEOUT_MS;
  while (true) {
    throwIfAborted(cancellation);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RemoteRuntimeError("remote_pairing_not_ready");
    try {
      const signal = pairingAttemptSignal(remaining, cancellation);
      const response = await awaitWithCancellation(fetcher(`${origin}${PAIRING_IDENTITY_PATH}`, { signal }), cancellation);
      if (response.status === 200 && isPairingIdentity(await response.json())) return;
    } catch {
      throwIfAborted(cancellation);
    }
    if (Date.now() >= deadline) throw new RemoteRuntimeError("remote_pairing_not_ready");
    await waitForRetry(Math.min(PAIRING_RETRY_MS, deadline - Date.now()), cancellation);
  }
}

function pairingAttemptSignal(remaining: number, cancellation: RemoteCancellation | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(PAIRING_ATTEMPT_TIMEOUT_MS, remaining)));
  return cancellation ? AbortSignal.any([cancellation.signal, timeout]) : timeout;
}

function isPairingIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 3 && entry.product === "fleet-console" && entry.schemaVersion === 1 && entry.pairingProtocolVersion === 1;
}

async function awaitWithCancellation<T>(value: Promise<T>, cancellation: RemoteCancellation | undefined): Promise<T> {
  if (!cancellation) return value;
  if (cancellation.signal.aborted) throw new RemoteRuntimeError("ssh_cancelled");
  return new Promise<T>((resolve, reject) => {
    const finish = (): void => { cancellation.signal.removeEventListener("abort", abort); };
    const abort = (): void => { finish(); reject(new RemoteRuntimeError("ssh_cancelled")); };
    cancellation.signal.addEventListener("abort", abort, { once: true });
    void value.then((result) => { finish(); resolve(result); }, (error: unknown) => { finish(); reject(error); });
  });
}

async function waitForRetry(milliseconds: number, cancellation: RemoteCancellation | undefined): Promise<void> {
  if (!cancellation) { await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); return; }
  if (cancellation.signal.aborted) throw new RemoteRuntimeError("ssh_cancelled");
  await new Promise<void>((resolve, reject) => {
    const complete = (): void => { cancellation.signal.removeEventListener("abort", abort); resolve(); };
    const abort = (): void => { clearTimeout(timer); cancellation.signal.removeEventListener("abort", abort); reject(new RemoteRuntimeError("ssh_cancelled")); };
    const timer = setTimeout(complete, milliseconds);
    cancellation.signal.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(cancellation: RemoteCancellation | undefined): void {
  if (cancellation?.signal.aborted) throw new RemoteRuntimeError("ssh_cancelled");
}
