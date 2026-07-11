import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopResourcePaths {
  readonly nodePath: string;
  readonly serviceRoot: string;
  readonly cliPath: string;
  readonly iconPath: string;
}

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveDesktopResourcePaths(isPackaged: boolean, resourcesPath?: string): DesktopResourcePaths {
  const root = isPackaged ? path.join(resourcesPath ?? process.resourcesPath, "sidecar") : path.resolve(sourceDir, "../../fleet-console");
  const serviceRoot = isPackaged ? path.join(root, "fleet-console") : root;
  const nodePath = isPackaged ? path.join(root, "node", process.platform === "win32" ? "node.exe" : "bin/node") : resolveDevelopmentNodePath();
  return { nodePath, serviceRoot, cliPath: path.join(serviceRoot, "dist", "cli.mjs"), iconPath: isPackaged ? path.join(serviceRoot, "icon.png") : path.resolve(sourceDir, "..", "build", "icon.png") };
}

function resolveDevelopmentNodePath(): string {
  const nodePath = process.env.FLEET_CONSOLE_NODE_PATH ?? process.env.npm_node_execpath;
  if (!nodePath) throw new Error("development_node_path_missing: set FLEET_CONSOLE_NODE_PATH or run through pnpm/npm");
  return nodePath;
}
