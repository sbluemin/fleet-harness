import type { ClientExecutionProvider } from "@fleet-console/sdk/plugin";

import { agentAttentionNotification, agentOperationKind, agentExecution, agentSettingsSection, generalSettingsSection, harnessSettingsSection } from "./agent/index.js";
import { globalShellEntry } from "./terminal/global-shell/rail-panel.js";
import { PersistentShellHost, shellSurface } from "./terminal/shell/index.js";
import { preloadTerminalFallbackFonts } from "./terminal/shared/terminal-fallback-fonts.js";
import { connectTerminalSettings } from "./terminal/shared/terminal-preferences.js";
import "./terminal/assets/fonts/symbols-nerd-font-mono.css";
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
  railEntries: [globalShellEntry],
  expandedSurfaces: [shellSurface],
  persistentComponents: [{ id: "terminal-shell-host", render: (ctx) => <PersistentShellHost language={ctx.language} theme={ctx.theme} /> }],
  install: (ctx) => {
    void preloadTerminalFallbackFonts();
    connectTerminalSettings(ctx.settings);
    return agentExecution.install?.(ctx);
  },
};
