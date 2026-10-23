import { subscribeConsoleChannel } from "../integration/objective-records-sse.js";
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
import "../../../../features/remote-access/client/console-section.css";
import { fetchGlobalSettingsState } from "../../../../features/settings/client/global-settings-api.js";
import { failGlobalSettingsLoad, hydrateGlobalSettings } from "../../../../features/settings/client/global-settings-store.js";
import { connectObjectiveRecordsSse, installObjectiveRecordsSseWake, refreshObserverStatus } from "../integration/objective-records-sse.js";
import { installObjectiveArchive } from "../integration/objective-archive.js";
import { installModelRosterSync } from "../../../../features/ai-gateway/client/model-roster-store.js";
import { installModalOpenMarker } from "../integration/modal-open-marker.js";
import { afterBootLane, armBootLane, bootLanePending, installBootFetchGate, openBootLane, startBootSnapshots } from "../integration/boot-schedule.js";
import { announceDesktopReady } from "../integration/desktop-ready.js";
import { installConsoleUseGestures } from "../../../../features/console-use/client/gestures.js";
import { loadFeatureRegistry, FeatureRegistryProvider } from "../integration/feature-registry.js";
import { bindGroupClusterSource, GroupClusterProvider } from "../../../../features/execution/client/agent/chat/group-timeline-store.js";
import { ComposerTopEntriesProvider } from "../../../../features/execution/client/agent/chat/composer-top-entries.js";
import { applyDesktopShellMarker, migrateStoredCommissioningSeen, objectiveRecordsIncludingNested, readServerInjectedTheme, readStoredThemeHint, setActiveTheme } from "../integration/store.js";
import { installMobileAppearance } from "../integration/mobile-appearance-store.js";
import { bindConversationSurfaceLayout } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { getRailStoreSnapshot } from "../chrome/rail/rail-store.js";
import { closeTheaterInbox, readTheaterInboxState } from "../../../../features/workspace/client/theater-inbox/store.js";

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
const auxiliary = hostPicker !== null;
const desktopShell = document.documentElement.getAttribute("data-desktop-shell") === "true";
// 목록이 끝나지 않아도 셸 아닌 기능(SSE·플러그인 설치)은 결국 서야 한다. ready가 그 전에 차선을 연다.
if (app && !auxiliary && desktopShell) {
  installBootFetchGate();
  armBootLane();
  window.setTimeout(openBootLane, 8_000);
}

const registryPromise = app && !auxiliary ? loadFeatureRegistry() : null;
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

if (app && hostPicker) {
  document.documentElement.dataset.hostPicker = "true";
  // 옛 원격이 부르는 집 목록에도 설정한 Console 이름을 수화한다.
  refreshObserverStatus();
  createRoot(app).render(
    <StrictMode>
      <BrowserRouter basename="/console">
        <HostPickerScreen surface={hostPicker} />
      </BrowserRouter>
    </StrictMode>,
  );
} else if (app && registryPromise) {
  const registry = await registryPromise;
  bindConversationSurfaceLayout({
    onLeaveDesktop: (surface) => {
      const descriptor = registry.conversationSurfaces.find((candidate) => candidate.id === surface.surfaceId);
      if (!descriptor?.onLeaveDesktop) return;
      const tabId = getRailStoreSnapshot().activePanelId;
      // 같은 Theater 의 Inbox 문맥도 남아 있다 — 표면이 착지를 맡으면 Inbox 가 뒤늦게 기본 칸으로 덮지 않게 함께 걷는다.
      if (readTheaterInboxState()?.theaterId === surface.params.theaterId) closeTheaterInbox();
      descriptor.onLeaveDesktop({ params: surface.params, tabId });
    },
  });
  await migration;
  // 대화 중심 화면의 본문 렌더러·「구성원」 탭 등록은 훅 밖에서 목표 묶음을 읽는다 — Provider 와 같은 원천을 묶는다.
  bindGroupClusterSource(registry.objectiveRecordClusters);
  // 제스처는 id 로 대상·호출자를 찾는다 — 구성원이 부른 Console Use 도 제 이름으로 선다.
  installConsoleUseGestures({ objectiveRecords: () => objectiveRecordsIncludingNested(), subscribeConsoleChannel });
  // 보관함의 수와 목록 — 보관된 Objective은 일반 목록에 없으므로 자기 사건으로 따라간다.
  // 첫 읽기는 데스크톱 차선이 열려 있을 때 목록·ready보다 뒤로 밀린다.
  installObjectiveArchive(subscribeConsoleChannel);
  // 모델 로스터 변경(다른 탭·기기의 AI Gateway 저장)이 운영 카탈로그와 모든 모델 선택지를 다시 읽게 한다.
  installModelRosterSync();
  const connectLive = (): void => {
    connectObjectiveRecordsSse();
    installObjectiveRecordsSseWake();
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
        <FeatureRegistryProvider value={registry}>
          <ComposerTopEntriesProvider value={registry.composerTopEntries}>
            <GroupClusterProvider value={registry.objectiveRecordClusters}><App /></GroupClusterProvider>
          </ComposerTopEntriesProvider>
        </FeatureRegistryProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
