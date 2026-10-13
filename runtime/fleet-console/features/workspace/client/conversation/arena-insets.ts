/** 사이드바와 레일이 가운데 작업면을 밀어낸 가장자리. 대화 칸과 플러그인 지도 폭이 같은 값을 읽는다. */
export interface ArenaInsets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const EMPTY_INSETS: ArenaInsets = { left: 0, top: 0, right: 0, bottom: 0 };

let arenaInsets: ArenaInsets = EMPTY_INSETS;
const listeners = new Set<() => void>();

export function setArenaInsets(insets: ArenaInsets): void {
  const changed = insets.left !== arenaInsets.left
    || insets.right !== arenaInsets.right
    || insets.top !== arenaInsets.top
    || insets.bottom !== arenaInsets.bottom;
  arenaInsets = insets;
  if (changed) for (const listener of [...listeners]) listener();
}

export function getArenaInsets(): ArenaInsets {
  return arenaInsets;
}

export function subscribeArenaInsets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
