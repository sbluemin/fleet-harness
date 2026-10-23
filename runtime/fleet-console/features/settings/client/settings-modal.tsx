import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { getPaneStoreSnapshot } from "../../../core/client/src/chrome/pane/pane-store.js";
import { closeRailPanel, openRailPanel, useRailActivePanelId } from "../../../core/client/src/chrome/rail/rail-store.js";
import { useConsoleLocale, useT } from "../../../core/client/src/i18n/index.js";
import { useFeatureRegistry } from "../../../core/client/src/integration/feature-registry.js";
import { loadGlobalSettings, useGlobalSettingsStore } from "./global-settings-store.js";
import {
  buildCoreSettingsSections,
  collectPluginSettingsSections,
  renderSettingsSection,
  resolveSettingsSectionId,
  SearchIcon,
  type SettingsSectionId,
} from "./sections.js";
import { closeSettingsModal, openSettingsModal, setSettingsModalSection, useSettingsModal } from "./settings-door.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "./settings-entry.js";
import { buildChips, hostSectionOf, type SettingsChip } from "./settings-pane.js";
import "./settings-modal.css";

/**
 * 데스크톱 설정 — 대화 중심 화면 가운데 모달.
 *
 * 왼쪽은 범주 목록(글리프 + 이름, 고른 행은 은은한 면), 오른쪽은 범주 제목 아래 소제목별 둥근 묶음 카드다. 본문은
 * 레일 페인과 같은 섹션 렌더러를 쓴다 — 그릇만 다르다(settings-door.ts). 검색은 왼쪽 목록을 거른다: 찾는 동안에도
 * 오른쪽 본문은 그대로 서 있고, Enter 는 첫 결과로 간다.
 */
