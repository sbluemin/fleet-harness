import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { useT } from "../../i18n/index.js";
import { usePluginRegistry } from "../../integration/plugin-registry.js";
import { toggleOperationSearch } from "../../integration/store.js";
import { setToolbarToolsSlot, useToolbarHost } from "../../integration/toolbar-slots.js";
import { requestZenMode } from "../../integration/zen-mode.js";
import { ConsoleHelpMenu, HostSwitcher } from "../components/command-band-system-cluster.js";
import { ToolbarTipLayer } from "./toolbar-tip.js";

/**
 * 도구모음 — 콘솔에 하나뿐인 도구 줄. 모드는 이 줄의 **자리**만 바꾼다: 평소에는 상단 바 가운데,
 * Zen에서는 작업 표시줄 오른쪽 끝 트레이. 내용과 순서는 같다.
 *
 *   › 접기 | 레일 도구 · 설정 | 찾기 · 원격 · 도움말 | 플러그인 항목(부관 등) | Zen 켜기/끄기
 *
 * 줄은 자기 DOM 노드를 하나 만들어 들고, 자리가 바뀌면 그 노드를 새 자리로 옮긴다. React는 같은
 * 노드에 계속 포털하므로 안의 항목이 다시 마운트되지 않는다 — 플러그인은 자리가 사라졌다고 보지
 * 않고(부관이 캔버스로 돌아가지 않는다), 열린 메뉴·도구 칸의 포털도 끊기지 않는다.
 *
 * Zen 버튼은 늘 맨 끝 칸이다. 그래서 일반 모드의 켜기와 Zen의 끄기가 도구모음의 같은 자리에 선다.
 * 접으면 도구만 말려 들어가고, 플러그인 항목과 Zen 버튼은 남는다.
 *
 * 칸의 이름은 한 장의 말풍선이 말한다(toolbar-tip.tsx) — 칸은 네이티브 title 대신 data-tip을 든다.
 */

const FOLD_STORAGE_KEY = "fleet-console.toolbar.folded";
/** 1차 Zen 트레이의 접힘 기억 — 한 번 읽어 옮기고 걷는다. */
const LEGACY_FOLD_STORAGE_KEY = "fleet-console.zen.tools-folded";
/** 서랍 전이(layout.css .console-toolbar-drawer의 360ms)보다 조금 길게 — 전이가 끝난 뒤에 자름을 푼다. */
const FOLD_TRANSITION_MS = 420;

function readFolded(): boolean {
  try {
    const stored = window.localStorage.getItem(FOLD_STORAGE_KEY);
    if (stored !== null) return stored === "true";
    const legacy = window.localStorage.getItem(LEGACY_FOLD_STORAGE_KEY);
    if (legacy === null) return false;
    window.localStorage.setItem(FOLD_STORAGE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_FOLD_STORAGE_KEY);
    return legacy === "true";
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
  /** Zen이 이 창에서 실제로 켜져 있는가 — 켜져 있으면 줄이 Zen 트레이에 선다. */
  readonly zen: boolean;
  /** 캔버스 화면인가(/operations 데스크톱). 아니면 Zen 칸을 비운다. */
  readonly canvas: boolean;
}

export function ConsoleToolbar({ zen, canvas }: ConsoleToolbarProps) {
  const t = useT();
  const bandHost = useToolbarHost("band");
  const zenHost = useToolbarHost("zen");
  const host = zen ? zenHost : bandHost;
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
    // 노드를 옮기면 브라우저가 그 안의 포커스를 놓는다 — 키보드로 Zen을 켜고 끈 사람은 같은 버튼에 남아야 한다.
    const focused = document.activeElement;
    const keepFocus = focused instanceof HTMLElement && mount.contains(focused) ? focused : null;
    host.appendChild(mount);
    keepFocus?.focus({ preventScroll: true });
  }, [host, mount]);
  useLayoutEffect(() => () => mount.remove(), [mount]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(readFolded);
  // 서랍이 말리거나 펴지는 동안만 가로를 자른다 — 늘 자르면 서랍보다 넓은 메뉴(원격·도움말)가 잘린다.
  const [folding, setFolding] = useState(false);
  const foldingTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (foldingTimerRef.current !== null) window.clearTimeout(foldingTimerRef.current); }, []);
  const toggleFold = () => {
    const next = !folded;
    setFolded(next);
    writeFolded(next);
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
        </div>
      </div>
      <ToolbarPluginEntries />
      {canvas ? <ZenToggle zen={zen} /> : null}
    </div>,
    mount,
  );
}

/**
 * 플러그인이 크롬에 둔 항목(부관 글리프 등). 도구모음 안에 서므로 모드가 바뀌어도 자리째 따라간다.
 * 접기 서랍 밖에 둔다 — 부관의 답 말풍선이 글리프를 닻으로 삼으므로 접어도 사라지지 않아야 한다.
 */
function ToolbarPluginEntries() {
  const { commandBandEntries } = usePluginRegistry();
  if (commandBandEntries.length === 0) return null;
  return (
    <span className="console-toolbar-plugins">
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

/**
 * Zen 켜기/끄기 — 도구모음의 맨 끝 칸. 켜기는 도구 아이콘과 같은 잉크로 조용히 서고, 끄기는 옅은 coral
 * ×로 선다(겨눌 때만 붉은 면). 이름은 도구모음의 말풍선이 말한다 — 상단 바에서는 아래로, 트레이에서는 위로 뜬다.
 */
function ZenToggle({ zen }: { readonly zen: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`console-toolbar-zen${zen ? " is-exit" : ""}`}
      aria-label={t(zen ? "zen.exit" : "zen.enter")}
      data-tip={t(zen ? "zen.exitShort" : "zen.enterShort")}
      // 누르는 순간 포커스를 옮기지 않는다 — 전환 뒤 포커스 복귀는 앱 셸의 작업면 규칙이 맡는다.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => requestZenMode(!zen)}
    >
      {zen ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 5.5 5 5m0-5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
          <path d="M7.5 10h5" />
        </svg>
      )}
    </button>
  );
}
