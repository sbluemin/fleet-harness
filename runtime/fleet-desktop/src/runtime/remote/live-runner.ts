import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DESKTOP_PROTOCOL_VERSION } from "@fleet-console/desktop-protocol";

import type { NodeRuntimeManifest } from "../node-bootstrap.js";
import { createRegistryChecker, type RegistryChecker } from "../registry-check.js";
import { readRemoteConsoleRuntime } from "./console-runtime.js";
import { inspectRemoteLock } from "./lock.js";
import { detectRemotePlatform, readRemoteNodeRuntime } from "./node-runtime.js";
import { connectManagedRemote, type ManagedRemoteSession, type PairingIdentityFetcher } from "./orchestrator.js";
import { createOpenSshAdapter, type OpenSshAdapter } from "./ssh.js";
import { parseSshTarget } from "./contracts.js";

const CHECKPOINTS = [
  "architecture_detected",
  "node_installed_or_valid",
  "console_latest_installed_or_valid",
  "owned_lock_ready",
  "same_port_tunnel_ready",
  "pairing_identity_200",
  "foreign_owner_refused",
  "cleanup_complete",
] as const;

export type RemoteLiveCheckpoint = (typeof CHECKPOINTS)[number];

export interface RemoteLiveRunnerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly emit?: (checkpoint: RemoteLiveCheckpoint) => void;
  readonly dependencies?: Partial<RemoteLiveRunnerDependencies>;
}

export interface RemoteLiveRunnerDependencies {
  createSsh(options: { readonly extraBaseArgv?: readonly string[] }): Promise<OpenSshAdapter>;
  readManifest(file: string): Promise<NodeRuntimeManifest>;
  createRegistry(statePath: string): RegistryChecker;
  connect(target: string, dependencies: Parameters<typeof connectManagedRemote>[1]): Promise<ManagedRemoteSession>;
  fetch: PairingIdentityFetcher;
  randomUuid(): string;
  temporaryDirectory(): string;
}

/**
 * Host-only, Electron-free proof for a disposable SSH target. Checkpoints expose
 * no host, argv, environment, lock token, or service diagnostics.
 */
export async function runRemoteLiveTest(options: RemoteLiveRunnerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const emit = options.emit ?? emitCheckpoint;
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const targetInput = requiredDisposableTarget(env);
  throwIfAborted(options.signal);
  const manifestPath = env.FLEET_REMOTE_TEST_NODE_MANIFEST ?? path.resolve(process.cwd(), "build/node-runtime.json");
  const manifest = await dependencies.readManifest(manifestPath);
  const config = env.FLEET_REMOTE_TEST_SSH_CONFIG;
  if (config !== undefined && (config.length === 0 || /[\u0000-\u001f\u007f]/u.test(config))) throw new Error("remote_live_ssh_config_invalid");
  const ssh = withCancellation(await dependencies.createSsh(config === undefined ? {} : { extraBaseArgv: ["-F", config] }), options.signal);
  const target = parseSshTarget(targetInput);
  const ownerA = { id: dependencies.randomUuid() };
  const registryState = path.join(dependencies.temporaryDirectory(), `fleet-remote-live-${ownerA.id}.json`);
  const registry = dependencies.createRegistry(registryState);
  let session: ManagedRemoteSession | undefined;
  let mainFailure: unknown;
  try {
    // Detect before composing so the architecture checkpoint remains mandatory even
    // when an already-valid remote Node runtime is reused.
    await detectRemotePlatform(target, manifest, ssh);
    checkpoint(emit, "architecture_detected");
    throwIfAborted(options.signal);

    session = await dependencies.connect(targetInput, {
      ssh, manifest, registry, ownerId: ownerA.id, protocolVersion: DESKTOP_PROTOCOL_VERSION,
      desktopVersion: "remote-live-test", consoleDirRel: ".fleet/console", fetch: dependencies.fetch,
      cancellation: options.signal ? { signal: options.signal } : undefined,
    });
    if (!await readRemoteNodeRuntime(target, manifest, ssh)) throw new Error("remote_live_node_not_valid");
    checkpoint(emit, "node_installed_or_valid");
    const consoleRuntime = await readRemoteConsoleRuntime(target, ssh, manifest.version);
    if (!consoleRuntime) throw new Error("remote_live_console_not_valid");
    checkpoint(emit, "console_latest_installed_or_valid");
    const lock = await inspectRemoteLock(ssh, target, { id: ownerA.id, serviceVersion: consoleRuntime.version });
    if (lock.kind !== "same_owner") throw new Error("remote_live_owned_lock_not_ready");
    checkpoint(emit, "owned_lock_ready");
    checkpoint(emit, "same_port_tunnel_ready");
    await verifyPairingIdentity(dependencies.fetch, session.origin);
    checkpoint(emit, "pairing_identity_200");

    // This must be the first mutation-capable API call for owner B. The production
    // orchestrator reads/classifies the lock before provisioning or signalling.
    const ownerB = { id: dependencies.randomUuid() };
    await expectForeignOwnerRefusal(() => dependencies.connect(targetInput, {
      ssh, manifest, registry, ownerId: ownerB.id, protocolVersion: DESKTOP_PROTOCOL_VERSION,
      desktopVersion: "remote-live-test", consoleDirRel: ".fleet/console", fetch: dependencies.fetch,
      cancellation: options.signal ? { signal: options.signal } : undefined,
    }));
    checkpoint(emit, "foreign_owner_refused");
    session.commit();
  } catch (error) {
    mainFailure = error;
    throw error;
  } finally {
    await session?.dispose().catch((cleanupError: unknown) => { if (!mainFailure) throw cleanupError; });
    checkpoint(emit, "cleanup_complete");
  }
}

