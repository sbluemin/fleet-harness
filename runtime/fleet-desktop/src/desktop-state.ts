import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ZOOM_LEVEL = 0;
export const MIN_ZOOM_LEVEL = -3;
export const MAX_ZOOM_LEVEL = 3;

/** Chromium 줌 레벨을 배율로 바꾼다 — 레벨 한 칸이 1.2배다(webContents.setZoomLevel과 같은 식). */
export function zoomFactorForLevel(zoomLevel: number): number {
  return 1.2 ** clampZoomLevel(zoomLevel);
}

interface DesktopStateFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  renameSync(oldPath: string, newPath: string): void;
}

export interface ZoomState {
  load(): number;
  save(zoomLevel: number): void;
}

/** 마지막 메인 창. 좌표·크기는 최대화 전(normal) 값이고, 최대화 여부는 따로 둔다. */
export interface WindowState {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
}

export interface WindowStateStore {
  load(): WindowState | null;
  save(state: WindowState): void;
}

/** desktop-state.json 한 파일을 줌과 창이 나눠 쓴다 — 한쪽을 쓸 때 다른 쪽을 지우지 않는다. */
export interface DesktopState {
  readonly zoom: ZoomState;
  readonly window: WindowStateStore;
}

export function clampZoomLevel(zoomLevel: number): number {
  if (!Number.isFinite(zoomLevel)) return DEFAULT_ZOOM_LEVEL;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, zoomLevel));
}

interface PersistedDesktopState {
  zoomLevel?: number;
  window?: WindowState;
}

export function createDesktopState(statePath: string, fileSystem: DesktopStateFileSystem = fs): DesktopState {
  const temporaryPath = `${statePath}.tmp`;
  // 필드마다 따로 검증한다 — 깨진 창 값이 줌을, 깨진 줌 값이 창을 버리게 하지 않는다.
  const read = (): PersistedDesktopState => {
    try {
      const parsed: unknown = JSON.parse(fileSystem.readFileSync(statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      const record = parsed as Record<string, unknown>;
      const state: PersistedDesktopState = {};
      if (typeof record.zoomLevel === "number") state.zoomLevel = record.zoomLevel;
      const window = parseWindowState(record.window);
      if (window) state.window = window;
      return state;
    } catch {
      return {};
    }
  };
  const write = (patch: PersistedDesktopState): void => {
    try {
      fileSystem.mkdirSync(path.dirname(statePath), { recursive: true });
      fileSystem.writeFileSync(temporaryPath, `${JSON.stringify({ ...read(), ...patch })}\n`, "utf8");
      fileSystem.renameSync(temporaryPath, statePath);
    } catch {
      // 영속은 최선 노력이다 — 읽기 전용 userData가 Console을 멈추게 하지 않는다.
    }
  };
  return {
    zoom: {
      load: () => clampZoomLevel(read().zoomLevel ?? DEFAULT_ZOOM_LEVEL),
      save: (zoomLevel) => write({ zoomLevel: clampZoomLevel(zoomLevel) }),
    },
    window: {
      load: () => read().window ?? null,
      save: (state) => write({ window: state }),
    },
  };
}

function parseWindowState(value: unknown): WindowState | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height, maximized } = value as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height, maximized: maximized === true };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
