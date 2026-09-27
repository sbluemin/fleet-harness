import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

/**
 * 한 페이지가 동시에 살려 둘 수 있는 WebGL 컨텍스트는 Chromium에서 16개다. 그 이상을 만들면 브라우저가
 * 가장 오래된 컨텍스트를 강제로 잃게 하고, 잃은 터미널은 DOM 렌더러로 떨어진다. 터미널이 저마다
 * WebglAddon을 붙이면 패널 17개째부터 어느 터미널이 잃을지는 생성 순서가 정한다 — 지금 보고 있는
 * 패널일 수도 있다. 여기서 슬롯을 나눠 브라우저가 고르기 전에 앱이 고른다: 보이는 터미널만 슬롯을
 * 쥐고(최소화·주차되면 곧바로 내놓는다), 활성 터미널이 먼저다. 여유를 남겨 다른 WebGL 사용처와 겹쳐도
 * 상한에 닿지 않게 한다.
 */
export const TERMINAL_WEBGL_BUDGET = 12;

interface Claim {
  wanted: boolean;
  visible: boolean;
  active: boolean;
  touchedAt: number;
  granted: boolean;
  /** 컨텍스트를 잃은 뒤에는 사용자가 이 터미널을 다시 보거나 고를 때까지 재요청하지 않는다(손실 반복 방지). */
  blockedUntilTouch: boolean;
  /** 같은 터미널을 다시 고른 요청(키보드 포커스 요청 번호) — 이미 활성인 터미널의 재선택도 손대기로 친다. */
  touchKey: number | undefined;
}

const claims = new Map<string, Claim>();
const listeners = new Set<() => void>();
let clock = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function byImportance(left: Claim, right: Claim): number {
  if (left.active !== right.active) return left.active ? -1 : 1;
  return right.touchedAt - left.touchedAt;
}

function oldest(candidates: readonly Claim[]): Claim | undefined {
  return candidates.reduce<Claim | undefined>((found, claim) => (found === undefined || claim.touchedAt < found.touchedAt ? claim : found), undefined);
}

function rebalance(changed = false): void {
  for (const claim of claims.values()) {
    // 화면에서 내려간 터미널은 슬롯을 곧바로 내놓는다 — 보이지 않는 터미널이 GPU 컨텍스트를 쥐고 있을 이유가 없다.
    if (claim.granted && (!claim.wanted || !claim.visible)) {
      claim.granted = false;
      changed = true;
    }
  }
  const waiting = [...claims.values()]
    .filter((claim) => claim.wanted && claim.visible && !claim.granted && !claim.blockedUntilTouch)
    .sort(byImportance);
  for (const claim of waiting) {
    const holders = [...claims.values()].filter((candidate) => candidate.granted);
    if (holders.length < TERMINAL_WEBGL_BUDGET) {
      claim.granted = true;
      changed = true;
      continue;
    }
    // 보유자는 모두 보이는 터미널이다. 활성 터미널을 위해서만, 가장 오래 손대지 않은 비활성 보유자가 비킨다.
    const victim = claim.active ? oldest(holders.filter((holder) => !holder.active)) : undefined;
    if (!victim) break;
    victim.granted = false;
    claim.granted = true;
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}

interface ClaimInput {
  readonly wanted: boolean;
  readonly visible: boolean;
  readonly active: boolean;
  readonly touchKey?: number;
}

function update(key: string, next: ClaimInput): void {
  const claim = claims.get(key);
  if (!claim) {
    claims.set(key, { wanted: next.wanted, visible: next.visible, active: next.active, touchKey: next.touchKey, touchedAt: ++clock, granted: false, blockedUntilTouch: false });
    rebalance();
    return;
  }
  // 포커스가 다른 패널로 가면 이 터미널의 요청 번호는 0으로 돌아간다 — 새 번호가 이 터미널을 가리킬 때만 재선택이다.
  const reselected = !!next.touchKey && next.touchKey !== claim.touchKey;
  const touched = (next.visible && !claim.visible) || (next.active && !claim.active) || reselected;
  if (!touched && claim.wanted === next.wanted && claim.visible === next.visible && claim.active === next.active) return;
  claim.wanted = next.wanted;
  claim.visible = next.visible;
  claim.active = next.active;
  claim.touchKey = next.touchKey;
  if (touched) {
    claim.touchedAt = ++clock;
    claim.blockedUntilTouch = false;
  }
  rebalance();
}

function release(key: string): void {
  if (!claims.delete(key)) return;
  rebalance();
}

/** 브라우저가 이 터미널의 컨텍스트를 거둬 갔다 — 슬롯을 돌려주고, 다시 손댈 때까지 재요청하지 않는다. */
function markLost(key: string): void {
  const claim = claims.get(key);
  if (!claim?.granted) return;
  claim.granted = false;
  claim.blockedUntilTouch = true;
  rebalance(true);
}

let nextKey = 0;

/**
 * 이 터미널이 WebGL 렌더러를 써도 되는지. 원하지 않거나(설정이 DOM) 슬롯을 받지 못하면 false이고,
 * 그때 터미널은 DOM 렌더러로 그린다. 반환하는 onLost는 WebglAddon.onContextLoss에 연결한다.
 */
export function useTerminalWebglGrant(options: ClaimInput): { readonly granted: boolean; readonly onLost: () => void } {
  const keyRef = useRef<string | null>(null);
  if (keyRef.current === null) keyRef.current = `terminal-webgl-${++nextKey}`;
  const key = keyRef.current;
  useLayoutEffect(() => {
    update(key, options);
  }, [key, options.wanted, options.visible, options.active, options.touchKey]);
  useLayoutEffect(() => () => release(key), [key]);
  const granted = useSyncExternalStore(subscribe, () => claims.get(key)?.granted ?? false, () => false);
  return { granted, onLost: () => markLost(key) };
}
