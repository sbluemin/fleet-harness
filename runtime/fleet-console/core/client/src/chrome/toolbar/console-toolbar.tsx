import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { useT } from "../../i18n/index.js";
import { useTriageActive } from "../../../../../features/workspace/client/canvas/triage-store.js";
import { GearGlyph, SETTINGS_RAIL_ENTRY_ID } from "../../../../../features/settings/client/settings-entry.js";
import { usePluginRegistry } from "../../integration/plugin-registry.js";
import { toggleOperationSearch } from "../../integration/store.js";
import { setToolbarToolsSlot, useToolbarHost } from "../../integration/toolbar-slots.js";
import { ConsoleHelpMenu, HostSwitcher } from "../components/command-band-system-cluster.js";
import { openRailPanel, toggleRailPanel, useRailActivePanelId } from "../rail/rail-store.js";
import "../../styles/rail.css";
import { ToolbarTipLayer } from "./toolbar-tip.js";

/**
 * 도구모음 — 콘솔에 하나뿐인 도구 줄. 모드는 이 줄의 **자리**만 바꾼다: 평소에는 상단 바 가운데,
 * War Room에서는 부유 섬. 내용과 순서는 같다.
 *
 *   › 접기 | 플러그인(레일 도구) | 시스템 도구(찾기 · 원격 · 도움말 · 설정) | Bridge(Quota 요약 → 부관)
 *
 * 줄은 자기 DOM 노드를 하나 만들어 들고, 자리가 바뀌면 그 노드를 새 자리로 옮긴다. React는 같은
 * 노드에 계속 포털하므로 안의 항목이 다시 마운트되지 않는다 — 플러그인은 자리가 사라졌다고 보지
 * 않고(부관이 캔버스로 돌아가지 않는다), 열린 메뉴·도구 칸의 포털도 끊기지 않는다.
 *
 * 접으면 플러그인·시스템 칸만 말려 들어가고 Bridge는 남는다. War Room 켜고 끄기는 도구모음이 아니라 좌측
 * 사이드바(모드 스위치)의 일이다 — 도구모음은 모드와 무관하게 같은 내용으로 선다.
 *
 * 칸의 이름은 한 장의 말풍선이 말한다(toolbar-tip.tsx) — 칸은 네이티브 title 대신 data-tip을 든다.
 */

const FOLD_STORAGE_KEY = "fleet-console.toolbar.folded";
/** 서랍 전이(layout.css .console-toolbar-drawer의 360ms)보다 조금 길게 — 전이가 끝난 뒤에 자름을 푼다. */
const FOLD_TRANSITION_MS = 420;

function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLD_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(FOLD_STORAGE_KEY, String(folded));
  } catch {
    // 기억하지 못해도 이번 화면의 접힘은 그대로 선다.
  }
}

interface ConsoleToolbarProps {
  /** War Room이 이 창에서 실제로 켜져 있는가 — 켜져 있으면 줄이 War Room 트레이에 선다. */
  readonly warRoomActive: boolean;
  /** 캔버스 화면인가(/operations 데스크톱). 아니면 설정 톱니가 캔버스로 먼저 돌아간 뒤 설정을 연다. */
  readonly canvas: boolean;
}

