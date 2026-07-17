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
  readonly owner: RemoteLockOwner;
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
  let lock = await inspectRemoteLock(dependencies.ssh, target, dependencies.owner);
  if (lock.kind === "remote_console_owned_elsewhere" || lock.kind === "remote_console_lock_conflict") throw new Error(lock.kind);

  let created = false;
  let service: RemoteConsoleLock;
  let launch: RemoteServiceLaunch | null = null;
  if (lock.kind === "same_owner") {
    // A live same-owner Console is deliberately not provisioned or restarted. The
    // registry observation is still made so its normal policy state remains current.
    await dependencies.registry.check(lock.lock.version);
    service = lock.lock;
  } else {
    const runtime = await provisionRemoteRuntime(target, dependencies, emit);
    emit("starting_service");
    launch = {
      serviceRootRel: runtime.console.root,
      nodeBinRel: runtime.node.nodeBin,
      cliRel: runtime.console.cli,
      ownerId: dependencies.owner.id,
      protocolVersion: dependencies.protocolVersion,
      desktopVersion: dependencies.desktopVersion,
      consoleDirRel: dependencies.consoleDirRel,
    };
    service = await startRemoteService(dependencies.ssh, target, launch);
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
      await stopOwnedRemoteService(dependencies.ssh, target, current, dependencies.owner);
      if (!launch) {
        // Reused service metadata is enough to recreate the exact managed launch.
        launch = {
          serviceRootRel: ".fleet/desktop/runtime/console/latest",
          nodeBinRel: ".fleet/desktop/runtime/node/bin/node",
          cliRel: ".fleet/desktop/runtime/console/latest/dist/cli.mjs",
          ownerId: dependencies.owner.id,
          protocolVersion: dependencies.protocolVersion,
          desktopVersion: dependencies.desktopVersion,
          consoleDirRel: dependencies.consoleDirRel,
        };
      }
      created = true;
      activeService = await startRemoteService(dependencies.ssh, target, launch);
      return activeService;
    },
    );
  } catch (error) {
    if (created) await stopOwnedRemoteService(dependencies.ssh, target, activeService, dependencies.owner).catch(() => undefined);
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
    if (ownsService || committed) await stopOwnedRemoteService(dependencies.ssh, target, service, dependencies.owner).catch(() => undefined);
  };
  return { target, origin: `http://127.0.0.1:${tunnel.port}`, commit: () => { committed = true; }, rollback: close, dispose: close };
}
