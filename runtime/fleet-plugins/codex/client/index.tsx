import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { bindCodexHost, setConsoleLocale, setConsoleTheme } from "./host.js";
import { codexPanel } from "./codex-panel.js";
import { codexReadingSurface } from "./reading-surface.js";
import "./codex/styles/theme.css";
import "./codex/styles/layout.css";
import "./codex/styles/components.css";

const codexPlugin = definePlugin({
  id: "codex",
  railPanels: [codexPanel],
  expandedSurfaces: [codexReadingSurface],
  install: (ctx) => {
    // 명령형 DOM 컨트롤러들이 렌더 밖에서 호스트 사실을 읽는다 — 코어 스토어를 직접
    // import하던 자리를, 호스트가 건네준 능력 하나로 대체한다.
    bindCodexHost({
      consoleState: ctx.consoleState,
      navigation: ctx.navigation,
      surfaces: ctx.surfaces,
    });
    return undefined;
  },
});

export { setConsoleLocale, setConsoleTheme };
export const plugins = [codexPlugin] as const;
