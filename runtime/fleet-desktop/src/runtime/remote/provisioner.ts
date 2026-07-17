import type { NodeRuntimeManifest } from "../node-bootstrap.js";
import type { RegistryChecker } from "../registry-check.js";
import type { RemoteRuntimePhaseCallback } from "./contracts.js";
import { ensureRemoteNode, type RemoteNodeDependencies, type RemoteNodeRuntime } from "./node-runtime.js";
import { ensureRemoteConsole, type RemoteConsoleDependencies, type RemoteConsoleRuntime } from "./console-runtime.js";
import type { ValidatedSshTarget } from "./target.js";

export interface ProvisionRemoteRuntimeDependencies extends RemoteNodeDependencies, RemoteConsoleDependencies { readonly manifest: NodeRuntimeManifest; }
export interface ProvisionedRemoteRuntime { readonly node: RemoteNodeRuntime; readonly console: RemoteConsoleRuntime; }

/** Provisioning composes only W2 seams; service lifecycle remains W2-B/W3 ownership. */
export async function provisionRemoteRuntime(target: ValidatedSshTarget, dependencies: ProvisionRemoteRuntimeDependencies, onPhase?: RemoteRuntimePhaseCallback): Promise<ProvisionedRemoteRuntime> {
  const node = await ensureRemoteNode(target, dependencies.manifest, dependencies, onPhase);
  const console = await ensureRemoteConsole(target, node, dependencies, onPhase);
  return { node, console };
}
