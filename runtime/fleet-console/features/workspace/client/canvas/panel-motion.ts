import { prefersReducedMotion } from "./canvas-store.js";

// 존재 전환 안무 — 최소화/복원 시 패널과 사이드바 칩(Zen에서는 작업 표시줄 항목) 사이를 잇는 고스트 flight.
// 상태 커밋을 지연·블로킹하지 않는 fire-and-forget 연출 레이어다.

const ARRIVAL_PULSE_DURATION_MS = 600;
const FALLBACK_DURATION_MS = 360;
const FALLBACK_EASING = "cubic-bezier(0.4, 0.14, 0.2, 1)";

export interface FlightTiming {
  readonly duration: number;
  readonly easing: string;
}

// 최소화 flight: 상태 커밋 직전에 호출한다 — 패널 rect를 즉시 캡처하고,
// 커밋 후 다음 프레임에 칩 rect를 조회해 패널→칩으로 고스트를 날린다.
// 양 끝점이 실제로 보일 때만 난다 — 접힌 사이드바의 칩이나 focus layer 뒤 히든 피어는
// visibility:hidden이어도 rect가 유효해, 가드 없이는 보이지 않는 지점에서 고스트가 나타난다.
export function playMinimizeFlight(operationId: string): void {
  if (typeof document === "undefined" || prefersReducedMotion()) return;
  const panel = panelElement(operationId);
  if (!isVisiblyRendered(panel)) return;
  const from = panel.getBoundingClientRect();
  window.requestAnimationFrame(() => {
    const chip = chipElement(operationId);
    // War Room의 좁은 레일은 개별 칩 대신 최소화 선반의 건수만 보여 준다.
    const target = isVisiblyRendered(chip)
      ? chip
      : document.querySelector<HTMLElement>("[data-panel-motion-shelf]");
    if (!isVisiblyRendered(target)) return;
    flyPanelMotionGhost(from, target.getBoundingClientRect(), () => pulseChip(target));
  });
}

// 복원 flight: 상태 커밋 지점에서 호출한다 — 칩 rect를 즉시 캡처하고,
// 다음 프레임에 패널 rect를 조회해 칩→패널로 역방향 flight. 패널 본체 페이드인은 CSS 소유.
export function playRestoreFlight(operationId: string): void {
  if (typeof document === "undefined" || prefersReducedMotion()) return;
  const chip = chipElement(operationId);
  if (!isVisiblyRendered(chip)) return;
  const from = chip.getBoundingClientRect();
  window.requestAnimationFrame(() => {
    const panel = panelElement(operationId);
    if (!isVisiblyRendered(panel)) return;
    flyPanelMotionGhost(from, panel.getBoundingClientRect());
  });
}

function panelElement(operationId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(operationId)}"]`);
}

// Zen은 사이드바를 걷어(visibility:hidden) 칩이 보이지 않는다 — 그때는 같은 Operation의 작업 표시줄 항목이
// 비행의 끝점이고, 항목이 접힌 묶음 속에 들어가 막대에 없으면 그 묶음의 이름·칩이 끝점이다.
// 사이드바를 잠깐 드러낸 Zen에서는 보이는 사이드바 칩이 그대로 끝점이다.
function chipElement(operationId: string): HTMLElement | null {
  const id = escapeSelectorValue(operationId);
  const sideBarChip = document.querySelector<HTMLElement>(`[data-side-bar-chip-id="${id}"]`);
  const candidates = [
    sideBarChip,
    document.querySelector<HTMLElement>(`[data-zen-op="${id}"]`),
    document.querySelector<HTMLElement>(`[data-zen-fold-ops~="${id}"]`),
  ];
  return candidates.find(isVisiblyRendered) ?? sideBarChip;
}

function isVisiblyRendered(element: HTMLElement | null): element is HTMLElement {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return getComputedStyle(element).visibility !== "hidden";
}

// jsdom 등 CSS 전역이 없는 환경 폴백 — 속성값 셀렉터의 인용부호·역슬래시만 이스케이프하면 충분하다.
export function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

