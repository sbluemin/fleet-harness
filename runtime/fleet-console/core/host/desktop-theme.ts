import type { ConsoleThemeId, DesktopThemeSnapshot } from "@fleet-console/desktop-protocol";

const DESKTOP_TITLE_BAR_OVERLAYS: Readonly<Record<ConsoleThemeId, DesktopThemeSnapshot["titleBarOverlay"]>> = {
  instrument: { color: "#090f15", symbolColor: "#989fa6", height: 44 },
  maritime: { color: "#041729", symbolColor: "#c8c4b7", height: 44 },
  carbon: { color: "#101215", symbolColor: "#bfc1c3", height: 44 },
};

export function desktopThemeSnapshot(theme: ConsoleThemeId): DesktopThemeSnapshot {
  return { theme, titleBarOverlay: { ...DESKTOP_TITLE_BAR_OVERLAYS[theme] } };
}
