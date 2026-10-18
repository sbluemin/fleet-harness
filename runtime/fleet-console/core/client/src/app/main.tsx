import { subscribeConsoleChannel } from "../integration/operations-sse.js";
import * as reactNs from "react";
import * as reactJsxRuntime from "react/jsx-runtime";
import * as sdkPluginBrowser from "@fleet-console/sdk/plugin/browser";
import * as sdkSettingsBrowser from "@fleet-console/sdk/settings/browser";
import * as sdkOperationsBrowser from "@fleet-console/sdk/operations/browser";
import * as sdkNotificationsBrowser from "@fleet-console/sdk/notifications/browser";
import * as sdkReactBrowser from "@fleet-console/sdk/react/browser";
import * as sdkComponentsFailureNotice from "@fleet-console/sdk/components/failure-notice";
import * as sdkComponentsEffortTrack from "@fleet-console/sdk/components/effort-track";
import * as sdkComponentsModelCoordinatePicker from "@fleet-console/sdk/components/model-coordinate-picker";
import * as sdkComponentsLaunchProviderGlyphs from "@fleet-console/sdk/components/launch-provider-glyphs";
import * as sdkComponentsShellGlyph from "@fleet-console/sdk/components/shell-glyph";
import "@fontsource-variable/manrope";
// Pretendard dynamic subset: 한글 폴백 서체 — 브라우저가 unicode-range로 필요한 subset woff2만 내려받는다.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
// Nanum Gothic Coding: --font-code의 한글 폴백. JetBrains Mono·ui-monospace·SF Mono·Menlo 어느 것도 한글
// 글리프가 없어 이 서체가 없으면 코드 표면의 한글만 OS 비례폭 고딕으로 새어 나간다.
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

import "../styles/theme.css";
import "../styles/mobile-press.css";
import "../styles/layout.css";
import "../styles/components.css";
import "../../../../features/settings/client/settings-pane.css";
import { App } from "./app.js";
import { readHostPickerSurface } from "../chrome/components/command-band-system-cluster.js";
import { HostPickerScreen } from "../../../../features/remote-access/client/host-picker-surface.js";
import { ConsoleSection } from "../../../../features/remote-access/client/console-section.js";
import { CONSOLE_SECTION_SURFACE } from "@fleet-console/protocol/desktop/console-section";
import "../../../../features/remote-access/client/console-section.css";
import { fetchGlobalSettingsState } from "../../../../features/settings/client/global-settings-api.js";
import { failGlobalSettingsLoad, hydrateGlobalSettings } from "../../../../features/settings/client/global-settings-store.js";
import { connectOperationsSse, installOperationsSseWake, refreshObserverStatus } from "../integration/operations-sse.js";
import { installOperationArchive } from "../integration/operation-archive.js";
import { installModelRosterSync } from "../../../../features/ai-gateway/client/model-roster-store.js";
import { installModalOpenMarker } from "../integration/modal-open-marker.js";
import { afterBootLane, armBootLane, bootLanePending, installBootFetchGate, openBootLane, startBootSnapshots } from "../integration/boot-schedule.js";
import { announceDesktopReady } from "../integration/desktop-ready.js";
import { installConsoleUseGestures } from "../../../../features/console-use/client/gestures.js";
import { loadPluginRegistry, PluginRegistryProvider } from "../integration/plugin-registry.js";
import { bindGroupClusterSource, GroupClusterProvider } from "../../../../features/execution/client/agent/chat/group-timeline-store.js";
import { applyDesktopShellMarker, migrateStoredCommissioningSeen, operationsIncludingNested, readServerInjectedTheme, readStoredThemeHint, setActiveTheme } from "../integration/store.js";
import { installMobileAppearance } from "../integration/mobile-appearance-store.js";

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
  readonly "@fleet-console/sdk/components/model-coordinate-picker": typeof sdkComponentsModelCoordinatePicker;
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
  "@fleet-console/sdk/components/model-coordinate-picker": sdkComponentsModelCoordinatePicker,
  "@fleet-console/sdk/components/launch-provider-glyphs": sdkComponentsLaunchProviderGlyphs,
  "@fleet-console/sdk/components/shell-glyph": sdkComponentsShellGlyph,
};

// 서버 주입이 첫 페인트의 권위값이며 theme-hint는 미주입 서빙 경로의 폴백이다.
setActiveTheme(readServerInjectedTheme() ?? readStoredThemeHint() ?? "dark");
applyDesktopShellMarker();
// 모바일 색상 모드·글자 배율은 기기 단위 선호다(앱이면 네이티브 소유, 브라우저면 로컬 저장) —
// 부트 스크립트가 첫 페인트에 붙인 속성을 이어받아 시스템 외관·네이티브 확정을 실시간으로 따른다.
installMobileAppearance();
// 모달 표시는 CSS :has()가 아니라 루트 속성으로 흐른다 — 문서 전체 스타일 재계산을 막는다(modal-open-marker.ts).
installModalOpenMarker();

