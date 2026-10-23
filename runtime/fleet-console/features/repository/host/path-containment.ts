import path from "node:path";

export function isPathContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * repoRel이 라우트의 어휘 검증을 통과하는 형태인지 판정한다.
 *
 * 발견과 검증이 같은 술어를 써야 한다 — 발견만 통과시키면 선택할 때마다 400을 돌려주는
 * 죽은 행이 목록에 남는다. 빈 문자열은 Theater 루트를 뜻하므로 항상 유효하다.
 */
export function isSelectableRepoRel(repoRel: string): boolean {
  if (repoRel === "") return true;
  if (path.isAbsolute(repoRel)) return false;
  const normalized = path.normalize(repoRel);
  return !normalized.startsWith("-")
    && normalized !== ".."
    && !normalized.startsWith(`..${path.sep}`);
}
