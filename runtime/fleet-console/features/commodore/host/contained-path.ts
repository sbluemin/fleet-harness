import fs from "node:fs";
import path from "node:path";

/**
 * 사령관 폴더 안으로만 닿는 경로 판정 두 단계 — 어휘 검증(상대 경로가 root 밖으로 나가지 않는가) 뒤에
 * 링크를 푼 실제 경로 검증을 한다. 홈 오버레이와 플러그인 폴더가 같은 규칙을 써야 하므로 한 벌만 둔다.
 */

/** 어휘로 그 폴더 안에 머무는 상대 경로만. */
export function inside(root: string, relative: unknown): string | null {
  if (typeof relative !== "string" || !relative.trim()) return null;
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

/** 어휘로 안이어도, 링크를 푼 실제 경로가 폴더 밖이면 아니다. 없는 파일은 밖과 같다. */
export function staysInside(root: string, candidate: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch { return false; }
}
