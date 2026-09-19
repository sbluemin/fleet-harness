/**
 * 표면의 기하 — 열이 몇 px을 갖는지 정하는 순수 함수들.
 *
 * 페인 본문은 이 계산에 참여하지 않는다. 계약이 "기하는 표면이 소유한다"고 말하는 자리의
 * 실제 산수가 여기다. 순수 함수로 떼어 둔 이유는 드래그를 재현하지 않고도 클램프를 검증하기
 * 위해서다 — 픽셀 규칙은 포인터 이벤트가 아니라 산수의 성질이다.
 */

/** 열 하나가 내려갈 수 있는 최소 폭. 서술자가 `minWidth`로 더 큰 값을 요구할 수 있다. */
export const MIN_PANE_PX = 160;
export const PANE_DIVIDER_PX = 4;
export const PANE_DIVIDER_KEYBOARD_STEP_PX = 16;
export const PANE_DIVIDER_KEYBOARD_COARSE_STEP_PX = 64;

export interface PaneSplitLimits {
  readonly surfaceWidth: number;
  readonly minPrimary: number;
  readonly minDetail: number;
}

/**
 * 표면 폭을 아직 재지 못했는가.
 *
 * 첫 렌더는 언제나 여기에 걸린다 — 실측은 레이아웃이 한 번 돈 뒤에야 온다. 그 구간에서
 * 폭을 클램프하면 남는 자리가 음수라 primary가 0px으로 접혔다가 다음 프레임에 튀어나온다.
 * 재기 전에는 **자르지 않는 것**이 옳다: 아직 자를 근거가 없다.
 */
function unmeasured(limits: PaneSplitLimits): boolean {
  return !Number.isFinite(limits.surfaceWidth) || limits.surfaceWidth <= 0;
}

/** primary가 가질 수 있는 최대 폭 — 나머지 열들의 최소치와 분할선을 뺀 값. */
export function maxPrimaryWidth({ surfaceWidth, minDetail }: PaneSplitLimits): number {
  return Math.max(0, Math.floor(surfaceWidth - minDetail - PANE_DIVIDER_PX));
}

/** 표면이 두 열을 담을 만큼 넓은가. 아니면 분할선은 잠긴다. */
export function canSplit(limits: PaneSplitLimits): boolean {
  if (unmeasured(limits)) return false;
  return maxPrimaryWidth(limits) > limits.minPrimary;
}

export function clampPrimaryWidth(desired: number, limits: PaneSplitLimits): number {
  if (!Number.isFinite(desired)) return limits.minPrimary;
  if (unmeasured(limits)) return Math.max(limits.minPrimary, Math.round(desired));
  const max = maxPrimaryWidth(limits);
  if (max <= limits.minPrimary) return max;
  return Math.max(limits.minPrimary, Math.min(max, Math.round(desired)));
}

export interface PaneSeparatorState {
  readonly currentWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly canResize: boolean;
  readonly tabIndex: 0 | -1;
  readonly ariaDisabled: true | undefined;
}

export function paneSeparatorState(desired: number, limits: PaneSplitLimits): PaneSeparatorState {
  const resizable = canSplit(limits);
  const currentWidth = clampPrimaryWidth(desired, limits);
  return {
    currentWidth,
    minWidth: resizable ? limits.minPrimary : currentWidth,
    // 잠긴 분할선이 현재 폭 밖의 최대치를 말하면 보조기술은 끌 수 있는 것으로 읽는다.
    maxWidth: resizable ? maxPrimaryWidth(limits) : currentWidth,
    canResize: resizable,
    tabIndex: resizable ? 0 : -1,
    ariaDisabled: resizable ? undefined : true,
  };
}

/**
 * 키보드 한 스텝 뒤의 primary 폭.
 *
 * 분할선은 primary 왼쪽에 서므로 ← 는 경계를 왼쪽으로 밀어 primary를 **넓힌다** — 레일 바깥
 * 손잡이와 같은 방향이다. 두 손잡이가 같은 화살표에 반대로 움직이면 어느 쪽을 잡았는지에
 * 따라 결과가 뒤집힌다.
 */
export function resizePrimaryWithKeyboard(
  current: number,
  key: string,
  limits: PaneSplitLimits,
  coarse = false,
): number {
  const step = coarse ? PANE_DIVIDER_KEYBOARD_COARSE_STEP_PX : PANE_DIVIDER_KEYBOARD_STEP_PX;
  switch (key) {
    case "ArrowLeft":
      return clampPrimaryWidth(clampPrimaryWidth(current, limits) + step, limits);
    case "ArrowRight":
      return clampPrimaryWidth(clampPrimaryWidth(current, limits) - step, limits);
    case "Home":
      return clampPrimaryWidth(limits.minPrimary, limits);
    case "End":
      return clampPrimaryWidth(maxPrimaryWidth(limits), limits);
    default:
      return current;
  }
}
