import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { useConsoleLocale } from "./i18n/index.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { getState, subscribe } from "./store.js";

/**
 * 플러그인의 화면 없는 상주 기여를 마운트해 두는 자리.
 *
 * rail 패널과 확대 표면은 열려 있는 동안만 산다. 주소 동기화처럼 "열려 있지 않아도
 * 돌아야 하는" 로직을 그 안에 얹으면 패널을 닫는 순간 조용히 멈춘다 — Codex의 리더
 * 주소가 실제로 그렇게 죽어 있었다.
 *
 * `useLocation`을 여기서 읽는 것이 이 층의 핵심이다. 주소가 바뀔 때 이 층이 다시 그려져야
 * 상주 훅의 `location.search` 의존이 깨어난다. 그것이 없으면 브라우저 뒤로/앞으로가
 * 아무 일도 하지 않는다.
 */
export function PersistentPluginComponents() {
  const { persistentComponents } = usePluginRegistry();
  // 값은 쓰지 않는다 — 주소 변화로 이 층을 다시 그리게 하는 것이 목적이다.
  useLocation();
  const language = useConsoleLocale();
  const theme = useSyncExternalStore(subscribe, () => getState().activeTheme, () => "instrument" as const);
  const context = useMemo<PersistentComponentContext>(() => ({ language, theme }), [language, theme]);

  if (persistentComponents.length === 0) return null;

  return (
    <>
      {persistentComponents.map((descriptor) => (
        <PluginErrorBoundary key={descriptor.id}>
          <PersistentComponent render={descriptor.render} context={context} />
        </PluginErrorBoundary>
      ))}
    </>
  );
}

function PersistentComponent({
  render,
  context,
}: {
  readonly render: (ctx: PersistentComponentContext) => ReactNode;
  readonly context: PersistentComponentContext;
}) {
  return <>{render(context)}</>;
}
