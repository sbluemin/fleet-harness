import type { RepoCandidate } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface RepoTreeNode {
  dirs: { [key: string]: RepoTreeNode };
  repos: RepoCandidate[];
}

// "__proto__" 같은 유효한 디렉터리명이 상속 프로퍼티와 충돌하지 않도록 null-prototype 사전을 쓴다.
function createDirs(): { [key: string]: RepoTreeNode } {
  return Object.create(null) as { [key: string]: RepoTreeNode };
}

function createNode(): RepoTreeNode {
  return { dirs: createDirs(), repos: [] };
}

// ─── buildRepoTree ───────────────────────────────────────────────────────────

/**
 * nested 저장소의 relPath를 디렉터리 세그먼트로 분해해 트리를 구성한다.
 * 각 저장소는 자신의 relPath 마지막 세그먼트가 곧 자기 디렉터리이므로,
 * pop 후 나머지 상위 세그먼트만 dirs 체인으로 만들고 리프에 저장소를 담는다.
 * (repository-tree.tsx의 buildDiffTree와 같은 관용구.)
 * 각 노드의 dirs·repos는 알파벳(localeCompare)으로 정렬한다 —
 * 스캔 DFS 순 그대로 노출하면 사용자가 위치를 예측하기 어렵다.
 * 서버 relPath는 path.relative 결과라 OS 종속 구분자를 쓴다 — 세그먼트 분해에만
 * `\`→`/` 정규화 복사본을 쓰고, RepoCandidate 원본은 변형하지 않는다(선택/전환 계약).
 */
export function buildRepoTree(repos: readonly RepoCandidate[]): RepoTreeNode {
  const root = createNode();
  for (const repo of repos) {
    const parts = repo.relPath.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
    if (parts.length === 0) continue;
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs[part]) node.dirs[part] = createNode();
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
  node.dirs = createDirs();
  for (const [key, child] of entries) {
    sortNode(child);
    node.dirs[key] = child;
  }
}

// ─── compressRepoFolder ──────────────────────────────────────────────────────

/**
 * VS Code 스타일 폴더 압축: 자식 디렉터리 하나 + 저장소 없음 체인을
 * "a/b" 한 라벨로 합쳐 최종 노드와 함께 돌려준다 (DiffTreeFolder 미러).
 */
export function compressRepoFolder(dirKey: string, node: RepoTreeNode): { label: string; node: RepoTreeNode } {
  let label = dirKey;
  let resolved = node;
  while (Object.keys(resolved.dirs).length === 1 && resolved.repos.length === 0) {
    const onlyKey = Object.keys(resolved.dirs)[0]!;
    label += "/" + onlyKey;
    resolved = resolved.dirs[onlyKey]!;
  }
  return { label, node: resolved };
}

// ─── countRepos ──────────────────────────────────────────────────────────────

export function countRepos(node: RepoTreeNode): number {
  let total = node.repos.length;
  for (const child of Object.values(node.dirs)) total += countRepos(child);
  return total;
}
