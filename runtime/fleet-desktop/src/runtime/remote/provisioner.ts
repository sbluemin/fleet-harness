import type { NodeRuntimeManifest } from "../node-bootstrap.js";
import type { RegistryChecker } from "../registry-check.js";
import type { RemoteRuntimePhaseCallback } from "./contracts.js";
import { detectRemotePlatform, ensureRemoteNode, type RemoteNodeDependencies, type RemoteNodeRuntime } from "./node-runtime.js";
import { ensureRemoteConsole, type RemoteConsoleDependencies, type RemoteConsoleRuntime } from "./console-runtime.js";
import type { ValidatedSshTarget } from "./contracts.js";

export interface ProvisionRemoteRuntimeDependencies extends RemoteNodeDependencies, RemoteConsoleDependencies { readonly manifest: NodeRuntimeManifest; }
export interface ProvisionedRemoteRuntime { readonly node: RemoteNodeRuntime; readonly console: RemoteConsoleRuntime; }

/** Provisioning composes only W2 seams; service lifecycle remains W2-B/W3 ownership. */
export async function provisionRemoteRuntime(target: ValidatedSshTarget, dependencies: ProvisionRemoteRuntimeDependencies, onPhase?: RemoteRuntimePhaseCallback): Promise<ProvisionedRemoteRuntime> {
  const platform = await detectRemotePlatform(target, dependencies.manifest, dependencies.ssh);
  const node = await ensureRemoteNode(target, dependencies.manifest, dependencies, onPhase, platform);
  const console = await ensureRemoteConsole(target, node, platform, dependencies, onPhase);
  return { node, console };
}
