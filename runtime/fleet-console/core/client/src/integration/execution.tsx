import { DEFAULT_FONTS } from "@fleet-console/sdk/settings/fonts";
import { getGlobalSettingsStoreState, subscribe } from "../../../../features/settings/client/global-settings-store.js";
import type { ClientExecutionProvider } from "@fleet-console/sdk/plugin";

import { agentAttentionNotification, agentOperationKind, agentExecution, agentSettingsSection, generalSettingsSection, harnessSettingsSection } from "../../../../features/execution/client/agent/index.js";
import { globalShellEntry } from "../../../../features/execution/client/terminal/global-shell/rail-panel.js";
import { globalBrowserEntry } from "../../../../features/browser/client/global-browser-entry.js";
import { installGlobalLinkRouter } from "../../../../features/browser/client/global-link-router.js";
import { GlobalBrowserSheet } from "../../../../features/browser/client/global-browser-sheet.js";
import { GlobalLinkCardHost } from "../../../../features/browser/client/global-link-card.js";
import { PersistentShellHost, shellSurface } from "../../../../features/execution/client/terminal/shell/index.js";
import { connectShellSession } from "../../../../features/execution/client/terminal/shell/shell-session-store.js";
import { preloadTerminalFallbackFonts } from "../../../../features/execution/client/terminal/shared/terminal-fallback-fonts.js";
import { connectTerminalFontSettings, connectTerminalSettings } from "../../../../features/execution/client/terminal/shared/terminal-preferences.js";
import "../../../../features/execution/client/terminal/assets/fonts/symbols-nerd-font-mono.css";
/* 한글 등폭 폴백의 실체. unicode-range로 쪼갠 청크판(400.css/700.css)이 아니라 한글 서브셋
   통짜판을 쓴다 — WebGL glyph atlas는 글리프를 처음 그릴 때 래스터화해 캐시하는데, 그 atlas는
   같은 설정의 터미널들이 모듈 레벨에서 공유하므로 한 터미널이 비울 수 없다(terminal-surface의
   clearTextureAtlas 주석). 즉 폰트가 늦게 도착하면 첫 한글이 폴백 글리프로 구워져 그대로 남는다.
   통짜 @font-face라야 open 직전에 한 번 선대기해 그 경합을 없앨 수 있다. */
import "@fontsource/nanum-gothic-coding/korean-400.css";
import "@fontsource/nanum-gothic-coding/korean-700.css";

/** Console의 필수 기능. 플러그인 로딩이나 install 성공 여부에 종속되지 않는다. */
export const consoleExecution: ClientExecutionProvider = {
  ...agentExecution,
  id: null,
  // 전역 Fleet 브라우저는 fleet 범위 맨 앞에 선다 — consoleExecution이 첫 provider라
  // 플러그인 fleet 도구보다 앞선다. 시트는 레일 패널·확대 표면이 아니라 Console 전역
  // 영속 컴포넌트로 산다(Cruise·Zen·War Room 공통. 모바일에서는 시트 스스로 그리지 않는다).
  railEntries: [globalShellEntry, globalBrowserEntry],
  expandedSurfaces: [shellSurface],
  persistentComponents: [
    { id: "terminal-shell-host", render: (ctx) => <PersistentShellHost language={ctx.language} theme={ctx.theme} /> },
    { id: "global-browser-sheet", render: (ctx) => <GlobalBrowserSheet language={ctx.language} theme={ctx.theme} /> },
    // Operation 밖 링크의 「어디서 열까」 카드 — 전역 Shell과 같은 2행이다.
    { id: "global-link-card", render: (ctx) => <GlobalLinkCardHost language={ctx.language} /> },
  ],
  install: (ctx) => {
    void preloadTerminalFallbackFonts();
    connectTerminalSettings(ctx.settings);
    connectTerminalFontSettings({
      read: () => getGlobalSettingsStoreState().state?.fonts ?? DEFAULT_FONTS,
      subscribe,
    });
    // 문서 수준 링크 라우터 — Console 수명 동안 한 번 선다.
    installGlobalLinkRouter();
    const disconnectShellSession = connectShellSession(ctx.consoleEvents);
    const disposeAgent = agentExecution.install?.(ctx);
    return () => {
      disconnectShellSession();
      if (typeof disposeAgent === "function") disposeAgent();
    };
  },
};
