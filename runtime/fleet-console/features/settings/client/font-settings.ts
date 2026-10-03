import { fontFamilyForAxis, type ConsoleFontSettings } from "@fleet-console/sdk/settings/fonts";

export function applyFontSettingsToDocument(fonts: ConsoleFontSettings): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const axis of ["ui", "content", "code"] as const) {
    style.setProperty(`--font-${axis}`, fontFamilyForAxis(fonts, axis));
    style.setProperty(`--font-${axis}-size`, `${fonts[axis].size}px`);
  }
  style.setProperty("--font-ui-scale", String(fonts.ui.size / 14));
  document.documentElement.setAttribute("data-ui-font", fonts.ui.font.source);
}
