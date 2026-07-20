import fs from "node:fs/promises";
import path from "node:path";

import { isPathContained } from "./path-containment.js";

const GITDIR_PREFIX = "gitdir:";

/**
 * `.git` 마커가 실제로 가리키는 gitdir을 해석하고 Theater 안에 있는지 검증한다.
 *
 * 마커는 디렉터리(일반 저장소)·gitfile(워크트리·서브모듈)·둘 중 하나를 가리키는
 * 심링크로 나타난다. 뒤의 형태들은 Theater 밖 gitdir을 가리킬 수 있고, 그러면 Git이
 * 외부 메타데이터를 따라가 디렉터리 containment를 통과한 채로 바깥 히스토리를
 * 노출한다. 마커 존재만 확인하면 이 경로가 열리므로 해석된 gitdir에도 containment를
 * 건다.
 *
 * 분류에는 lstat이 아니라 stat을 쓴다 — lstat은 심링크 자체를 보고하므로 gitfile을
 * 가리키는 심링크가 파일로 판정되지 않아 내용을 읽지 않고 통과한다. stat과 readFile은
 * 모두 심링크를 따라가므로 symlink → gitfile 형태도 여기서 함께 처리된다.
 *
 * 정상 워크트리의 gitfile은 Theater 안의 `<theater>/.git/worktrees/<name>`을 가리키고
 * 그 gitdir의 commondir은 `<theater>/.git`을 가리키므로 그대로 통과한다.
 */
export async function resolveContainedGitDir(repoDir: string, realTheaterPath: string): Promise<string | null> {
  const markerPath = path.join(repoDir, ".git");

  let marker: Awaited<ReturnType<typeof fs.stat>>;
  try {
    marker = await fs.stat(markerPath);
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
  } else if (marker.isDirectory()) {
    gitDir = markerPath;
  } else {
    return null;
  }

  let realGitDir: string;
  try {
    realGitDir = await fs.realpath(gitDir);
  } catch {
    return null;
  }
  if (!isPathContained(realTheaterPath, realGitDir)) return null;

  // 워크트리 gitdir은 commondir로 공용 저장소(objects·refs)를 가리킨다. 조작된 값은
  // gitdir 자체가 Theater 안이어도 바깥 히스토리를 끌어온다.
  let commonRaw: string | null = null;
  try {
    commonRaw = await fs.readFile(path.join(realGitDir, "commondir"), "utf8");
  } catch {
    // commondir이 없으면 워크트리가 아닌 일반 저장소다.
  }
  if (commonRaw !== null) {
    const commonTarget = commonRaw.trim();
    if (!commonTarget) return null;
    let realCommonDir: string;
    try {
      realCommonDir = await fs.realpath(path.resolve(realGitDir, commonTarget));
    } catch {
      return null;
    }
    if (!isPathContained(realTheaterPath, realCommonDir)) return null;
  }

  return realGitDir;
}
