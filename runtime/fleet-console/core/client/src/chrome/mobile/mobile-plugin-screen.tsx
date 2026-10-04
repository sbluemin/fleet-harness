import { useEffect, useSyncExternalStore } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ConsoleTheme } from "@fleet-console/sdk/plugin";

import { getState, subscribe } from "../../integration/store.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { RailSurface } from "../pane/rail-surface.js";
import { closeRailPanel, useRailActivePanelId } from "../rail/rail-store.js";
import { MobileBarContext, useMobilePluginBar } from "./mobile-bar-context.js";
import "../../styles/rail.css";

/**
 * 플러그인이 드로어의 고정 목적지로 올린 화면. 본문은 엔트리의 primary 페인 그대로 — 호스트는 한 장씩 보여 주고
 * (상세 페인이 서면 그 장만), 상단 막대는 호스트가 그린다. 페인은 `ctx.mobileBar`로 제목·깊이·⋮ 항목만 선언한다.
 * 컨테이너의 `data-host-surface="mobile-screen"`은 플러그인 CSS가 「시트」와 「전체 화면」을 가르는 공개 신호다.
 */
export function MobilePluginScreen({ entryId, theme, language }: { readonly entryId: string; readonly theme: ConsoleTheme; readonly language: "ko" | "en" }) {
  const capabilities = useHostCapabilities();
  const bindings = useRailEntries();
  const binding = bindings.find((item) => item.entry.id === entryId);
  const theaterId = useSyncExternalStore(subscribe, () => getState().activeTheaterId);
  const activeRail = useRailActivePanelId();
  const title = binding ? resolveLocalizedText(binding.entry.title, language) : "";
  const bar = useMobilePluginBar({ title });

  // 페인이 서려면 레일 스토어가 이 엔트리를 열어 둔 상태여야 한다. 화면을 떠나면 닫는다.
  useEffect(() => {
    if (!binding || (binding.panes.length === 0)) return;
    capabilities.rail.open(entryId);
    return () => { closeRailPanel(entryId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, binding === undefined]);

  if (!binding || binding.panes.length === 0) return null;
  return (
    <section className="mobile-plugin-screen" data-host-surface="mobile-screen" aria-label={title}>
      <PluginErrorBoundary>
        <MobileBarContext.Provider value={bar}>
          {activeRail === entryId ? (
            <RailSurface key={entryId} binding={binding} singlePane theaterId={theaterId} api={capabilities.api} surfaces={capabilities.surfaces} theme={theme} language={language} />
          ) : null}
        </MobileBarContext.Provider>
      </PluginErrorBoundary>
    </section>
  );
}