const app = document.querySelector("#app");
/**
 * 집이 목록만 펼쳐 내주는 표면으로 서빙됐다면 콘솔을 세우지 않는다 — 플러그인도 SSE도
 * 이 화면과 무관하고, 그 둘을 켜는 순간 덮개 한 장이 콘솔 한 벌만큼 무거워진다.
 * 판정은 주소만 본다. 설정 조회를 기다리지 않으므로 이 갈래는 레지스트리와 목록을 시작하지 않는다.
 */
const hostPicker = app ? readHostPickerSurface(location.search) : null;
const consoleSection = new URLSearchParams(location.search).get("desktop-surface") === CONSOLE_SECTION_SURFACE;
const auxiliary = hostPicker !== null || consoleSection;
const desktopShell = document.documentElement.getAttribute("data-desktop-shell") === "true";
// 목록이 끝나지 않아도 셸 아닌 기능(SSE·플러그인 설치)은 결국 서야 한다. ready가 그 전에 차선을 연다.
if (app && !auxiliary && desktopShell) {
  installBootFetchGate();
  armBootLane();
  window.setTimeout(openBootLane, 8_000);
}

const registryPromise = app && !auxiliary ? loadPluginRegistry() : null;
if (app && !auxiliary) startBootSnapshots();

let migration = Promise.resolve(false);
try {
  const settings = await fetchGlobalSettingsState();
  setActiveTheme(settings.theme);

  hydrateGlobalSettings(settings);
  // 이관은 설정 수화 뒤여야 하지만 레지스트리와는 무관하다. 그리기 전에만 모으면 된다.
  migration = migrateStoredCommissioningSeen();
} catch (error) {
  failGlobalSettingsLoad(error);
  // 서버 미응답 시 기본 Theme 및 Manrope UI font를 유지한다.
}

if (app && consoleSection) {
  document.documentElement.dataset.consoleSection = "true";
  // 상주 섹션은 App을 띄우지 않는다. 집 Console의 이름은 상태를 한 번 읽어 와야 접힌 줄과 펼친 줄이 같은 이름을 쓴다.
  refreshObserverStatus();
  createRoot(app).render(<StrictMode><BrowserRouter basename="/console"><ConsoleSection resident /></BrowserRouter></StrictMode>);
} else if (app && hostPicker) {
  document.documentElement.dataset.hostPicker = "true";
  createRoot(app).render(
    <StrictMode>
      <BrowserRouter basename="/console">
        <HostPickerScreen surface={hostPicker} />
      </BrowserRouter>
    </StrictMode>,
  );
} else if (app && registryPromise) {
  const registry = await registryPromise;
  await migration;
  // 대화 중심 화면의 본문 렌더러·「구성원」 탭 등록은 훅 밖에서 목표 묶음을 읽는다 — Provider 와 같은 원천을 묶는다.
  bindGroupClusterSource(registry.operationClusters);
  // 제스처는 id 로 대상·호출자를 찾는다 — 구성원이 부른 Console Use 도 제 이름으로 선다.
  installConsoleUseGestures({ operations: () => operationsIncludingNested(), subscribeConsoleChannel });
  // 보관함의 수와 목록 — 보관된 Operation은 일반 목록에 없으므로 자기 사건으로 따라간다.
  // 첫 읽기는 데스크톱 차선이 열려 있을 때 목록·ready보다 뒤로 밀린다.
  installOperationArchive(subscribeConsoleChannel);
  // 모델 로스터 변경(다른 탭·기기의 AI Gateway 저장)이 운영 카탈로그와 모든 모델 선택지를 다시 읽게 한다.
  installModelRosterSync();
  const connectLive = (): void => {
    connectOperationsSse();
    installOperationsSseWake();
  };
  // 이벤트 스트림은 연결 하나를 계속 쥐므로, 첫 목록을 칠하고 ready를 보낸 다음에 연다.
  if (bootLanePending()) void afterBootLane().then(connectLive);
  else connectLive();
  // 호스트를 갈아타는 Desktop이 붙잡아 둔 옛 화면을 걷을 때를 알린다 — 첫 목록이 칠해진 뒤 한 번.
  // 이 시점에는 목록 플래그가 아직 거짓이다. 수화는 마운트 뒤에만 한다.
  announceDesktopReady();
  createRoot(app).render(
    <StrictMode>
      <BrowserRouter basename="/console">
        <PluginRegistryProvider value={registry}>
          <GroupClusterProvider value={registry.operationClusters}><App /></GroupClusterProvider>
        </PluginRegistryProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
