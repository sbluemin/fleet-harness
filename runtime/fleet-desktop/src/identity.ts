export interface DesktopIdentityApp {
  setAppUserModelId?(id: string): void;
  setName(name: string): void;
  readonly dock?: { setIcon(path: string): void };
  readonly isPackaged?: boolean;
}

export const DESKTOP_PRODUCT_NAME = "Fleet Console";
export const DESKTOP_APP_USER_MODEL_ID = "com.dotobokuri.fleet-console";

export function applyDesktopIdentity(app: DesktopIdentityApp, platform: NodeJS.Platform = process.platform): void {
  const development = app.isPackaged === false;
  app.setName(development ? `${DESKTOP_PRODUCT_NAME} Dev` : DESKTOP_PRODUCT_NAME);
  if (platform === "win32") app.setAppUserModelId?.(development ? `${DESKTOP_APP_USER_MODEL_ID}.dev` : DESKTOP_APP_USER_MODEL_ID);
}

export function applyDesktopDockIcon(app: DesktopIdentityApp, iconPath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "darwin") app.dock?.setIcon(iconPath);
}
