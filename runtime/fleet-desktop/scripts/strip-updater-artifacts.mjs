import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// electron-builder는 mac dmg/zip에 .blockmap(차등 업데이트용)과 latest*.yml을 만든다. shell-only 데스크톱은
// electron-updater를 쓰지 않고(콘솔 런타임을 런타임에 스스로 조달) verify가 이들을 금지하므로, 빌드 직후 제거한다.
// nsis는 differentialPackage:false로 억제되지만 mac dmg/zip에는 동등 옵션이 없어 이 훅으로 처리한다.
// afterAllArtifactBuild 훅: 추가 아티팩트를 반환하지 않고(빈 배열) outDir의 updater 산출물만 지운다.
export default async function stripUpdaterArtifacts(buildResult) {
  const outDir = buildResult?.outDir ?? (Array.isArray(buildResult?.artifactPaths) && buildResult.artifactPaths.length > 0 ? dirname(buildResult.artifactPaths[0]) : null);
  if (!outDir) return [];
  const removed = await removeUpdaterArtifacts(outDir);
  if (removed.length > 0) console.log(`stripped updater artifacts (shell-only): ${removed.join(", ")}`);
  return [];
}

export function isUpdaterArtifact(fileName) {
  return /^latest.*\.yml$/i.test(fileName) || fileName.endsWith(".blockmap");
}

export async function removeUpdaterArtifacts(outDir) {
  const removed = [];
  const entries = await readdir(outDir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isUpdaterArtifact(entry.name)) continue;
    await rm(join(entry.parentPath, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}
