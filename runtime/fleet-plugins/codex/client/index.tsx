import { useEffect } from "react";

import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { bindCodexHost, setConsoleLocale, setConsoleTheme } from "./host.js";
import { refreshCodexLocale } from "./codex-host.js";
import { codexEntry, codexPane } from "./codex-panel.js";
import { codexReaderPane } from "./codex-reader-pane.js";
import { codexReadingSurface } from "./reading-surface.js";
import { codexLaunchContextProvider } from "./launch-context.js";
import { useCodexReaderUrlSync } from "./use-codex-reader-url.js";
import { applyCodexChanged, applyCodexWatchState } from "./codex/live.js";
import { CODEX_CHANGED_EVENT, CODEX_WATCH_EVENT, type CodexKnowledgeScope, type CodexWatchState } from "../server/codex/contracts.js";
import "./codex/styles/theme.css";
import "./codex/styles/layout.css";
import "./codex/styles/components.css";

const codexPlugin = definePlugin({
  id: "codex",
  railEntries: [codexEntry],
  panes: [codexPane, codexReaderPane],
  expandedSurfaces: [codexReadingSurface],
  // 실험 "런치 컨텍스트 팩" — 코어는 설정이 켜진 경우에만 부른다.
  launchContextProviders: [codexLaunchContextProvider],
  // 리더 주소는 패널이 닫혀 있어도 살아 있어야 한다 — 새로고침·공유 링크·뒤로가기가
  // 패널을 여는 쪽이지, 패널이 열려 있어야 도는 것이 아니다.
  persistentComponents: [{ id: "codex-console-facts", render: (ctx) => <CodexConsoleFacts ctx={ctx} /> }],
  install: (ctx) => {
    // 명령형 DOM 컨트롤러들이 렌더 밖에서 호스트 사실을 읽는다 — 코어 스토어를 직접
    // import하던 자리를, 호스트가 건네준 능력 하나로 대체한다.
    bindCodexHost({
      consoleState: ctx.consoleState,
      navigation: ctx.navigation,
      surfaces: ctx.surfaces,
      rail: ctx.rail,
    });
    // 서버는 감시 결과를 콘솔 공용 스트림으로 계속 밀어 보낸다 — 받는 쪽이 없으면 그
    // 프레임은 버려지고, 화면은 파일이 바뀌어도 낡은 채로 남는다. 감시가 끊겼다는 통보
    // 역시 여기로 오므로, 이 구독이 없으면 폴링 폴백도 영영 켜지지 않는다.
    const stopChanged = ctx.consoleEvents.subscribe(CODEX_CHANGED_EVENT, (payload) => {
      const frame = readChangedFrame(payload);
      if (frame) applyCodexChanged(frame.workspaceId, frame.scopes);
    });
    const stopWatch = ctx.consoleEvents.subscribe(CODEX_WATCH_EVENT, (payload) => {
      const frame = readWatchFrame(payload);
      if (frame) applyCodexWatchState(frame.workspaceId, frame.state);
    });
    return () => { stopChanged(); stopWatch(); };
  },
});

// 프레임은 네트워크에서 온다 — 모양을 믿지 않고 확인한 것만 통과시킨다.
function readChangedFrame(payload: unknown): { workspaceId: string; scopes: readonly CodexKnowledgeScope[] } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { workspaceId, scopes } = payload as { workspaceId?: unknown; scopes?: unknown };
  if (typeof workspaceId !== "string" || !Array.isArray(scopes)) return null;
  const known = scopes.filter((scope): scope is CodexKnowledgeScope => typeof scope === "string");
  return known.length > 0 ? { workspaceId, scopes: known } : null;
}

function readWatchFrame(payload: unknown): { workspaceId: string; state: CodexWatchState } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { workspaceId, state } = payload as { workspaceId?: unknown; state?: unknown };
  if (typeof workspaceId !== "string") return null;
  return state === "watching" || state === "degraded" ? { workspaceId, state } : null;
}

/**
 * 콘솔 수명 동안 서 있는 조각. 두 가지를 진다.
 *
 * 하나는 리더 주소 — 패널이 닫혀 있어도 새로고침·공유 링크·뒤로가기가 살아 있어야 한다.
 * 다른 하나는 로케일과 테마 — 명령형 컨트롤러들이 렌더 밖에서 읽는 모듈 값이라, 화면을 통해
 * 전해지면 아무 화면도 열려 있지 않을 때 기본값(en)에 갇힌다. 실제로 그래서 한국어 콘솔에서
 * Codex만 영어로 남아 있었다.
 */
function CodexConsoleFacts({ ctx }: { readonly ctx: PersistentComponentContext }): null {
  useCodexReaderUrlSync();
  const language = ctx.language;
  const theme = ctx.theme;
  useEffect(() => {
    setConsoleLocale(language);
    // 이미 그려진 navigator·reader 문구는 스스로 다시 읽지 않는다 — 다시 그리라고 말한다.
    refreshCodexLocale();
  }, [language]);
  useEffect(() => { setConsoleTheme(theme); }, [theme]);
  return null;
}

export { setConsoleLocale, setConsoleTheme };
export const plugins = [codexPlugin] as const;
