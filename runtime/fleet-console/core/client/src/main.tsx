import * as reactNs from "react";
import * as reactJsxRuntime from "react/jsx-runtime";
import * as sdkPluginBrowser from "@fleet-console/sdk/plugin/browser";
import * as sdkSettingsBrowser from "@fleet-console/sdk/settings/browser";
import * as sdkOperationsBrowser from "@fleet-console/sdk/operations/browser";
import * as sdkNotificationsBrowser from "@fleet-console/sdk/notifications/browser";
import * as sdkReactBrowser from "@fleet-console/sdk/react/browser";
import * as sdkComponentsFailureNotice from "@fleet-console/sdk/components/failure-notice";
import * as sdkComponentsEffortTrack from "@fleet-console/sdk/components/effort-track";
import * as sdkComponentsLaunchProviderGlyphs from "@fleet-console/sdk/components/launch-provider-glyphs";
import * as sdkComponentsShellGlyph from "@fleet-console/sdk/components/shell-glyph";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/standard-italic.css";
import "@fontsource-variable/manrope";
// Pretendard dynamic subset: 한글 폴백 서체 — 브라우저가 unicode-range로 필요한 subset woff2만 내려받는다.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
// Nanum Gothic Coding: --font-mono의 한글 폴백. JetBrains Mono·ui-monospace·SF Mono·Menlo 어느 것도 한글
// 글리프가 없어 이 서체가 없으면 mono 표면(캡션·칩·펄스)의 한글만 OS 비례폭 고딕으로 새어 나간다.
// 터미널 플러그인이 같은 서체를 xterm용으로 싣지만, 토큰의 폴백은 토큰을 정의하는 코어가 소유한다.
import "@fontsource/nanum-gothic-coding/korean-400.css";
import "@fontsource/nanum-gothic-coding/korean-700.css";
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
import { readHostPickerSurface } from "./components/command-band-system-cluster.js";
import { HostPickerScreen } from "./components/host-picker-surface.js";
import { fetchGlobalSettingsState } from "./global-settings-api.js";
import { failGlobalSettingsLoad, hydrateGlobalSettings } from "./global-settings-store.js";
import { connectOperationsSse } from "./operations-sse.js";
import { loadPluginRegistry, PluginRegistryProvider } from "./plugin-registry.js";
import { applyDesktopShellMarker, migrateStoredCommissioningSeen, readServerInjectedTheme, readStoredThemeHint, setActiveTheme, setActiveUiFont, setLiquidGlass, setUnfocusedPanelFade } from "./store.js";
import { applyStoredSideBarGlass } from "./sidebar/operations-side-bar-store.js";

interface FleetConsoleRuntime {
  readonly "react": typeof reactNs;
  readonly "react/jsx-runtime": typeof reactJsxRuntime;
  readonly "@fleet-console/sdk/plugin/browser": typeof sdkPluginBrowser;
  readonly "@fleet-console/sdk/settings/browser": typeof sdkSettingsBrowser;
  readonly "@fleet-console/sdk/operations/browser": typeof sdkOperationsBrowser;
  readonly "@fleet-console/sdk/notifications/browser": typeof sdkNotificationsBrowser;
  readonly "@fleet-console/sdk/react/browser": typeof sdkReactBrowser;
  readonly "@fleet-console/sdk/components/failure-notice": typeof sdkComponentsFailureNotice;
  readonly "@fleet-console/sdk/components/effort-track": typeof sdkComponentsEffortTrack;
  readonly "@fleet-console/sdk/components/launch-provider-glyphs": typeof sdkComponentsLaunchProviderGlyphs;
  readonly "@fleet-console/sdk/components/shell-glyph": typeof sdkComponentsShellGlyph;
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
  // shim은 이 네임스페이스에서 실제 모듈을 읽는다 — 정의만 등록하고 여기를 비워 두면
  // 외부 플러그인이 로드되는 순간 "runtime shim unavailable"로 죽는다.
  "@fleet-console/sdk/components/failure-notice": sdkComponentsFailureNotice,
  "@fleet-console/sdk/components/effort-track": sdkComponentsEffortTrack,
  "@fleet-console/sdk/components/launch-provider-glyphs": sdkComponentsLaunchProviderGlyphs,
  "@fleet-console/sdk/components/shell-glyph": sdkComponentsShellGlyph,
};

// 서버 주입이 첫 페인트의 권위값이며 theme-hint는 미주입 서빙 경로의 폴백이다.
setActiveTheme(readServerInjectedTheme() ?? readStoredThemeHint() ?? "instrument");
applyDesktopShellMarker();
// 사이드바 유리 취향은 브라우저-로컬이라 서버 왕복을 기다릴 이유가 없다 — 테마와 같은 줄에서
// 첫 페인트 앞에 실어 두면 기본 재질이 잠깐 스쳤다 바뀌는 일이 없다.
applyStoredSideBarGlass();

try {
  const settings = await fetchGlobalSettingsState();
  setActiveTheme(settings.theme);
  setLiquidGlass(settings.liquidGlass);
  setUnfocusedPanelFade(settings.unfocusedPanelFade);
  setActiveUiFont(settings.uiFont);
  hydrateGlobalSettings(settings);
  await migrateStoredCommissioningSeen();
} catch (error) {
  failGlobalSettingsLoad(error);
  // 서버 미응답 시 기본 Theme 및 Manrope UI font를 유지한다.
}

const app = document.querySelector("#app");
/**
 * 집이 목록만 펼쳐 내주는 표면으로 서빙됐다면 콘솔을 세우지 않는다 — 플러그인도 SSE도
 * 이 화면과 무관하고, 그 둘을 켜는 순간 덮개 한 장이 콘솔 한 벌만큼 무거워진다.
 */
const hostPicker = app ? readHostPickerSurface(location.search) : null;
if (app && hostPicker) {
  document.documentElement.dataset.hostPicker = "true";
  createRoot(app).render(
    <StrictMode>
      <BrowserRouter basename="/console">
        <HostPickerScreen surface={hostPicker} />
      </BrowserRouter>
    </StrictMode>,
  );
} else if (app) {
  const registry = await loadPluginRegistry();
  connectOperationsSse();
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
