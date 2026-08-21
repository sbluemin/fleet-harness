import type { Scope, SkillListItem } from "../server/skill-types.js";

// ─── functions ───────────────────────────────────────────────────────────────

/**
 * 카드가 정체성으로 내세우는 필드가 설명이라면 필터도 그 필드를 봐야 한다 — 이름만 보면
 * "browser"로 console-e2e를 찾을 수 없다.
 */
export function filterInstalled(
  inScope: readonly SkillListItem[],
  filterText: string,
): readonly SkillListItem[] {
  const needle = filterText.trim().toLowerCase();
  if (!needle) return inScope;
  return inScope.filter((skill) =>
    skill.name.toLowerCase().includes(needle)
    || (skill.description ?? "").toLowerCase().includes(needle));
}

/**
 * 두 scope는 한 응답에 함께 온다 — 같은 이름이 반대편 scope에도 있다는 사실은 새 요청 없이
 * 이 목록에서 바로 읽힌다. 가림의 방향(어느 쪽이 이기는지)은 카드가 자기 scope로 정한다.
 */
export function namesInOtherScope(
  installedList: readonly SkillListItem[],
  visibleScope: Scope,
): ReadonlySet<string> {
  return new Set(
    installedList.filter((skill) => skill.scope !== visibleScope).map((skill) => skill.name),
  );
}
