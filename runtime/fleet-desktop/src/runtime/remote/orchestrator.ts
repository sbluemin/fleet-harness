import type { NodeRuntimeManifest } from "../node-bootstrap.js";
import type { RegistryChecker } from "../registry-check.js";
import type { RemoteRuntimePhaseCallback } from "./contracts.js";
import { inspectRemoteLock, type RemoteConsoleLock, type RemoteLockOwner } from "./lock.js";
import { provisionRemoteRuntime, type ProvisionRemoteRuntimeDependencies } from "./provisioner.js";
import { startRemoteService, stopOwnedRemoteService, type RemoteServiceLaunch } from "./service.js";
import type { OpenSshAdapter } from "./ssh.js";
import { openSamePortTunnel, openTunnelWithReroll, type RemoteTunnel } from "./tunnel.js";
import { parseSshTarget, type ValidatedSshTarget } from "./target.js";

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
}

/** Electron-free composition of the managed SSH candidate. */
export async function connectManagedRemote(input: string, dependencies: ManagedRemoteDependencies): Promise<ManagedRemoteSession> {
  const emit = dependencies.onPhase ?? (() => undefined);
  emit("validating_target");
  const target = parseSshTarget(input);
  emit("connecting");
  const earlyUpdate = await dependencies.registry.check("");
  const expectedEarlyOwner = ownerFor(dependencies.ownerId, earlyUpdate.latest);
  let lock = expectedEarlyOwner ? await inspectRemoteLock(dependencies.ssh, target, expectedEarlyOwner) : { kind: "absent" } as const;
  if (lock.kind === "remote_console_owned_elsewhere" || lock.kind === "remote_console_lock_conflict") throw new Error(lock.kind);

  let created = false;
  let service: RemoteConsoleLock;
  let launch: RemoteServiceLaunch | null = null;
  if (lock.kind === "same_owner") {
    // A live same-owner Console is deliberately not provisioned or restarted. The
    // registry observation is still made so its normal policy state remains current.
    service = lock.lock;
  } else if (lock.kind === "same_owner_version_mismatch") {
    // This Desktop owns the old service, but the registry says it is not the
    // latest desired Console. Stop only after re-checking that exact lock version.
    await stopOwnedRemoteService(dependencies.ssh, target, lock.lock, ownerFor(dependencies.ownerId, lock.lock.version)!);
    const runtime = await provisionRemoteRuntime(target, dependencies, emit);
    launch = launchFor(runtime.console.version, runtime.console.root, runtime.node.nodeBin, runtime.console.cli, dependencies);
    emit("starting_service");
    service = await startCandidateService(dependencies.ssh, target, launch);
    created = true;
  } else {
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
  return candidateSession(target, opened.tunnel, activeService, dependencies, created);
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
