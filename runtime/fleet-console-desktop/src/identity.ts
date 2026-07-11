export interface DesktopIdentityApp {
  setAppUserModelId?(id: string): void;
  setName(name: string): void;
  readonly dock?: { setIcon(path: string): void };
}

export const DESKTOP_PRODUCT_NAME = "Fleet Console";
export const DESKTOP_APP_USER_MODEL_ID = "com.dotobokuri.fleet-console";

export function applyDesktopIdentity(app: DesktopIdentityApp, platform: NodeJS.Platform = process.platform): void {
  app.setName(DESKTOP_PRODUCT_NAME);
  if (platform === "win32") app.setAppUserModelId?.(DESKTOP_APP_USER_MODEL_ID);
}

export function applyDesktopDockIcon(app: DesktopIdentityApp, iconPath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "darwin") app.dock?.setIcon(iconPath);
}
