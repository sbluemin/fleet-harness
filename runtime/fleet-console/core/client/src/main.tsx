import * as reactNs from "react";
import * as reactJsxRuntime from "react/jsx-runtime";
import * as sdkPluginBrowser from "@fleet-console/sdk/plugin/browser";
import * as sdkSettingsBrowser from "@fleet-console/sdk/settings/browser";
import * as sdkOperationsBrowser from "@fleet-console/sdk/operations/browser";
import * as sdkNotificationsBrowser from "@fleet-console/sdk/notifications/browser";
import * as sdkReactBrowser from "@fleet-console/sdk/react/browser";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/standard-italic.css";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/cascadia-code";
import "@fontsource-variable/fira-code";
import "@fontsource-variable/source-code-pro";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";
import { App } from "./app.js";
import { fetchGlobalSettingsState } from "./global-settings-api.js";
import { failGlobalSettingsLoad, getGlobalSettingsStoreState, hydrateGlobalSettings, subscribe as subscribeGlobalSettings } from "./global-settings-store.js";
import { connectOperationsSse } from "./operations-sse.js";
import { loadPluginRegistry, PluginRegistryProvider } from "./plugin-registry.js";
import { applyDesktopShellMarker, migrateStoredCommissioningSeen, readServerInjectedTheme, readStoredThemeHint, setActiveTheme, setActiveUiFont } from "./store.js";

interface FleetConsoleRuntime {
  readonly "react": typeof reactNs;
  readonly "react/jsx-runtime": typeof reactJsxRuntime;
  readonly "@fleet-console/sdk/plugin/browser": typeof sdkPluginBrowser;
  readonly "@fleet-console/sdk/settings/browser": typeof sdkSettingsBrowser;
  readonly "@fleet-console/sdk/operations/browser": typeof sdkOperationsBrowser;
  readonly "@fleet-console/sdk/notifications/browser": typeof sdkNotificationsBrowser;
  readonly "@fleet-console/sdk/react/browser": typeof sdkReactBrowser;
}

declare global {
  var __fleetConsoleRuntime__: FleetConsoleRuntime;
}

globalThis.__fleetConsoleRuntime__ = {
  "react": reactNs,
  "react/jsx-runtime": reactJsxRuntime,
  "@fleet-console/sdk/plugin/browser": sdkPluginBrowser,
  "@fleet-console/sdk/settings/browser": sdkSettingsBrowser,
  "@fleet-console/sdk/operations/browser": sdkOperationsBrowser,
  "@fleet-console/sdk/notifications/browser": sdkNotificationsBrowser,
  "@fleet-console/sdk/react/browser": sdkReactBrowser,
};

// 서버 주입이 첫 페인트의 권위값이며 theme-hint는 미주입 서빙 경로의 폴백이다.
setActiveTheme(readServerInjectedTheme() ?? readStoredThemeHint() ?? "instrument");
applyDesktopShellMarker();

const syncReducePanelMotionClass = () => {
  document.documentElement.classList.toggle(
    "reduce-panel-motion",
    getGlobalSettingsStoreState().state?.reducePanelMotion === true,
  );
};
subscribeGlobalSettings(syncReducePanelMotionClass);
syncReducePanelMotionClass();

try {
  const settings = await fetchGlobalSettingsState();
  setActiveTheme(settings.theme);
  setActiveUiFont(settings.uiFont);
  hydrateGlobalSettings(settings);
  await migrateStoredCommissioningSeen();
} catch (error) {
  failGlobalSettingsLoad(error);
  // 서버 미응답 시 기본 Theme 및 Manrope UI font를 유지한다.
}

const registry = await loadPluginRegistry();
connectOperationsSse();
const app = document.querySelector("#app");
if (app) {
  createRoot(app).render(
    <StrictMode>
      <BrowserRouter basename="/console">
        <PluginRegistryProvider value={registry}>
          <App />
        </PluginRegistryProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
