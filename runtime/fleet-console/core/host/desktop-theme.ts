import type { ConsoleThemeId } from "./console-settings.js";

export interface DesktopTitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export interface DesktopThemeSnapshot {
  readonly theme: ConsoleThemeId;
  readonly titleBarOverlay: DesktopTitleBarOverlay;
}

export const DESKTOP_THEME_PATH = "/api/v1/desktop/theme";
export const DESKTOP_THEME_EVENTS_PATH = "/api/v1/desktop/theme/events";
export const DESKTOP_THEME_EVENT = "desktop:theme";

const DESKTOP_TITLE_BAR_OVERLAYS: Readonly<Record<ConsoleThemeId, DesktopThemeSnapshot["titleBarOverlay"]>> = {
  instrument: { color: "#03080e", symbolColor: "#989fa6", height: 43 },
  maritime: { color: "#041729", symbolColor: "#c8c4b7", height: 43 },
  carbon: { color: "#101215", symbolColor: "#bfc1c3", height: 43 },
  daywatch: { color: "#e6ecf2", symbolColor: "#3e4953", height: 43 },
  chartroom: { color: "#efe9db", symbolColor: "#3c4555", height: 43 },
  whites: { color: "#eef0f3", symbolColor: "#334055", height: 43 },
  drydock: { color: "#ddeaf2", symbolColor: "#30475d", height: 43 },
};

export function desktopThemeSnapshot(theme: ConsoleThemeId): DesktopThemeSnapshot {
  return { theme, titleBarOverlay: { ...DESKTOP_TITLE_BAR_OVERLAYS[theme] } };
}
