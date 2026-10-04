import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ConsoleTheme } from "@fleet-console/sdk/plugin";
import { useT } from "../../i18n/index.js";
import { getState, subscribe } from "../../integration/store.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { useExpandedSurfaceDescriptors } from "../../integration/plugin-registry.js";
import { SurfacePane } from "../expanded-surface/layer.js";
import { closeExpandedSurface, useExpandedSurfaces } from "../expanded-surface/store.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { RailSurface } from "../pane/rail-surface.js";
import { closePane, useFocusedPaneId, useRailPanes } from "../pane/pane-store.js";
import { closeRailPanel, useRailActivePanelId } from "../rail/rail-store.js";
import { mobilePluginRows } from "./mobile-destinations.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { setMobileTool, useMobileTool } from "./mobile-store.js";
import "../../styles/rail.css";

const ignoreMinimum = () => undefined;
const ignoreDivider = () => undefined;

/**
 * 「플러그인」 화면 — 드로어의 고정 목적지가 되지 못한 도구(저장소·스킬·원장 …)가 한 줄씩 선다.
 * 행을 누르면 도구 시트(레일 페인 한 장씩 / 확대 표면)로 열린다. 본문은 플러그인의 SDK 계약 그대로,
 * 모바일 호스트는 진입·한 장씩 보기·뒤로만 소유한다.
 */
export function MobileTools({ theme, language }: { readonly theme: ConsoleTheme; readonly language: "ko" | "en" }) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const theaterId = useSyncExternalStore(subscribe, () => getState().activeTheaterId);
  const tool = useMobileTool();
  const bindings = useRailEntries();
  const activeRail = useRailActivePanelId();
  const panes = useRailPanes();
  const focusedPaneId = useFocusedPaneId();
  const descriptors = useExpandedSurfaceDescriptors();
  const { instances } = useExpandedSurfaces();
  const binding = tool?.kind === "rail" ? bindings.find((item) => item.entry.id === tool.id) : undefined;
  const instance = tool?.kind === "surface" ? instances.find((item) => item.instanceId === tool.instanceId) : undefined;
  const descriptor = instance ? descriptors.get(instance.surfaceId) : undefined;
  const details = binding ? panes.filter((pane) => pane.visible && binding.panes.some((item) => item.id === pane.paneId && item.role !== "primary")) : [];
  const detail = details.find((pane) => pane.paneId === focusedPaneId) ?? details.at(-1);
  const backRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // 시트가 서 있는 동안 상단 막대는 시트 자신의 머리가 대신한다. 목록일 때는 「플러그인」 제목이 선다.
  useClaimMobileBar(tool === null
    ? { variant: "centered", title: t("mobile.drawer.plugins"), leading: "menu" }
    : { variant: "centered", title: "", leading: "menu", hidden: true });

  useLayoutEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [instance?.instanceId]);

  useEffect(() => {
    if ((tool?.kind === "rail" && activeRail !== tool.id) || (tool?.kind === "surface" && !instance)) setMobileTool(null);
  }, [activeRail, instance, tool]);
  useLayoutEffect(() => { if (tool) backRef.current?.focus({ preventScroll: true }); }, [tool, detail?.instanceId]);

  const close = () => {
    if (tool?.kind === "rail") closeRailPanel(tool.id);
    if (instance) closeExpandedSurface(instance.instanceId);
    setMobileTool(null);
  };
  const back = () => {
    if (!detail) { close(); return; }
    const pane = binding?.panes.find((item) => item.id === detail.paneId);
    closePane(detail.paneId, { keepAlive: pane?.keepAlive === true, ...(pane?.onClose ? { onClose: pane.onClose } : {}) });
  };

  if (tool === null) {
    const rows = mobilePluginRows(bindings);
    return (
      <section className="mobile-plugin-list">
        {rows.length === 0 ? <p className="mobile-plugin-list-empty">{t("mobile.plugins.empty")}</p> : (
          <div className="mobile-group">
            {rows.map((row) => {
              const desktopOnly = row.entry.mobile?.available === false;
              return (
                <button
                  type="button"
                  className={`mobile-group-row${desktopOnly ? " is-dim" : ""}`}
                  key={row.entry.id}
                  aria-disabled={desktopOnly || undefined}
                  disabled={desktopOnly || (theaterId === null && row.entry.scope !== "fleet")}
                  onClick={() => {
                    if (row.entry.surfaceId) capabilities.surfaces.open({ surfaceId: row.entry.surfaceId });
                    else capabilities.rail.open(row.entry.id);
                  }}
                >
                  <span className="mobile-group-row-icon" aria-hidden="true">{typeof row.entry.icon === "function" ? row.entry.icon() : row.entry.icon}</span>
                  <span className="mobile-group-row-copy">{resolveLocalizedText(row.entry.title, language)}{desktopOnly ? <small>{t("mobile.plugins.desktopOnly")}</small> : null}</span>
                  {desktopOnly ? null : <MobileIcon name="right" size={18} className="mobile-group-row-caret" />}
                </button>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  const title = binding ? resolveLocalizedText(binding.entry.title, language)
    : instance?.surfaceId === "shell" ? t("mobile.tools.shell") : instance?.surfaceId === "codex" ? t("mobile.tools.wiki") : t("mobile.drawer.plugins");
  // 플러그인 CSS에 공개하는 배치 신호 — 내부 호스트 클래스 대신 시트 문맥만 판별한다.
  return <section className="mobile-tool-sheet" data-host-surface="mobile-sheet" aria-label={title}>
    <header className="mobile-tool-sheet-bar">
      <button type="button" ref={backRef} onClick={back} aria-label={t("mobile.tools.back")}>‹ <span>{t("mobile.tools.back")}</span></button>
      <h1>{title}</h1>
      <button type="button" onClick={close} aria-label={t("mobile.tools.close")}>×</button>
    </header>
    <div className="mobile-tool-sheet-body" ref={surfaceRef}>
      <PluginErrorBoundary>
        {binding ? <RailSurface key={binding.entry.id} binding={binding} singlePane theaterId={theaterId} api={capabilities.api} surfaces={capabilities.surfaces} theme={theme} language={language} /> : null}
        {instance && descriptor ? <SurfacePane key={instance.instanceId} instance={instance} descriptor={descriptor} index={0} paneCount={1} paneWidth={width} focused theaterId={theaterId} theme={theme} language={language} capabilities={capabilities} isLast onReportMinimum={ignoreMinimum} onDividerPointerDown={ignoreDivider} onDividerNudge={ignoreDivider} /> : null}
      </PluginErrorBoundary>
    </div>
  </section>;
}