export function ConsoleToolbar({ warRoomActive, canvas }: ConsoleToolbarProps) {
  const t = useT();
  const bandHost = useToolbarHost("band");
  const warRoomHost = useToolbarHost("warRoom");
  const host = warRoomActive ? warRoomHost : bandHost;
  // 줄의 몸 — 한 번 만들어 끝까지 쓴다. 자리만 바꿔 끼운다.
  const [mount] = useState(() => {
    const element = document.createElement("div");
    element.className = "console-toolbar-mount";
    return element;
  });
  useLayoutEffect(() => {
    if (host === null) {
      mount.remove();
      return;
    }
    if (mount.parentNode === host) return;
    // 노드를 옮기면 브라우저가 그 안의 포커스를 놓는다 — 키보드로 War Room을 켜고 끈 사람은 같은 버튼에 남아야 한다.
    const focused = document.activeElement;
    const keepFocus = focused instanceof HTMLElement && mount.contains(focused) ? focused : null;
    host.appendChild(mount);
    keepFocus?.focus({ preventScroll: true });
  }, [host, mount]);
  useLayoutEffect(() => () => mount.remove(), [mount]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const [preferredFolded, setFolded] = useState(readFolded);
  const warRoom = useTriageActive();
  const [warRoomFolded, setWarRoomFolded] = useState(true);
  useLayoutEffect(() => { if (warRoom) setWarRoomFolded(true); }, [warRoom]);
  const folded = warRoom ? warRoomFolded : preferredFolded;
  // 서랍이 말리거나 펴지는 동안만 가로를 자른다 — 늘 자르면 서랍보다 넓은 메뉴(원격·도움말)가 잘린다.
  const [folding, setFolding] = useState(false);
  const foldingTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (foldingTimerRef.current !== null) window.clearTimeout(foldingTimerRef.current); }, []);
  const toggleFold = () => {
    const next = !folded;
    if (warRoom) setWarRoomFolded(next);
    else { setFolded(next); writeFolded(next); }
    setFolding(true);
    if (foldingTimerRef.current !== null) window.clearTimeout(foldingTimerRef.current);
    foldingTimerRef.current = window.setTimeout(() => {
      foldingTimerRef.current = null;
      setFolding(false);
    }, FOLD_TRANSITION_MS);
  };

  return createPortal(
    <div ref={toolbarRef} className={`console-toolbar${folded ? " is-folded" : ""}${folding ? " is-folding" : ""}`} role="toolbar" aria-label={t("toolbar.aria")}>
      <ToolbarTipLayer rootRef={toolbarRef} />
      <button
        type="button"
        className="console-toolbar-fold"
        aria-label={t(folded ? "toolbar.expand" : "toolbar.fold")}
        data-tip={t(folded ? "toolbar.expand" : "toolbar.fold")}
        aria-expanded={!folded}
        onClick={toggleFold}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {/* 서랍 — 접으면 폭이 0으로 말려 들어가며 흐려진다. 도구 칸은 DOM에 남는다(포털 계약). */}
      <div className="console-toolbar-drawer" inert={folded || undefined}>
        <div className="console-toolbar-drawer-inner">
          <span className="console-toolbar-tools" ref={setToolbarToolsSlot} />
          <span className="console-toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="command-band-button console-toolbar-search"
            onClick={toggleOperationSearch}
            aria-label={t("chrome.commandBand.searchSessions")}
            data-tip={t("chrome.commandBand.searchSessionsTitle")}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.4 10.4 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </button>
          <HostSwitcher />
          <ConsoleHelpMenu />
          <ToolbarSettingsButton canvas={canvas} />
        </div>
      </div>
      <ToolbarBridge />
    </div>,
    mount,
  );
}

/**
 * 설정 — 시스템 칸의 맨 끝. 톱니는 메뉴가 아니라 설정 표면(레일 패널)의 문이고, 켜짐은 레일 도구와 같은
 * 활성 표식으로 "지금 여기"를 말한다. 문서 id(rail-settings-toggle)는 설정 패널의 이름표(aria-labelledby)와
 * 온보딩 앵커가 가리키므로 그대로 둔다. 레일은 /operations에만 서므로, 다른 화면에서는 캔버스로 돌아간 뒤 연다.
 */
function ToolbarSettingsButton({ canvas }: { readonly canvas: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const activePanelId = useRailActivePanelId();
  const active = canvas && activePanelId === SETTINGS_RAIL_ENTRY_ID;
  return (
    <button
      id="rail-settings-toggle"
      type="button"
      className={`right-rail-ico right-rail-settings-btn${active ? " is-active" : ""}`}
      aria-pressed={active}
      aria-controls={active ? `rail-panel-${SETTINGS_RAIL_ENTRY_ID}` : undefined}
      aria-label={t("settings.title")}
      data-tip={t("settings.title")}
      onClick={() => {
        if (canvas) { toggleRailPanel(SETTINGS_RAIL_ENTRY_ID); return; }
        navigate("/operations");
        openRailPanel(SETTINGS_RAIL_ENTRY_ID);
      }}
    >
      <GearGlyph />
    </button>
  );
}

/**
 * Bridge — 플러그인이 크롬에 둔 항목(사용 한도 요약 → 부관 글리프). 도구모음 안에 서므로 모드가 바뀌어도
 * 자리째 따라간다. 순서는 레지스트리가 정한다(부관이 늘 끝 — plugin-registry.ts). 접기 서랍 밖에 둔다 —
 * 부관의 답 말풍선이 글리프를 닻으로 삼고, 사용 한도 요약은 접어도 보이려고 켜는 것이다.
 */
function ToolbarBridge() {
  const t = useT();
  const { commandBandEntries } = usePluginRegistry();
  if (commandBandEntries.length === 0) return null;
  return (
    <span className="console-toolbar-bridge" role="group" aria-label={t("toolbar.bridge")}>
      {commandBandEntries.map((entry) => (
        // 플러그인의 render()는 경계 아래 자식 컴포넌트에서 부른다 — 한 항목의 throw가 도구모음 전체를
        // 내리지 않게(영속 컴포넌트·설정 섹션과 같은 격리).
        <PluginErrorBoundary key={entry.id} fallback={null}>
          <ToolbarPluginEntry render={entry.render} />
        </PluginErrorBoundary>
      ))}
    </span>
  );
}

function ToolbarPluginEntry({ render }: { readonly render: () => ReactNode }) {
  return <>{render()}</>;
}
