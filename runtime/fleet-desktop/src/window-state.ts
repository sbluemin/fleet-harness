import type { WindowState, WindowStateStore } from "./desktop-state.js";

export const DEFAULT_WINDOW_WIDTH = 1440;
export const DEFAULT_WINDOW_HEIGHT = 900;
export const MIN_WINDOW_WIDTH = 900;
export const MIN_WINDOW_HEIGHT = 560;
/** 작은 화면에서 기본 크기가 작업 영역을 넘지 않게 하는 상한 비율. */
const WORK_AREA_SHARE = 0.9;
/** 저장된 창이 어느 모니터와 이만큼은 겹쳐야 다시 쓴다 — 모니터가 빠져 창이 화면 밖에 갇히지 않게 한다. */
const MIN_VISIBLE_WIDTH = 200;
const MIN_VISIBLE_HEIGHT = 100;
const SAVE_DEBOUNCE_MS = 400;

export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface InitialWindow {
  readonly bounds: Rect;
  readonly maximized: boolean;
}

/**
 * 첫 창의 자리와 크기. 저장값이 지금 모니터와 충분히 겹치면 그대로(크기는 그 모니터 작업 영역 안으로),
 * 아니면 주 모니터 가운데에 기본 크기(작은 화면은 작업 영역의 90%)로 연다.
 */
export function resolveInitialWindow(saved: WindowState | null, workAreas: readonly Rect[], primaryWorkArea: Rect): InitialWindow {
  if (saved) {
    const host = workAreas
      .map((area) => ({ area, overlap: intersection(saved, area) }))
      .filter(({ overlap }) => overlap.width >= MIN_VISIBLE_WIDTH && overlap.height >= MIN_VISIBLE_HEIGHT)
      .sort((a, b) => b.overlap.width * b.overlap.height - a.overlap.width * a.overlap.height)[0];
    if (host) {
      return {
        bounds: {
          x: Math.round(saved.x),
          y: Math.round(saved.y),
          width: Math.max(MIN_WINDOW_WIDTH, Math.min(Math.round(saved.width), host.area.width)),
          height: Math.max(MIN_WINDOW_HEIGHT, Math.min(Math.round(saved.height), host.area.height)),
        },
        maximized: saved.maximized,
      };
    }
  }
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(DEFAULT_WINDOW_WIDTH, Math.floor(primaryWorkArea.width * WORK_AREA_SHARE)));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(DEFAULT_WINDOW_HEIGHT, Math.floor(primaryWorkArea.height * WORK_AREA_SHARE)));
  return {
    bounds: {
      x: Math.round(primaryWorkArea.x + (primaryWorkArea.width - width) / 2),
      y: Math.round(primaryWorkArea.y + (primaryWorkArea.height - height) / 2),
      width,
      height,
    },
    maximized: false,
  };
}

function intersection(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

export interface TrackedWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  /** 최대화·최소화·전체화면 중에도 normal 상태의 자리와 크기를 돌려준다. */
  getNormalBounds(): Rect;
  on(event: "resize" | "move" | "maximize" | "unmaximize" | "close", listener: () => void): unknown;
  once(event: "closed", listener: () => void): unknown;
}

export interface WindowStateTracker {
  stop(): void;
}

/** 이동·크기·최대화 변경을 잠시 모아 저장하고, 닫을 때 마지막으로 한 번 더 저장한다. 최대화 중에는 최대화 전 크기를 저장한다. */
export function trackWindowState(window: TrackedWindow, store: WindowStateStore, debounceMs: number = SAVE_DEBOUNCE_MS): WindowStateTracker {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const save = (): void => {
    clear();
    if (stopped || window.isDestroyed()) return;
    try {
      const { x, y, width, height } = window.getNormalBounds();
      store.save({ x, y, width, height, maximized: window.isMaximized() });
    } catch {
      // 창 상태 기억은 최선 노력이다.
    }
  };
  const schedule = (): void => {
    if (stopped) return;
    clear();
    timer = setTimeout(save, debounceMs);
  };
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("close", save);
  const stop = (): void => {
    stopped = true;
    clear();
  };
  window.once("closed", stop);
  return { stop };
}
