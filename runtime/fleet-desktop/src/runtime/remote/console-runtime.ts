import { DESKTOP_RESOURCE_ROOT_MARKER, formatDesktopResourceRootMarker, isDesktopResourceRootMarkerValid } from "@fleet-console/desktop-protocol";

import type { RegistryChecker } from "../registry-check.js";
import { satisfiesNodeEngine } from "../node-bootstrap.js";
import type { RemoteRuntimePhaseCallback } from "./contracts.js";
import { REMOTE_RUNTIME_ROOT, RemoteProvisionError, remoteRuntimePath, type RemoteNodeRuntime } from "./node-runtime.js";
import type { OpenSshAdapter } from "./ssh.js";
import type { ValidatedSshTarget } from "./target.js";

const PACKAGE_NAME = "@dotobokuri/fleet-console";
const PACKAGE_SPEC = "@dotobokuri/fleet-console@latest";
export const REMOTE_CONSOLE_ROOT = `${REMOTE_RUNTIME_ROOT}/console`;
export const REMOTE_CONSOLE_LATEST = `${REMOTE_CONSOLE_ROOT}/latest`;

export interface RemoteConsoleRuntime { readonly root: string; readonly version: string; readonly cli: string; }
type RemoteConsoleSsh = Pick<OpenSshAdapter, "run" | "probe">;
export interface RemoteConsoleDependencies { readonly ssh: RemoteConsoleSsh; readonly registry: Pick<RegistryChecker, "check">; readonly nonce?: () => string; }

export async function readRemoteConsoleRuntime(target: ValidatedSshTarget, ssh: RemoteConsoleSsh, nodeVersion: string): Promise<RemoteConsoleRuntime | null> {
  try {
    const packageJson = JSON.parse((await ssh.run(target, { operation: "read_runtime_file", args: [remoteRuntimePath("console", "latest", "package.json")] })).stdout) as { version?: unknown; engines?: { node?: unknown } };
    if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(packageJson.version) || !satisfiesNodeEngine(nodeVersion, typeof packageJson.engines?.node === "string" ? packageJson.engines.node : null)) return null;
    if (!await hasRemoteConsoleLayout(target, ssh, remoteRuntimePath("console", "latest"))) return null;
    const marker = (await ssh.run(target, { operation: "read_runtime_file", args: [remoteRuntimePath("console", "latest", DESKTOP_RESOURCE_ROOT_MARKER)] })).stdout;
    if (!isDesktopResourceRootMarkerValid(marker)) return null;
    return { root: REMOTE_CONSOLE_LATEST, version: packageJson.version, cli: remoteRuntimePath("console", "latest", "dist", "cli.mjs") };
  } catch { return null; }
}

export async function checkRemoteConsoleUpdate(target: ValidatedSshTarget, node: RemoteNodeRuntime, dependencies: RemoteConsoleDependencies): Promise<{ readonly installed: RemoteConsoleRuntime | null; readonly latest: string | null; readonly unavailable: boolean }> {
  const installed = await readRemoteConsoleRuntime(target, dependencies.ssh, node.version);
  const registry = await dependencies.registry.check(installed?.version ?? "");
  return { installed, latest: registry.latest, unavailable: registry.unavailable === true };
}

export async function ensureRemoteConsole(target: ValidatedSshTarget, node: RemoteNodeRuntime, dependencies: RemoteConsoleDependencies, onPhase?: RemoteRuntimePhaseCallback): Promise<RemoteConsoleRuntime> {
  const update = await checkRemoteConsoleUpdate(target, node, dependencies);
  if (update.installed && !update.latest) return update.installed;
  if (!update.latest) throw new RemoteProvisionError("remote_registry_unavailable");
  onPhase?.("provisioning_console");
  const nonce = dependencies.nonce?.() ?? Math.random().toString(36).slice(2);
  const staging = remoteRuntimePath("console", `.staging-${nonce}`);
  try {
    await dependencies.ssh.run(target, { operation: "remove_runtime_path", args: [staging] });
    await dependencies.ssh.run(target, { operation: "prepare_staging", args: [staging] });
    await dependencies.ssh.run(target, { operation: "install_console", args: [node.nodeBin, node.npmCli, staging, PACKAGE_SPEC] });
    await dependencies.ssh.run(target, { operation: "normalize_console_prefix", args: [staging] });
    const markerPath = remoteRuntimePath("console", `.staging-${nonce}`, DESKTOP_RESOURCE_ROOT_MARKER);
    await dependencies.ssh.run(target, { operation: "upload_file", args: [markerPath], stdin: new TextEncoder().encode(formatDesktopResourceRootMarker()) });
    if (!await hasRemoteConsoleLayout(target, dependencies.ssh, staging)) throw new RemoteProvisionError("remote_console_invalid");
    const packageJson = JSON.parse((await dependencies.ssh.run(target, { operation: "read_runtime_file", args: [remoteRuntimePath("console", `.staging-${nonce}`, "package.json")] })).stdout) as { version?: unknown; engines?: { node?: unknown } };
    const marker = (await dependencies.ssh.run(target, { operation: "read_runtime_file", args: [markerPath] })).stdout;
    if (packageJson.version !== update.latest || !satisfiesNodeEngine(node.version, typeof packageJson.engines?.node === "string" ? packageJson.engines.node : null) || !isDesktopResourceRootMarkerValid(marker)) throw new RemoteProvisionError("remote_console_invalid");
    await dependencies.ssh.run(target, { operation: "promote_runtime_path", args: [staging, REMOTE_CONSOLE_LATEST] });
    return { root: REMOTE_CONSOLE_LATEST, version: update.latest, cli: remoteRuntimePath("console", "latest", "dist", "cli.mjs") };
  } catch (error) {
    await dependencies.ssh.run(target, { operation: "remove_runtime_path", args: [staging] }).catch(() => undefined);
    throw error;
  }
}

async function hasRemoteConsoleLayout(target: ValidatedSshTarget, ssh: RemoteConsoleSsh, prefix: string): Promise<boolean> {
  const paths = ["dist/cli.mjs", "dist/desktop-protocol.mjs", "node_modules/node-pty", "node_modules/ws"];
  const results = await Promise.all(paths.map(async (file) => ssh.probe(target, { operation: "probe_path", args: [prefix + "/" + file] })));
  return results.every((result) => result.ok);
}
