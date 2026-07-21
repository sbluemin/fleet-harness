import type { RepoCandidate } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface RepoTreeNode {
  dirs: { [key: string]: RepoTreeNode };
  repos: RepoCandidate[];
}

// ─── buildRepoTree ───────────────────────────────────────────────────────────

/**
 * nested 저장소의 relPath를 디렉터리 세그먼트로 분해해 트리를 구성한다.
 * 각 저장소는 자신의 relPath 마지막 세그먼트가 곧 자기 디렉터리이므로,
 * pop 후 나머지 상위 세그먼트만 dirs 체인으로 만들고 리프에 저장소를 담는다.
 * (repository-tree.tsx의 buildDiffTree와 같은 관용구.)
 * 각 노드의 dirs·repos는 알파벳(localeCompare)으로 정렬한다 —
 * 스캔 DFS 순 그대로 노출하면 사용자가 위치를 예측하기 어렵다.
 */
export function buildRepoTree(repos: readonly RepoCandidate[]): RepoTreeNode {
  const root: RepoTreeNode = { dirs: {}, repos: [] };
  for (const repo of repos) {
    const parts = repo.relPath.split("/").filter((segment) => segment.length > 0);
    if (parts.length === 0) continue;
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs[part]) node.dirs[part] = { dirs: {}, repos: [] };
      node = node.dirs[part]!;
    }
    node.repos.push(repo);
  }
  sortNode(root);
  return root;
}

function sortNode(node: RepoTreeNode): void {
  node.repos.sort((a, b) => a.name.localeCompare(b.name));
  const entries = Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b));
  node.dirs = {};
  for (const [key, child] of entries) {
    sortNode(child);
    node.dirs[key] = child;
  }
}

// ─── countRepos ──────────────────────────────────────────────────────────────

export function countRepos(node: RepoTreeNode): number {
  let total = node.repos.length;
  for (const child of Object.values(node.dirs)) total += countRepos(child);
  return total;
}
