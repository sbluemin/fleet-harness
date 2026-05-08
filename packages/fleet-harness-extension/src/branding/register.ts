import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";

interface ThemeSettingsLike {
  theme?: unknown;
}

const BUILTIN_THEME_NAMES = new Set(["dark", "light"]);
const FLEET_THEME_NAMES = new Set(["fleet-dark", "fleet-light"]);
const BRAND_THEME_FILES = ["fleet-dark.json", "fleet-light.json"] as const;

export function registerFleetBrandingLifecycle(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    themePaths: getFleetBrandThemePaths(),
  }));

  pi.on("session_start", (_event, ctx) => {
    setTimeout(() => {
      applyFleetBrandingTheme(ctx);
    }, 0);
  });
}

function applyFleetBrandingTheme(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (resolveConfiguredCustomThemeName(ctx.cwd)) return;

  const currentThemeName = ctx.ui.theme.name;
  if (!currentThemeName) return;
  if (FLEET_THEME_NAMES.has(currentThemeName)) return;
  if (!BUILTIN_THEME_NAMES.has(currentThemeName)) return;

  const nextThemeName = currentThemeName === "light" ? "fleet-light" : "fleet-dark";
  ctx.ui.setTheme(nextThemeName);
}

function resolveConfiguredCustomThemeName(cwd: string): string | null {
  const configuredTheme = readThemeSetting(join(cwd, ".pi", "settings.json"))
    ?? readThemeSetting(join(getAgentDir(), "settings.json"));

  if (!configuredTheme) return null;
  if (BUILTIN_THEME_NAMES.has(configuredTheme)) return null;
  if (FLEET_THEME_NAMES.has(configuredTheme)) return null;
  return configuredTheme;
}

function readThemeSetting(settingsPath: string): string | null {
  if (!existsSync(settingsPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as ThemeSettingsLike;
    return typeof parsed.theme === "string" && parsed.theme.length > 0 ? parsed.theme : null;
  } catch {
    return null;
  }
}

function getFleetBrandThemePaths(): string[] {
  const themeDir = fileURLToPath(new URL("./themes/", import.meta.url));
  return BRAND_THEME_FILES.map((fileName) => join(themeDir, fileName));
}