export function SettingsModalHost({ visible, mobile }: {
  /** 대화 중심 화면이 지금 그려져 있는가(데스크톱 + ObjectiveRecords 화면). */
  readonly visible: boolean;
  readonly mobile: boolean;
}) {
  const modal = useSettingsModal();
  const railActive = useRailActivePanelId();
  const lastPanelRef = useRef<string | null>(null);
  if (railActive !== null && railActive !== SETTINGS_RAIL_ENTRY_ID) lastPanelRef.current = railActive;

  // 모바일로 바뀌면 모달을 닫는다. 설정의 문은 레일을 열지 않지만, 이전 릴리스가 저장한 레일 활성 패널(localStorage)이나
  // 플러그인의 rail.open("settings")이 레일에 설정을 세우면 데스크톱에서 같은 섹션의 모달로 옮겨 선다.
  useLayoutEffect(() => {
    if (mobile && modal.open) {
      closeSettingsModal();
      return;
    }
    if (!mobile && railActive === SETTINGS_RAIL_ENTRY_ID) {
      const section = getPaneStoreSnapshot().rail.find((instance) => instance.paneId === SETTINGS_PANE_ID)?.params.section;
      closeRailPanel(SETTINGS_RAIL_ENTRY_ID);
      // 레일은 독점 슬롯이라 설정이 서며 앞의 패널을 내렸다 — 모달은 패널을 밀어내지 않으므로 그 패널을 되세운다.
      if (lastPanelRef.current !== null) openRailPanel(lastPanelRef.current);
      openSettingsModal(section ?? null);
    }
  }, [mobile, modal.open, railActive]);

  return visible && modal.open ? <SettingsModal section={modal.section} /> : null;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function SettingsModal({ section }: { readonly section: string | null }) {
  const t = useT();
  const locale = useConsoleLocale();
  const registry = useFeatureRegistry();
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields;
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    const controller = new AbortController();
    void loadGlobalSettings(controller.signal);
    return () => controller.abort();
  }, []);

  // 모달 밖은 손이 닿지 않는다. 설정 안에서 뜨는 대화상자(기기 페어링·호스트 추가)도 같은 셸을 inert 로 걸었다가
  // 닫으며 풀어 버리므로, 모달이 서 있는 동안은 다시 건다. 닫을 때는 inert 를 먼저 풀어야 포커스 복원이 먹는다.
  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>(".console-shell");
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wasInert = shell?.inert ?? false;
    if (shell) shell.inert = true;
    const observer = shell ? new MutationObserver(() => { if (!shell.inert) shell.inert = true; }) : null;
    if (shell) observer?.observe(shell, { attributes: true, attributeFilter: ["inert"] });
    // 처음 손이 닿는 자리는 지금 보는 범주다 — 검색에 커서를 세우면 열자마자 입력 상태가 되어 시끄럽다.
    navRef.current?.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')?.focus({ preventScroll: true });
    return () => {
      observer?.disconnect();
      if (shell) shell.inert = wasInert;
      // 문은 아바타 메뉴 안에 있어 메뉴가 닫히면 숨는다 — 그때는 메뉴를 연 아바타로 돌아간다.
      const target = returnTo?.isConnected && returnTo.offsetParent !== null
        ? returnTo
        : document.querySelector<HTMLElement>(".conversation-dock-avatar");
      target?.focus({ preventScroll: true });
    };
  }, []);

  const coreSections = buildCoreSettingsSections(t, state);
  const pluginSections = collectPluginSettingsSections(registry.providers, locale, t);
  const chips = useMemo(() => buildChips(coreSections, pluginSections), [coreSections, pluginSections]);
  const available = useMemo(() => new Set<string>(chips.map((chip) => chip.id)), [chips]);
  const activeId = resolveSettingsSectionId(hostSectionOf(section, coreSections, pluginSections), available) ?? "appearance";
  const active = chips.find((chip) => chip.id === activeId) ?? null;
  const trimmed = query.trim().toLowerCase();
  const listed = trimmed === "" ? chips : chips.filter((chip) => chip.haystack.includes(trimmed));
  // 검색이 고른 섹션을 걸러 냈으면 첫 결과가 목록의 Tab 정지점이 된다.
  const activeListed = listed.some((chip) => chip.id === activeId);

  const select = (next: SettingsSectionId) => {
    setSettingsModalSection(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 설정 안에서 포털로 뜬 대화상자(페어링 등)의 키는 React 트리를 타고 여기까지 올라온다 — 그 대화상자의 몫이다.
    const target = event.target instanceof Node ? event.target : null;
    if (target === null || !dialogRef.current?.contains(target)) return;
    if (event.key === "Escape") {
      if (event.defaultPrevented) return;
      event.preventDefault();
      // 검색이 서 있는 동안의 첫 Esc 는 검색을 거둔다(레일 페인과 같은 층위 문법).
      if (trimmed !== "") { setQuery(""); return; }
      closeSettingsModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  const handleNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    buttons[next]?.click();
  };

  return createPortal(
    <div className="settings-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettingsModal(); }}>
      <div
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={handleKeyDown}
      >
        <nav className="settings-modal-nav" aria-label={t("settings.pane.chipsAria")}>
          <div className="settings-modal-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              placeholder={t("settings.search.placeholder")}
              aria-label={t("settings.search.aria")}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || listed.length === 0) return;
                event.preventDefault();
                select(listed[0]!.id);
                setQuery("");
              }}
            />
          </div>
          <div ref={navRef} className="settings-modal-tabs" role="tablist" aria-orientation="vertical" aria-label={t("settings.pane.chipsAria")} onKeyDown={handleNavKeyDown}>
            {listed.length === 0 ? <p className="settings-modal-empty">{t("settings.search.empty")}</p> : listed.map((chip, index) => (
              <button
                key={chip.id}
                id={`${id}-tab-${chip.id}`}
                type="button"
                role="tab"
                className="settings-modal-tab"
                aria-selected={chip.id === activeId}
                aria-controls={`${id}-panel`}
                tabIndex={chip.id === activeId || (index === 0 && !activeListed) ? 0 : -1}
                onClick={() => select(chip.id)}
              >
                <span className="settings-modal-tab-glyph" aria-hidden="true">{sectionGlyph(chip)}</span>
                <span className="settings-modal-tab-label">{chip.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <section className="settings-modal-main">
          <button type="button" className="settings-modal-close" aria-label={t("conversation.panel.close")} title={t("conversation.panel.close")} onClick={closeSettingsModal}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          {/* 섹션 전환은 재마운트다 — 한 플러그인 섹션의 렌더 실패가 다음 섹션으로 번지지 않고, 스크롤도 맨 위에서 선다. */}
          <div key={activeId} id={`${id}-panel`} className="settings-modal-scroll" role="tabpanel" aria-labelledby={`${id}-tab-${activeId}`}>
            <header className="settings-modal-head">
              <h2 id={`${id}-title`} className="settings-modal-title">
                {active?.label ?? t("settings.title")}
                {active?.help ? <SettingsHelp title={active.label}>{active.help}</SettingsHelp> : null}
              </h2>
            </header>
            {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
            {/* 카드·행 문법은 레일 페인의 것을 그대로 받고(settings-pane), 모달 그릇의 여백·둥근 면만 덧입힌다(settings-modal.css). */}
            <div className="settings-pane settings-modal-sections">
              {renderSettingsSection(activeId, state, saving, pluginSections, t)}
            </div>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

/** 범주의 글리프 — 코어 섹션과 코어가 아는 플러그인 섹션은 자기 그림을, 그 밖의 플러그인 섹션은 조절기 그림을 쓴다. */
function sectionGlyph(chip: SettingsChip): ReactNode {
  return GLYPHS[chip.id] ?? GLYPHS.fallback;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const GLYPHS: Readonly<Record<string, ReactNode>> = {
  appearance: (
    <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6" {...stroke} /><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" /></svg>
  ),
  shortcuts: (
    <svg viewBox="0 0 16 16"><rect x="1.8" y="4" width="12.4" height="8" rx="1.8" {...stroke} /><path d="M4.4 6.6h.01M6.8 6.6h.01M9.2 6.6h.01M11.6 6.6h.01M5.6 9.4h4.8" {...stroke} /></svg>
  ),
  "terminal:general": (
    <svg viewBox="0 0 16 16"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" {...stroke} /><path d="M4.6 6.4 6.6 8l-2 1.6M8.2 10h3" {...stroke} /></svg>
  ),
  "terminal:agent-cli": (
    <svg viewBox="0 0 16 16"><circle cx="3.6" cy="8" r="1.6" {...stroke} /><circle cx="12.4" cy="3.8" r="1.6" {...stroke} /><circle cx="12.4" cy="12.2" r="1.6" {...stroke} /><path d="M5.2 8h2.4l3.2-3.4M7.6 8l3.2 3.4" {...stroke} /></svg>
  ),
  connectivity: (
    <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.8" {...stroke} /><path d="M2.4 8h11.2M8 2.2c1.7 1.6 2.5 3.5 2.5 5.8S9.7 12.2 8 13.8M8 2.2C6.3 3.8 5.5 5.7 5.5 8s.8 4.2 2.5 5.8" {...stroke} /></svg>
  ),
  advanced: (
    <svg viewBox="0 0 16 16"><path d="M5.6 3C4 3 4 4 4 5.2v.9c0 .9-.6 1.6-1.6 1.9.9.3 1.6 1 1.6 1.9v.9C4 12 4 13 5.6 13M10.4 3C12 3 12 4 12 5.2v.9c0 .9.6 1.6 1.6 1.9-.9.3-1.6 1-1.6 1.9v.9c0 1.2 0 2.2-1.6 2.2" {...stroke} /></svg>
  ),
  experiments: (
    <svg viewBox="0 0 16 16"><path d="M6.2 2.2h3.6M6.8 2.2v4L3.2 12.4c-.5.8.1 1.6 1 1.6h7.6c.9 0 1.5-.8 1-1.6L9.2 6.2v-4M4.8 9.8h6.4" {...stroke} /></svg>
  ),
  fallback: (
    <svg viewBox="0 0 16 16"><path d="M2.4 4.8h6.4M11.6 4.8h2M2.4 11.2h2M7.2 11.2h6.4" {...stroke} /><circle cx="10.2" cy="4.8" r="1.4" {...stroke} /><circle cx="5.8" cy="11.2" r="1.4" {...stroke} /></svg>
  ),
};
