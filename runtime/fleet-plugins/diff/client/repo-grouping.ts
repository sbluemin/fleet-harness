import type { RepoEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface RepoGroup {
  readonly repo: RepoEntry;
  readonly worktrees: readonly RepoEntry[];
}

export interface GroupedRepos {
  readonly groups: readonly RepoGroup[];
  /** worktreeOf 있는 항목을 제외한 최상위 저장소 수 */
  readonly topLevelCount: number;
}

// ─── functions ───────────────────────────────────────────────────────────────

/**
 * repos 배열을 부모-자식 그룹으로 구조화한다.
 * worktreeOf가 있는 항목은 해당 부모 그룹의 worktrees 배열에 들어간다.
 * 부모가 없는 고아 워크트리(isWorktree=true, worktreeOf 없음)는 단독 그룹으로 유지된다.
 */
export function groupRepos(repos: readonly RepoEntry[]): GroupedRepos {
  const worktreesByParent = new Map<string, RepoEntry[]>();

  for (const repo of repos) {
    if (repo.worktreeOf !== undefined) {
      const children = worktreesByParent.get(repo.worktreeOf) ?? [];
      children.push(repo);
      worktreesByParent.set(repo.worktreeOf, children);
    }
  }

  const topLevel = repos.filter((r) => r.worktreeOf === undefined);
  const groups: RepoGroup[] = topLevel.map((repo) => ({
    repo,
    worktrees: worktreesByParent.get(repo.relPath) ?? [],
  }));

  return { groups, topLevelCount: topLevel.length };
}

/**
 * 자식 워크트리의 경로를 부모 기준 상대경로로 변환한다.
 * 예: childRelPath="repos/main/.worktrees/feat", parentRelPath="repos/main" → ".worktrees/feat"
 */
export function relativeToParent(childRelPath: string, parentRelPath: string): string {
  if (parentRelPath === "") return childRelPath;
  // 경로 구분자 정규화 (서버가 OS 구분자로 전송할 수 있음)
  const childNorm = childRelPath.replace(/\\/g, "/");
  const parentNorm = parentRelPath.replace(/\\/g, "/");
  const prefix = parentNorm + "/";
  if (childNorm.startsWith(prefix)) {
    return childNorm.slice(prefix.length);
  }
  return childNorm;
}
