export const DESKTOP_FULLSCREEN_PATH = "/api/v1/desktop/fullscreen";
export const DESKTOP_FULLSCREEN_EVENT = "desktop:fullscreen";

export interface DesktopFullscreenSnapshot {
  readonly fullscreen: boolean;
}

export const desktopFullscreenSnapshot = (fullscreen: boolean): DesktopFullscreenSnapshot => ({ fullscreen });

export function isDesktopFullscreenSnapshot(value: unknown): value is DesktopFullscreenSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 1 && typeof entry.fullscreen === "boolean";
}
