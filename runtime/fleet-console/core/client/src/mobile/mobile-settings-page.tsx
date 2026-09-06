import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { loadGlobalSettings, useGlobalSettingsStore } from "../global-settings-store.js";
import { useConsoleLocale, useT, type CoreMessageKey } from "../i18n/index.js";
import {
  collectPluginSettingsSections,
  renderSettingsSection,
  resolveSettingsSectionId,
  type PluginSettingsNavItem,
  type SettingsSectionId,
} from "../settings/sections.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { DEFAULT_UI_FONT, UI_FONT_BUILT_INS } from "../ui-font.js";
import type { GlobalSettingsState, ThemeId } from "../types.js";
import "../styles/mobile.css";

/**
 * The phone's Settings surface. The desktop keeps a section list beside the section it opens; on a
 * phone that list has nowhere to stand beside anything, so it takes the screen and pushes the
 * section below the fold. Here the two are separate destinations: the list is a screen, and opening
 * a row is a navigation, so the section that was asked for gets the whole width.
 *
 * The section lives in the URL rather than in state, which is what makes the platform back gesture
 * return to the list instead of leaving Settings.
 */

/** 폰과 데스크톱은 같은 `/settings` 주소를 쓰므로 섹션 id 어휘도 하나다. */
type MobileSectionId = SettingsSectionId;

interface MobileSettingsRow {
  readonly id: MobileSectionId;
  readonly title: string;
  /** What this row currently holds, so the list answers without being opened. */
  readonly value: string | null;
  readonly icon: ReactNode;
}

interface MobileSettingsGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly MobileSettingsRow[];
}

/** A detail screen was reached from the list here, so its Back retraces that step. */
interface MobileSettingsLocationState {
  readonly mobileSettingsEntry?: true;
}