export function flyPanelMotionGhost(from: DOMRect, to: DOMRect, onArrive?: () => void): void {
  if (typeof document === "undefined" || prefersReducedMotion()) return;
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return;
  const ghost = document.createElement("div");
  ghost.className = "panel-motion-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  ghost.style.width = `${from.width}px`;
  ghost.style.height = `${from.height}px`;
  if (typeof ghost.animate !== "function") return;
  document.body.appendChild(ghost);
  const { duration, easing } = flightTiming();
  // idempotent cleanup + fallback 타이머 — finish/cancel이 오지 않는 부분 WAAPI 구현이나
  // animate() 예외에서도 고스트가 DOM에 잔존하지 않게 상한을 둔다.
  let settled = false;
  let guardTimer: number | null = null;
  const finish = (arrived: boolean) => {
    if (settled) return;
    settled = true;
    if (guardTimer !== null) window.clearTimeout(guardTimer);
    ghost.remove();
    if (arrived) onArrive?.();
  };
  let animation: Animation;
  try {
    animation = ghost.animate(
      [
        { transform: "translate(0, 0) scale(1, 1)", opacity: 0.9 },
        {
          transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`,
          opacity: 0,
        },
      ],
      { duration, easing },
    );
  } catch {
    finish(false);
    return;
  }
  guardTimer = window.setTimeout(() => finish(true), duration + 120);
  animation.onfinish = () => finish(true);
  animation.oncancel = () => finish(false);
}

function pulseChip(chip: HTMLElement): void {
  chip.classList.add("is-arrival-pulse");
  window.setTimeout(() => chip.classList.remove("is-arrival-pulse"), ARRIVAL_PULSE_DURATION_MS);
}

// duration/easing은 테마 토큰(--duration-slow/--ease-glide)을 우선 읽고, 실패 시 토큰 정의와 같은 값으로 폴백한다.
export function flightTiming(): FlightTiming {
  try {
    const styles = getComputedStyle(document.documentElement);
    return {
      duration: parseDurationMs(styles.getPropertyValue("--duration-slow")) ?? FALLBACK_DURATION_MS,
      easing: styles.getPropertyValue("--ease-glide").trim() || FALLBACK_EASING,
    };
  } catch {
    return { duration: FALLBACK_DURATION_MS, easing: FALLBACK_EASING };
  }
}

function parseDurationMs(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(trimmed);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]!);
  return match[2] === "s" ? amount * 1000 : amount;
}

// 모드 전환 FLIP — 재부모화(덱 칸 portal)로 좌표 전이가 끊긴 패널을, 새 자리에서 옛 자리로의
// 역변환을 걸었다가 풀어 실제 요소째 옮긴다. 조상 줌(k)은 화면 rect와 요소 자체 크기의 비로
// 읽는다 — 월드 transform 안의 패널은 화면 px 이동량을 그 배율로 나눠야 제자리에 선다.
export function flyPanelBetweenRects(element: HTMLElement, from: DOMRect, to: DOMRect, timing: FlightTiming, delay: number): boolean {
  if (typeof element.animate !== "function") return false;
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return false;
  if (Math.abs(from.left - to.left) < 0.5 && Math.abs(from.top - to.top) < 0.5
    && Math.abs(from.width - to.width) < 0.5 && Math.abs(from.height - to.height) < 0.5) return false;
  const k = element.offsetWidth > 0 ? to.width / element.offsetWidth : 1;
  const previousOrigin = element.style.transformOrigin;
  element.style.transformOrigin = "0 0";
  const restore = () => { element.style.transformOrigin = previousOrigin; };
  try {
    const animation = element.animate(
      [
        { transform: `translate(${(from.left - to.left) / k}px, ${(from.top - to.top) / k}px) scale(${from.width / to.width}, ${from.height / to.height})` },
        { transform: "none" },
      ],
      { duration: timing.duration, easing: timing.easing, delay, fill: "backwards" },
    );
    animation.onfinish = restore;
    animation.oncancel = restore;
    return true;
  } catch {
    restore();
    return false;
  }
}
