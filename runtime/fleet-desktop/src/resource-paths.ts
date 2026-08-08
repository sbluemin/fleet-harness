import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopResourcePaths {
  readonly nodePath: string;
  readonly serviceRoot: string;
  readonly cliPath: string;
  readonly iconPath: string;
  readonly trayTemplateIconPath: string;
  readonly entryPagePath: string;
}

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveDesktopResourcePaths(isPackaged: boolean, resourcesPath?: string): DesktopResourcePaths {
  const runtimeRoot = isPackaged ? path.join(os.homedir(), ".fleet", "desktop", "runtime") : path.resolve(sourceDir, "../../fleet-console");
  const serviceRoot = isPackaged ? path.join(runtimeRoot, "console", "latest") : runtimeRoot;
  const nodePath = isPackaged ? path.join(runtimeRoot, "node", process.platform === "win32" ? "node.exe" : "bin/node") : resolveDevelopmentNodePath();
  // 번들 main.mjs의 sourceDir은 dev/packaged(ASAR 내) 모두 dist다 — 자산은 copy-entry-assets가 dist로 나르므로 dist 앵커가 두 모드의 유일한 공통 계약이다.
  return {
    nodePath,
    serviceRoot,
    cliPath: path.join(serviceRoot, "dist", "cli.mjs"),
    iconPath: path.join(sourceDir, "build", "icon.png"),
    trayTemplateIconPath: path.join(sourceDir, "build", "trayTemplate.png"),
    entryPagePath: path.join(sourceDir, "assets", "entry", "index.html"),
  };
}

function resolveDevelopmentNodePath(): string {
  const nodePath = process.env.FLEET_CONSOLE_NODE_PATH ?? process.env.npm_node_execpath;
  if (!nodePath) throw new Error("development_node_path_missing: set FLEET_CONSOLE_NODE_PATH or run through pnpm/npm");
  return nodePath;
}
