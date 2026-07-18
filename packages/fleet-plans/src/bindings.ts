import type { AgentServerBindings } from "@dotobokuri/core-agent";
import {
  ensureWorkspaceDirectory,
  resolveWorkspaceDirectoryByName,
  type WorkspaceDirectory,
} from "@dotobokuri/core-infra/workspace-dir";

const PLAN_WORKSPACE_BINDING_KEY = "fleet-plans.workspace-ref";

/**
 * Creates the server-only Plan storage binding for a host-selected workspace.
 * The workspace is ensured before the binding is handed to an Agent session.
 */
export function createPlanWorkspaceServerBindings(
  dataDir: string,
  workspaceRoot: string,
): AgentServerBindings {
  const workspace = ensureWorkspaceDirectory(dataDir, workspaceRoot);
  return Object.freeze({ [PLAN_WORKSPACE_BINDING_KEY]: workspace.name });
}

export function resolvePlanWorkspaceBinding(
  dataDir: string,
  bindings: AgentServerBindings | undefined,
): WorkspaceDirectory {
  const workspaceRef = bindings?.[PLAN_WORKSPACE_BINDING_KEY];
  if (typeof workspaceRef !== "string" || !workspaceRef.trim()) {
    throw new Error("plan_write requires a host-bound Plan workspace");
  }
  try {
    return resolveWorkspaceDirectoryByName(dataDir, workspaceRef);
  } catch {
    throw new Error("plan_write requires a valid host-bound Plan workspace");
  }
}
