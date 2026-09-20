import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

import { cleanupPrivateRoot, ensurePrivateDir, writePrivateFile } from "./fs.js";
import type { AssetPluginFile } from "./fleet.js";

/**
 * 공유 트리를 새 렌더로 통째로 교체한다. 호출자는 이 루트의 저장소 락을 이미 쥐고 있어야 한다.
 *
 * 디스크가 이미 이 렌더와 같으면 아무것도 하지 않는다. 교체는 `renameSync`로 디렉터리를
 * 통째로 갈아 끼우므로 바이트가 같아도 inode가 바뀌고, 그것만으로 실행 중인 모든 세션이
 * 플러그인이 바뀌었다고 보고 훅 모듈을 다시 싣는다. Operation 하나를 여는 일이 그때 열려
 * 있던 세션 전부를 건드리는 셈이다. 렌더가 런치마다 달라지던 시절에는 그 교체가 필요했지만,
 * 지금 트리는 정적이다 — 어떤 정체성을 올릴지는 Mod가 세션 시작에 호스트에 물어 정한다.
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
  if (treeAlreadyMatches(pluginRoot, files)) return;
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

/**
 * 디스크의 트리가 이 렌더와 정확히 같은가. 같으면 교체를 건너뛴다.
 *
 * 스탬프 파일 하나로 비교하지 않고 실제 바이트를 읽는다. 파일이 다섯 개뿐이라 값이 싸고,
 * 무엇보다 손상된 트리를 그대로 승인하지 않는다 — 스탬프만 맞으면 통과시키는 비교는
 * 누가 `agents/`를 심볼릭 링크로 바꿔 놓아도 눈치채지 못한다.
 */
function treeAlreadyMatches(pluginRoot: string, files: readonly AssetPluginFile[]): boolean {
  try {
    // 빈 로스터에서도 존재해야 하는 디렉터리. 링크로 바뀌었으면 다시 깐다.
    const agents = lstatSync(path.join(pluginRoot, "agents"));
    if (!agents.isDirectory()) return false;
    const expected = new Map(files.map((file) => [file.relativePath, file.content]));
    const present = listRegularFiles(pluginRoot, "");
    if (present.length !== expected.size) return false;
    for (const relativePath of present) {
      const content = expected.get(relativePath);
      if (content === undefined) return false;
      if (readFileSync(path.join(pluginRoot, ...relativePath.split("/")), "utf8") !== content) return false;
    }
    return true;
  } catch {
    // 읽지 못하면 같다고 말할 근거가 없다. 교체한다.
    return false;
  }
}

/** 트리 아래의 일반 파일들을 루트 상대 경로로 모은다. 심볼릭 링크는 파일로 세지 않는다. */
function listRegularFiles(root: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listRegularFiles(root, relativePath));
    else if (entry.isFile()) found.push(relativePath);
    else return [String(Symbol("unexpected entry"))];
  }
  return found;
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
