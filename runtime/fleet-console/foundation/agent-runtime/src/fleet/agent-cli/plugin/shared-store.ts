import { lstatSync, mkdtempSync, renameSync } from "node:fs";
import path from "node:path";

import { cleanupPrivateRoot, ensurePrivateDir, writePrivateFile } from "./fs.js";
import type { AssetPluginFile } from "./fleet.js";

/**
 * 공유 트리를 새 렌더로 통째로 교체한다. 호출자는 이 루트의 저장소 락을 이미 쥐고 있어야 한다.
 *
 * 새 트리를 sibling staging 디렉터리에 먼저 완성한다. 기존 트리는 새 트리가 완성된 뒤에만 backup
 * 이름으로 물리고, 승격에 실패하면 즉시 원위치시킨다. 따라서 렌더 실패는 새 파일과 옛 파일이
 * 섞인 정책 트리를 남기지 않는다. 훅은 이벤트마다 `${CLAUDE_PLUGIN_ROOT}` 아래 파일을 다시 읽으므로
 * 실행 중 세션도 다음 이벤트부터 새 렌더를 본다. SessionStart가 그 버전을 문맥에 남긴다.
 */
export function publishSharedPlugin(
  fleetRoot: string,
  pluginRoot: string,
  files: readonly AssetPluginFile[],
): void {
  const parentRoot = path.dirname(pluginRoot);
  const stageRoot = mkdtempSync(path.join(parentRoot, `.fleet-plugin-stage-${process.pid}-`));
  const stagedPluginRoot = path.join(stageRoot, path.basename(pluginRoot));
  const backupRoot = path.join(stageRoot, ".previous");
  let previousMoved = false;
  try {
    ensurePrivateDir(stagedPluginRoot, stageRoot);
    // 빈 로스터에서도 agents/는 존재해야 한다 — 소비자는 디렉터리 부재와 정체성 0개를 구분하지 않는다.
    ensurePrivateDir(path.join(stagedPluginRoot, "agents"), stageRoot);
    for (const file of files) {
      writePrivateFile(path.join(stagedPluginRoot, ...file.relativePath.split("/")), file.content, stageRoot);
    }
    if (pathExists(pluginRoot)) {
      renameSync(pluginRoot, backupRoot);
      previousMoved = true;
    }
    try {
      renameSync(stagedPluginRoot, pluginRoot);
    } catch (error) {
      if (previousMoved) renameSync(backupRoot, pluginRoot);
      previousMoved = false;
      throw error;
    }
  } finally {
    // 성공 후의 backup과 실패한 staging을 함께 정리한다. 복원에 성공했다면 backup은 이미 없다.
    cleanupPrivateRoot(stageRoot, parentRoot);
  }
}

function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
