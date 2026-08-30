export const MIN_VIEWER_PX = 200;
export const MIN_TREE_PX = 160;
export const CHIP_STRIP_GAP_PX = 4;

/**
 * 동명 파일이 2개 이상 열려 있을 때만 각 칩에 붙일 디렉터리 힌트(relativePath → "…dir/").
 * 부모 한 조각으로 안 갈리는 흔한 배치(src/components/index.ts vs tests/components/index.ts)가 있으므로,
 * 그룹 안에서 서로 갈릴 때까지 디렉터리 서픽스를 뒤에서부터 늘린 최단 유니크 서픽스를 쓴다.
 * 루트 파일의 힌트는 "/" — 루트에 있다는 사실 자체가 구분 정보다.
 */
export function chipDirHints(
  docs: readonly { readonly relativePath: string; readonly name: string }[],
): ReadonlyMap<string, string> {
  const groups = new Map<string, { readonly relativePath: string; readonly dirs: readonly string[] }[]>();
  for (const doc of docs) {
    const dirs = doc.relativePath.split("/").filter(Boolean).slice(0, -1);
    const bucket = groups.get(doc.name);
    const item = { relativePath: doc.relativePath, dirs };
    if (bucket) bucket.push(item);
    else groups.set(doc.name, [item]);
  }
  const hints = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const maxDepth = Math.max(...group.map((item) => item.dirs.length));
    let depth = 1;
    for (; depth < maxDepth; depth += 1) {
      const suffixes = new Set(group.map((item) => item.dirs.slice(-depth).join("/")));
      if (suffixes.size === group.length) break;
    }
    for (const item of group) {
      const suffix = item.dirs.slice(-depth).join("/");
      hints.set(item.relativePath, suffix ? `${suffix}/` : "/");
    }
  }
  return hints;
}

/** Chips whose box is not fully inside the visible strip. */
export function countOverflowingChips(
  containerWidth: number,
  scrollLeft: number,
  itemWidths: readonly number[],
  gap: number = CHIP_STRIP_GAP_PX,
): number {
  if (containerWidth <= 0 || itemWidths.length === 0) return 0;
  const viewLeft = scrollLeft;
  const viewRight = scrollLeft + containerWidth;
  let x = 0;
  let hidden = 0;
  for (const width of itemWidths) {
    const left = x;
    const right = x + width;
    if (left + 0.5 < viewLeft || right - 0.5 > viewRight) hidden += 1;
    x += width + gap;
  }
  return hidden;
}
