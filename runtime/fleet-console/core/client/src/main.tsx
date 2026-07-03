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
import { connectOperationsSse } from "./operations-sse.js";
import { loadPluginRegistry, PluginRegistryProvider } from "./plugin-registry.js";
import { setActiveTheme } from "./store.js";

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

try {
  const settings = await fetchGlobalSettingsState();
  setActiveTheme(settings.theme);
} catch {
  // 서버 미응답 시 DEFAULT_THEME 유지
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
