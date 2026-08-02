import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadVerifiedNodeArchive, type NodeRuntimeManifest, type NodeRuntimeTarget } from "../node-bootstrap.js";
import type { RemoteRuntimePhaseCallback } from "./contracts.js";
import type { OpenSshAdapter } from "./ssh.js";
import type { ValidatedSshTarget } from "./contracts.js";

export const REMOTE_RUNTIME_ROOT = ".fleet/desktop/runtime";
export const REMOTE_NODE_ROOT = `${REMOTE_RUNTIME_ROOT}/node`;

export interface RemoteNodeRuntime {
  readonly root: string;
  readonly nodeBin: string;
  readonly npmCli: string;
  readonly version: string;
}

export type RemoteNodeTargetKey = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

export interface RemotePlatform {
  readonly targetKey: RemoteNodeTargetKey;
  readonly archive: NodeRuntimeTarget;
  readonly system: "linux" | "darwin";
  readonly architecture: "x64" | "arm64";
}

export class RemoteProvisionError extends Error {
  constructor(readonly code: "remote_platform_unsupported" | "remote_node_invalid" | "remote_console_invalid" | "remote_registry_unavailable", options?: ErrorOptions) {
    super(code, options);
    this.name = "RemoteProvisionError";
  }
}

type RemoteNodeSsh = Pick<OpenSshAdapter, "run" | "probe">;

export interface RemoteNodeDependencies {
  readonly ssh: RemoteNodeSsh;
  readonly temporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
  readonly downloadArchive?: typeof downloadVerifiedNodeArchive;
  readonly nonce?: () => string;
}

export function remoteRuntimePath(...parts: readonly string[]): string {
  const candidate = [REMOTE_RUNTIME_ROOT, ...parts].join("/");
  if (!candidate.startsWith(`${REMOTE_RUNTIME_ROOT}/`) || candidate.includes("..") || /(^|\/)\.(?:\/|$)/u.test(candidate)) throw new Error("remote_runtime_path_invalid");
  return candidate;
}

export async function detectRemotePlatform(target: ValidatedSshTarget, manifest: NodeRuntimeManifest, ssh: Pick<OpenSshAdapter, "run">): Promise<RemotePlatform> {
  const result = await ssh.run(target, { operation: "detect_platform", args: [] });
  const [reportedSystem, machine, ...extra] = result.stdout.trim().split(/\r?\n/u);
  const normalizedSystem = reportedSystem?.toLowerCase();
  const normalizedMachine = machine?.toLowerCase();
  const architecture = normalizedMachine === "x86_64" || normalizedMachine === "x64" ? "x64" : normalizedMachine === "aarch64" || normalizedMachine === "arm64" ? "arm64" : null;
  const system = normalizedSystem === "linux" || normalizedSystem === "darwin" ? normalizedSystem : null;
  if (extra.length !== 0 || !system || !architecture) throw new RemoteProvisionError("remote_platform_unsupported");
  const targetKey = `${system}-${architecture}` as RemoteNodeTargetKey;
  const archive = manifest.targets[targetKey];
  if (!archive) throw new RemoteProvisionError("remote_platform_unsupported");
  return { targetKey, archive, system, architecture };
}

export async function readRemoteNodeRuntime(target: ValidatedSshTarget, manifest: NodeRuntimeManifest, ssh: RemoteNodeSsh): Promise<RemoteNodeRuntime | null> {
  try {
    const version = (await ssh.run(target, { operation: "read_runtime_file", args: [remoteRuntimePath("node", ".runtime-version")] })).stdout.trim();
    if (version !== manifest.version
      || !(await ssh.probe(target, { operation: "probe_path", args: [remoteRuntimePath("node", "bin", "node")] })).ok
      || !(await ssh.probe(target, { operation: "probe_path", args: [remoteRuntimePath("node", "lib", "node_modules", "npm", "bin", "npm-cli.js")] })).ok) return null;
    return { root: REMOTE_NODE_ROOT, nodeBin: remoteRuntimePath("node", "bin", "node"), npmCli: remoteRuntimePath("node", "lib", "node_modules", "npm", "bin", "npm-cli.js"), version };
  } catch { return null; }
}

export async function ensureRemoteNode(target: ValidatedSshTarget, manifest: NodeRuntimeManifest, dependencies: RemoteNodeDependencies, onPhase?: RemoteRuntimePhaseCallback, platform?: RemotePlatform): Promise<RemoteNodeRuntime> {
  const existing = await readRemoteNodeRuntime(target, manifest, dependencies.ssh);
  if (existing) return existing;
  onPhase?.("provisioning_node");
  const detectedPlatform = platform ?? await detectRemotePlatform(target, manifest, dependencies.ssh);
  const temporaryDirectory = dependencies.temporaryDirectory ?? (async () => mkdtemp(path.join(os.tmpdir(), "fleet-node-")));
  const removeTemporaryDirectory = dependencies.removeTemporaryDirectory ?? (async (directory) => { await rm(directory, { force: true, recursive: true }); });
  const downloadArchive = dependencies.downloadArchive ?? downloadVerifiedNodeArchive;
  const nonce = dependencies.nonce?.() ?? Math.random().toString(36).slice(2);
  const staging = remoteRuntimePath(`node.staging-${nonce}`);
  const localDirectory = await temporaryDirectory();
  try {
    await mkdir(localDirectory, { recursive: true });
    const archive = await downloadArchive({ directory: localDirectory, manifest, target: detectedPlatform.archive });
    const remoteArchive = remoteRuntimePath(`node.staging-${nonce}`, detectedPlatform.archive.archive);
    await dependencies.ssh.run(target, { operation: "remove_runtime_path", args: [staging] });
    await dependencies.ssh.run(target, { operation: "prepare_staging", args: [staging] });
    await dependencies.ssh.run(target, { operation: "upload_file", args: [remoteArchive], stdin: archive.content });
    await dependencies.ssh.run(target, { operation: "extract_archive", args: [remoteArchive, staging] });
    await dependencies.ssh.run(target, { operation: "remove_runtime_path", args: [remoteArchive] });
    await dependencies.ssh.run(target, { operation: "upload_file", args: [remoteRuntimePath(`node.staging-${nonce}`, ".runtime-version")], stdin: new TextEncoder().encode(manifest.version + "\n") });
    if (!(await dependencies.ssh.probe(target, { operation: "probe_path", args: [remoteRuntimePath(`node.staging-${nonce}`, "bin", "node")] })).ok
      || !(await dependencies.ssh.probe(target, { operation: "probe_path", args: [remoteRuntimePath(`node.staging-${nonce}`, "lib", "node_modules", "npm", "bin", "npm-cli.js")] })).ok) {
      throw new RemoteProvisionError("remote_node_invalid");
    }
    await dependencies.ssh.run(target, { operation: "chmod_exec", args: [remoteRuntimePath(`node.staging-${nonce}`, "bin", "node")] });
    await dependencies.ssh.run(target, { operation: "promote_runtime_path", args: [staging, REMOTE_NODE_ROOT] });
    return { root: REMOTE_NODE_ROOT, nodeBin: remoteRuntimePath("node", "bin", "node"), npmCli: remoteRuntimePath("node", "lib", "node_modules", "npm", "bin", "npm-cli.js"), version: manifest.version };
  } catch (error) {
    await dependencies.ssh.run(target, { operation: "remove_runtime_path", args: [staging] }).catch(() => undefined);
    throw error;
  } finally { await removeTemporaryDirectory(localDirectory); }
}
