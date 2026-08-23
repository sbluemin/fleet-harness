import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import { ensurePrivateDir, removePrivatePath, writePrivateFile } from "./fs.js";
import type { AssetPluginFile } from "./fleet.js";

/**
 * 공유 트리를 새 렌더로 교체한다. 호출자는 이 루트의 저장소 락을 이미 쥐고 있어야 한다.
 *
 * 공유 루트는 계속 존재하며 각 파일은 temp+rename으로 교체된다. 모든 쓰기가 성공한 뒤에만 이번
 * 렌더에 없는 항목을 걷으므로, 실패하면 기존 훅·스킬·정체성은 그대로 실행 가능하고 다음 런치가
 * 다시 완성한다. 훅은 이벤트마다 `${CLAUDE_PLUGIN_ROOT}` 아래 파일을 다시 읽으므로 실행 중 세션도
 * 다음 이벤트부터 새 렌더를 본다. SessionStart가 그때의 버전을 문맥에 남겨 stale 여부를 알린다.
 */
export function publishSharedPlugin(
  fleetRoot: string,
  pluginRoot: string,
  files: readonly AssetPluginFile[],
): void {
  ensurePrivateDir(pluginRoot, fleetRoot);
  // 빈 로스터에서도 agents/는 존재해야 한다 — 소비자는 디렉터리 부재와 정체성 0개를 구분하지 않는다.
  const agentsRoot = path.join(pluginRoot, "agents");
  removeUnsafePath(agentsRoot, pluginRoot);
  ensurePrivateDir(agentsRoot, fleetRoot);
  for (const file of files) {
    writePrivateFile(path.join(pluginRoot, ...file.relativePath.split("/")), file.content, fleetRoot);
  }
  pruneStalePluginEntries(pluginRoot, files);
}

function removeUnsafePath(targetPath: string, pluginRoot: string): void {
  try {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) removePrivatePath(targetPath, pluginRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function pruneStalePluginEntries(pluginRoot: string, files: readonly AssetPluginFile[]): void {
  const expectedFiles = new Set(files.map((file) => file.relativePath));
  const expectedDirectories = new Set(["", "agents"]);
  for (const file of files) {
    let current = path.posix.dirname(file.relativePath);
    while (current !== ".") {
      expectedDirectories.add(current);
      current = path.posix.dirname(current);
    }
  }
  pruneDirectory(pluginRoot, pluginRoot, "", expectedFiles, expectedDirectories);
}

function pruneDirectory(
  pluginRoot: string,
  currentPath: string,
  relativeDir: string,
  expectedFiles: ReadonlySet<string>,
  expectedDirectories: ReadonlySet<string>,
): void {
  for (const entry of readdirSync(currentPath)) {
    const entryPath = path.join(currentPath, entry);
    const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
    const stat = lstatSync(entryPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (!expectedDirectories.has(relativePath)) {
        removePrivatePath(entryPath, pluginRoot);
        continue;
      }
      pruneDirectory(pluginRoot, entryPath, relativePath, expectedFiles, expectedDirectories);
      continue;
    }
    if (!expectedFiles.has(relativePath)) removePrivatePath(entryPath, pluginRoot);
  }
}