function requiredDisposableTarget(env: NodeJS.ProcessEnv): string {
  const target = env.FLEET_REMOTE_TEST_TARGET;
  if (!target || env.FLEET_REMOTE_TEST_EPHEMERAL !== "1") throw new Error("remote_live_disposable_target_required");
  return target;
}

async function verifyPairingIdentity(fetcher: RemoteLiveRunnerDependencies["fetch"], origin: string): Promise<void> {
  const response = await fetcher(`${origin}/api/v1/pairing-identity`);
  const body = await response.json();
  if (response.status !== 200 || !isPairingIdentity(body)) throw new Error("remote_live_pairing_identity_invalid");
}

function isPairingIdentity(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && (value as Record<string, unknown>).product === "fleet-console"
    && (value as Record<string, unknown>).schemaVersion === 1
    && (value as Record<string, unknown>).pairingProtocolVersion === 1;
}

async function expectForeignOwnerRefusal(connect: () => Promise<ManagedRemoteSession>): Promise<void> {
  try { await connect(); } catch (error) {
    if (error instanceof Error && error.message === "remote_console_owned_elsewhere") return;
    throw error;
  }
  throw new Error("remote_live_foreign_owner_not_refused");
}

function checkpoint(emit: (checkpoint: RemoteLiveCheckpoint) => void, value: RemoteLiveCheckpoint): void { emit(value); }
function emitCheckpoint(checkpoint: RemoteLiveCheckpoint): void { process.stdout.write(`${JSON.stringify({ checkpoint })}\n`); }
function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new Error("remote_live_cancelled"); }

/** Keep cancellation at the host boundary while every production operation still
 * flows through the regular adapter/orchestrator contracts. */
function withCancellation(adapter: OpenSshAdapter, signal: AbortSignal | undefined): OpenSshAdapter {
  if (!signal) return adapter;
  const cancellation = { signal };
  return {
    executable: adapter.executable,
    run: (target, command) => adapter.run(target, command, cancellation),
    probe: (target, command) => adapter.probe(target, command, cancellation),
    open: (target, arguments_) => adapter.open(target, arguments_, cancellation),
  };
}

const defaultDependencies: RemoteLiveRunnerDependencies = {
  createSsh: createOpenSshAdapter,
  readManifest: async (file) => JSON.parse(await readFile(file, "utf8")) as NodeRuntimeManifest,
  createRegistry: (statePath) => createRegistryChecker({ packageName: "@dotobokuri/fleet-console", statePath }),
  connect: connectManagedRemote,
  fetch: async (input, init) => fetch(input, init),
  randomUuid: randomUUID,
  temporaryDirectory: os.tmpdir,
};
