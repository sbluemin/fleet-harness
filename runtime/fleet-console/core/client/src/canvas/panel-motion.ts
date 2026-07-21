import { panelMotionSuppressed } from "./canvas-store.js";

// 존재 전환 안무 — 최소화/복원 시 패널과 사이드바 칩 사이를 잇는 고스트 flight.
// 상태 커밋을 지연·블로킹하지 않는 fire-and-forget 연출 레이어다.

const ARRIVAL_PULSE_DURATION_MS = 600;
const FALLBACK_DURATION_MS = 360;
const FALLBACK_EASING = "cubic-bezier(0.4, 0.14, 0.2, 1)";

interface FlightTiming {
  readonly duration: number;
  readonly easing: string;
}

// 최소화 flight: 상태 커밋 직전에 호출한다 — 패널 rect를 즉시 캡처하고,
// 커밋 후 다음 프레임에 칩 rect를 조회해 패널→칩으로 고스트를 날린다.
// 양 끝점이 실제로 보일 때만 난다 — 접힌 사이드바의 칩이나 focus layer 뒤 히든 피어는
// visibility:hidden이어도 rect가 유효해, 가드 없이는 보이지 않는 지점에서 고스트가 나타난다.
export function playMinimizeFlight(operationId: string): void {
  if (typeof document === "undefined" || panelMotionSuppressed()) return;
  const panel = panelElement(operationId);
  if (!isVisiblyRendered(panel)) return;
  const from = panel.getBoundingClientRect();
  window.requestAnimationFrame(() => {
    const chip = chipElement(operationId);
    if (!isVisiblyRendered(chip)) return;
    flyGhost(from, chip.getBoundingClientRect(), () => pulseChip(chip));
  });
}

// 복원 flight: 상태 커밋 지점에서 호출한다 — 칩 rect를 즉시 캡처하고,
// 다음 프레임에 패널 rect를 조회해 칩→패널로 역방향 flight. 패널 본체 페이드인은 CSS 소유.
export function playRestoreFlight(operationId: string): void {
  if (typeof document === "undefined" || panelMotionSuppressed()) return;
  const chip = chipElement(operationId);
  if (!isVisiblyRendered(chip)) return;
  const from = chip.getBoundingClientRect();
  window.requestAnimationFrame(() => {
    const panel = panelElement(operationId);
    if (!isVisiblyRendered(panel)) return;
    flyGhost(from, panel.getBoundingClientRect());
  });
}

function panelElement(operationId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(operationId)}"]`);
}

function chipElement(operationId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-side-bar-chip-id="${escapeSelectorValue(operationId)}"]`);
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

function flyGhost(from: DOMRect, to: DOMRect, onArrive?: () => void): void {
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
function flightTiming(): FlightTiming {
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