export function MobileSettingsPage() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const registry = usePluginRegistry();
  const locale = useConsoleLocale();
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    void loadGlobalSettings(controller.signal);
    return () => controller.abort();
  }, []);

  const pluginSections = collectPluginSettingsSections(registry.plugins, locale, t);
  const groups = buildMobileSettingsGroups(state, pluginSections, t);
  const rows = groups.flatMap((group) => group.rows);
  const requested = new URLSearchParams(location.search).get("section");
  // 옛 id와 상대 레이아웃이 만든 id를 데스크톱과 같은 판정으로 옮긴다. 닿지 못한 id는 여기서
  // 대신할 섹션을 고르지 않는다 — 폰에는 돌아갈 목록이 있고, 아래 effect가 그리로 되돌린다.
  const resolved = resolveSettingsSectionId(requested, new Set(rows.map((row) => row.id)));
  const active = resolved === null ? null : rows.find((row) => row.id === resolved) ?? null;

  const open = (id: MobileSectionId) => {
    const entry: MobileSettingsLocationState = { mobileSettingsEntry: true };
    navigate({ pathname: "/settings", search: `?section=${encodeURIComponent(id)}` }, { state: entry });
  };
  const close = () => {
    // Popping is only correct when the entry above is this list. A direct load or a reload has no
    // such entry, and popping there would leave the Console entirely.
    if ((location.state as MobileSettingsLocationState | null)?.mobileSettingsEntry) { navigate(-1); return; }
    navigate({ pathname: "/settings", search: "" }, { replace: true });
  };

  // An unknown section — a stale link, or one whose plugin is gone — resolves to the list rather
  // than to an empty screen, and the address is corrected so a reload does not repeat the miss.
  useEffect(() => {
    if (requested === null || state === null) return;
    if (active === null) { navigate({ pathname: "/settings", search: "" }, { replace: true }); return; }
    // 이행된 id는 주소에도 반영한다 — 남겨 두면 새로 고칠 때마다 같은 이행을 되풀이한다.
    if (active.id !== requested) navigate({ pathname: "/settings", search: `?section=${encodeURIComponent(active.id)}` }, { replace: true, state: location.state });
  }, [active, location.state, navigate, requested, state]);

  if (active !== null) {
    return (
      <section className="mobile-settings-page" aria-labelledby="mobile-settings-detail-title">
        <header className="mobile-list-header">
          <button type="button" className="mobile-settings-back" onClick={close} aria-label={t("mobile.settings.back")}>
            <BackIcon />
          </button>
          <h1 id="mobile-settings-detail-title">{active.title}</h1>
          <span className="mobile-settings-saving" role="status" aria-live="polite">{saving ? t("settings.saving") : ""}</span>
        </header>
        <div className="mobile-settings-scroll">
          <div className="mobile-settings-detail">
            {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
            {renderSettingsSection(active.id, state, saving, pluginSections, t)}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mobile-settings-page" aria-labelledby="mobile-settings-title">
      <header className="mobile-list-header">
        <h1 id="mobile-settings-title">{t("mobile.tabs.settings")}</h1>
      </header>
      <div className="mobile-settings-scroll">
        <div className="mobile-settings-groups">
          {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
          {groups.map((group) => (
            <div className="mobile-settings-group" key={group.key}>
              <p className="mobile-settings-group-label">{group.label}</p>
              <div className="mobile-settings-rows">
                {group.rows.map((row) => (
                  <button type="button" className="mobile-settings-row" key={row.id} onClick={() => open(row.id)}>
                    <span className="mobile-settings-row-icon" aria-hidden="true">{row.icon}</span>
                    <span className="mobile-settings-row-copy">
                      <strong>{row.title}</strong>
                      {row.value === null ? null : <span>{row.value}</span>}
                    </span>
                    <span className="mobile-operation-chevron" aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * 폰은 목록과 섹션을 두 화면으로 가르지만, 어떤 섹션이 있는지는 데스크톱과 같은 어휘로 읽는다 —
 * 두 레이아웃이 같은 주소를 공유하므로 한쪽만 아는 섹션이 생기면 그 링크가 다른 쪽에서 끊긴다.
 * 각 행은 열지 않고도 지금 무엇이 들어 있는지 말한다.
 */
function buildMobileSettingsGroups(
  state: GlobalSettingsState | null,
  pluginSections: readonly PluginSettingsNavItem[],
  t: (key: CoreMessageKey) => string,
): readonly MobileSettingsGroup[] {
  const setupRows: MobileSettingsRow[] = [
    { id: "appearance", title: t("settings.core.appearance.label"), value: describeAppearance(state, t), icon: <AppearanceIcon /> },
    { id: "language", title: t("settings.core.language.label"), value: describeLanguage(state, t), icon: <ConsoleIcon /> },
  ];
  const machineRows: MobileSettingsRow[] = [
    { id: "advanced", title: t("settings.core.advanced.label"), value: null, icon: <ApiIcon /> },
  ];

  // 플러그인이 선언한 group은 두 레이아웃에서 같은 뜻이어야 한다 — 폰이 전부 Work로 몰아 넣으면
  // 방금 연 SDK 계약이 화면마다 다르게 읽힌다.
  const workRows: MobileSettingsRow[] = [];
  for (const section of pluginSections) {
    const row: MobileSettingsRow = {
      id: section.id,
      title: section.sectionTitle,
      value: section.pluginLabel === section.sectionTitle ? null : section.pluginLabel,
      icon: <PluginIcon />,
    };
    if (section.group === "setup") setupRows.push(row);
    else if (section.group === "machine") machineRows.push(row);
    else if (section.group === "experiments") continue;
    else workRows.push(row);
  }

  const groups: MobileSettingsGroup[] = [{ key: "setup", label: t("settings.group.setup"), rows: setupRows }];
  if (workRows.length > 0) groups.push({ key: "work", label: t("settings.group.work"), rows: workRows });
  groups.push({ key: "machine", label: t("settings.group.machine"), rows: machineRows });
  // 연결과 실험 그룹 플러그인 섹션은 실험 페이지 안의 카드다 — 폰도 행을 따로 세우지 않는다.
  const experimentRows: MobileSettingsRow[] = [
    { id: "experiments", title: t("settings.core.experiments.label"), value: [describeExperiments(state, t), describeConnectivity(state, t)].filter(Boolean).join(" · ") || null, icon: <RemoteIcon /> },
  ];
  groups.push({ key: "experiments", label: t("settings.group.experiments"), rows: experimentRows });
  return groups;
}

function describeExperiments(state: GlobalSettingsState | null, t: (key: CoreMessageKey) => string): string | null {
  if (state === null) return null;
  const { experiments } = state;
  const on = [experiments.promptRefine, experiments.launchContextPack, experiments.sessionWatch, experiments.aideConsoleRead].filter(Boolean).length;
  return on === 0 ? null : `${on} ${t("mobile.settings.on")}`;
}

function describeAppearance(state: GlobalSettingsState | null, t: (key: CoreMessageKey) => string): string | null {
  if (state === null) return null;
  return [themeLabel(state.theme, t), fontLabel(state)].join(" · ");
}

function describeLanguage(state: GlobalSettingsState | null, t: (key: CoreMessageKey) => string): string | null {
  if (state === null) return null;
  return state.language === "auto" ? t("settings.language.auto") : state.language === "ko" ? t("settings.language.ko") : t("settings.language.en");
}

/**
 * remoteAccess가 실리지 않은 콘솔은 그 기능을 아예 갖고 있지 않다 — 데스크톱이 카드를 세우지
 * 않는 것과 같은 읽기로, 폰도 포트만 말한다.
 */
function describeConnectivity(state: GlobalSettingsState | null, t: (key: CoreMessageKey) => string): string | null {
  if (state === null) return null;
  const port = t(state.consolePortMode === "static" ? "settings.port.static" : "settings.port.dynamic");
  if (state.remoteAccess === undefined) return port;
  return [port, t(state.remoteAccess.enabled ? "mobile.settings.on" : "mobile.settings.off")].join(" · ");
}

function themeLabel(theme: ThemeId, t: (key: CoreMessageKey) => string): string {
  switch (theme) {
    case "maritime": return t("settings.theme.maritime");
    case "carbon": return t("settings.theme.carbon");
    case "whites": return t("settings.theme.whites");
    default: return t("settings.theme.instrument");
  }
}

function fontLabel(state: GlobalSettingsState): string {
  const uiFont = state.uiFont ?? DEFAULT_UI_FONT;
  if (uiFont.source === "system") return uiFont.familyName;
  return UI_FONT_BUILT_INS.find((font) => font.id === uiFont.id)?.label ?? uiFont.id;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5 6.5 10l5.5 5.5" />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="6.4" />
      <path d="M10 3.6v12.8" />
    </svg>
  );
}

function ConsoleIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="11" rx="2" />
      <path d="M6.5 9 8.5 11l-2 2M11 13h3" />
    </svg>
  );
}

function RemoteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.4 12.4a5.6 5.6 0 0 1 11.2 0M1.9 9.4a9 9 0 0 1 16.2 0" />
      <circle cx="10" cy="15.1" r="1.2" />
    </svg>
  );
}

function ApiIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.2 4 3.6 10l3.6 6M12.8 4l3.6 6-3.6 6" />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.2 16 6.6v6.8L10 16.8 4 13.4V6.6Z" />
    </svg>
  );
}
