import type { BrowserWindow, Display, Rectangle } from "electron";

/**
 * Windows WCO 캡션 버튼(최소화/최대화/닫기)의 배치는 창 생성 시점에 시스템(주 모니터)
 * 배율로 굳고, 배율이 다른 모니터로 이동해도 Electron이 스스로 재배치하지 않는다
 * (electron/electron#36200·#36791 계열). 다행히 `setTitleBarOverlay`는 값이 같아도 항상
 * `InvalidateCaptionButtons()`로 재배치를 강제하고, 그 재배치는 현재 모니터 배율을 올바르게
 * 쓴다 — 그래서 창이 배율이 다른 모니터에 놓일 때마다 오버레이를 다시 적용하는 것으로
 * 스테일 배치를 치유한다.
 *
 * 높이는 페이지 줌을 따라간다: Command Band(CSS 44px)는 줌에 비례해 커지고 작아지지만
 * 네이티브 오버레이 DIP 높이는 줌과 무관하므로, `round(height × 줌)`을 적용해야 어느
 * 줌에서든 스트립이 밴드의 실제 크기와 정합한다. 줌 1에서는 원값 그대로다.
 */

export interface OverlayRefreshWindow extends Pick<BrowserWindow, "isDestroyed" | "getBounds" | "setTitleBarOverlay"> {
  on(event: "moved", listener: () => void): this;
  removeListener(event: "moved", listener: () => void): this;
}

type DisplayMetricsListener = (event: unknown, display: Display, changedMetrics: string[]) => void;

export interface OverlayRefreshScreen {
  getDisplayMatching(rect: Rectangle): Display;
  on(event: "display-metrics-changed", listener: DisplayMetricsListener): this;
  removeListener(event: "display-metrics-changed", listener: DisplayMetricsListener): this;
}

export interface DesktopTitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export interface TitleBarOverlayRefresher {
  /** 오버레이 스냅샷을 교체해 즉시 적용한다(테마 변경). */
  applyOverlay(overlay: DesktopTitleBarOverlay): void;
  /** 배율·줌이 바뀌었을 수 있는 신호 — 적용 높이나 모니터 배율이 실제로 달라졌을 때만 재적용한다. */
  refresh(): void;
  stop(): void;
}

export interface TitleBarOverlayRefresherDeps {
  readonly screen: OverlayRefreshScreen;
  readonly initialOverlay: DesktopTitleBarOverlay;
  readonly getZoomFactor?: () => number;
  readonly refreshDelayMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

// 배율 전환 직후의 재적용은 무시될 수 있어 한 박자 늦춘다(electron/electron#36791의 실측 지연).
// 드래그 중 연속되는 moved 이벤트의 디바운스 간격도 겸한다.
export const OVERLAY_REFRESH_DELAY_MS = 100;

export function zoomedOverlayHeight(height: number, zoomFactor: number): number {
  if (!(zoomFactor > 0)) return height;
  return Math.max(1, Math.round(height * zoomFactor));
}

export function createTitleBarOverlayRefresher(
  window: OverlayRefreshWindow,
  deps: TitleBarOverlayRefresherDeps,
): TitleBarOverlayRefresher {
  const schedule = deps.setTimeout ?? globalThis.setTimeout;
  const cancelSchedule = deps.clearTimeout ?? globalThis.clearTimeout;
  const refreshDelayMs = deps.refreshDelayMs ?? OVERLAY_REFRESH_DELAY_MS;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let overlay: DesktopTitleBarOverlay = deps.initialOverlay;
  let appliedHeight: number | null = null;
  let appliedScaleFactor: number | null = null;

  const measure = (): { height: number; currentScaleFactor: number } => {
    const currentScaleFactor = deps.screen.getDisplayMatching(window.getBounds()).scaleFactor;
    const zoomFactor = deps.getZoomFactor?.() ?? 1;
    return { height: zoomedOverlayHeight(overlay.height, zoomFactor), currentScaleFactor };
  };

  // 같은 높이라도 모니터 배율이 달라졌으면 스테일 배치다 — 재적용만이 현재 배율로 되돌린다.
  const upToDate = (measured: { height: number; currentScaleFactor: number }): boolean =>
    measured.height === appliedHeight && measured.currentScaleFactor === appliedScaleFactor;

  const apply = (): void => {
    if (stopped || window.isDestroyed()) return;
    const { height, currentScaleFactor } = measure();
    window.setTitleBarOverlay({ color: overlay.color, symbolColor: overlay.symbolColor, height });
    appliedHeight = height;
    appliedScaleFactor = currentScaleFactor;
  };

  const cancelPending = (): void => {
    if (pending !== null) cancelSchedule(pending);
    pending = null;
  };

  const scheduleRefresh = (): void => {
    cancelPending();
    pending = schedule(() => {
      pending = null;
      if (stopped || window.isDestroyed()) return;
      if (upToDate(measure())) return;
      apply();
    }, refreshDelayMs);
  };

  const maybeRefresh = (): void => {
    if (stopped || window.isDestroyed()) return;
    if (upToDate(measure()) && pending === null) return;
    scheduleRefresh();
  };

  const onDisplayMetricsChanged: DisplayMetricsListener = (_event, _display, changedMetrics) => {
    if (!changedMetrics.includes("scaleFactor")) return;
    maybeRefresh();
  };

  window.on("moved", maybeRefresh);
  deps.screen.on("display-metrics-changed", onDisplayMetricsChanged);
  // 생성자 옵션의 오버레이는 시스템 배율 배치로 시작한다 — 창이 주 모니터 밖에서 열렸어도
  // 첫 적용이 곧바로 현재 모니터 배율로 바로잡도록 여기서 한 번 적용한다.
  apply();

  return {
    applyOverlay(next: DesktopTitleBarOverlay): void {
      overlay = next;
      cancelPending();
      apply();
    },
    refresh(): void {
      maybeRefresh();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelPending();
      window.removeListener("moved", maybeRefresh);
      deps.screen.removeListener("display-metrics-changed", onDisplayMetricsChanged);
    },
  };
}
