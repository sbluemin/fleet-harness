import fs from "node:fs/promises";
import path from "node:path";

import { isPathContained } from "./path-containment.js";

const GITDIR_PREFIX = "gitdir:";

/**
 * `.git` 마커가 실제로 가리키는 gitdir을 해석하고 Theater 안에 있는지 검증한다.
 *
 * 마커는 디렉터리(일반 저장소)·gitfile(워크트리·서브모듈)·심링크 셋 다 가능하다.
 * 뒤의 두 형태는 Theater 밖 gitdir을 가리킬 수 있고, 그러면 Git이 외부 메타데이터를
 * 따라가 디렉터리 containment를 통과한 채로 바깥 히스토리를 노출한다. 마커 존재만
 * 확인하면 이 경로가 열리므로, 해석된 gitdir 자체에도 containment를 건다.
 *
 * 정상 워크트리의 gitfile은 Theater 안의 `<theater>/.git/worktrees/<name>`을
 * 절대경로로 가리키므로 그대로 통과한다.
 */
export async function resolveContainedGitDir(repoDir: string, realTheaterPath: string): Promise<string | null> {
  const markerPath = path.join(repoDir, ".git");

  let marker: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    marker = await fs.lstat(markerPath);
  } catch {
    return null;
  }

  let gitDir: string;
  if (marker.isFile()) {
    let content: string;
    try {
      content = await fs.readFile(markerPath, "utf8");
    } catch {
      return null;
    }
    const line = content.split("\n").find((entry) => entry.trim().startsWith(GITDIR_PREFIX));
    if (!line) return null;
    const target = line.trim().slice(GITDIR_PREFIX.length).trim();
    if (!target) return null;
    // gitfile의 gitdir은 절대경로일 수도, 저장소 디렉터리 기준 상대경로일 수도 있다.
    gitDir = path.resolve(repoDir, target);
  } else {
    // 디렉터리와 심링크는 realpath가 대상까지 따라간다.
    gitDir = markerPath;
  }

  let realGitDir: string;
  try {
    realGitDir = await fs.realpath(gitDir);
  } catch {
    return null;
  }
  return isPathContained(realTheaterPath, realGitDir) ? realGitDir : null;
}
