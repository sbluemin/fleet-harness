import { theaterInitials as computeInitials } from "@fleet-console/sdk/components/theater-badge";

// 사이드바 칩·섹션 머리가 렌더마다 부른다 — 이름별 계산 결과만 캐시한다.
const initialsCache = new Map<string, string>();

export function theaterInitials(label: string): string {
  let initials = initialsCache.get(label);
  if (initials === undefined) {
    if (initialsCache.size >= 256) initialsCache.clear();
    initials = computeInitials(label);
    initialsCache.set(label, initials);
  }
  return initials;
}
