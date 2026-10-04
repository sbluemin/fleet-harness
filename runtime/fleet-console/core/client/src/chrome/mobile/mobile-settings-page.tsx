import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";
import { isFleetMobileShell } from "@fleet-console/link/core";
import { useLocation, useNavigate } from "react-router-dom";

import { loadGlobalSettings, useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { useConsoleLocale, useT, type CoreMessageKey } from "../../i18n/index.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { pushBackLayer } from "./mobile-back.js";
import {
  collectPluginSettingsSections,
  renderSettingsSection,
  resolveSettingsSectionId,
  type PluginSettingsNavItem,
  type SettingsSectionId,
} from "../../../../../features/settings/client/sections.js";
import { usePluginRegistry } from "../../integration/plugin-registry.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { setMobileColorMode, setMobileFontScale, useMobileAppearance, type MobileAppearanceSnapshot } from "../../integration/mobile-appearance-store.js";
import { openWhatsNew } from "../../integration/store.js";
import type { GlobalSettingsState } from "../../integration/types.js";
import { setViewModePreference, useViewMode, type ViewModePreference } from "../../integration/view-mode-store.js";
import { MobileIcon, type MobileIconName } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { pushMobileSheet } from "./mobile-store.js";
import "../../styles/mobile.css";

/**
 * The phone's Settings surface. The desktop keeps a section list beside the section it opens; on a
 * phone that list has nowhere to stand beside anything, so it takes the screen and pushes the
 * section below the fold. Here the two are separate destinations: the list is a screen, and opening
 * a row is a navigation, so the section that was asked for gets the whole width.
 *
 * The section lives in the URL rather than in state, which is what makes the platform back gesture
 * return to the list instead of leaving Settings.
 */

/**
 * 폰의 설정(S-47/S-48): 위에 지금 Console 카드, 아래에 눈에 보이는 머리 없는 묶음 넷 — 화면 · 에이전트 · 사용 · 정보.
 * 행을 열면 상세(push)다. 색상 모드·글자 크기·화면 배치는 폰 전용 선호(모바일 외관 스토어·보기 모드)라 서버 설정을 쓰지 않는다 —
 * Console 테마 선택은 없다(BD-G7 a). 그 밖의 섹션은 현행 설정 본문을 그대로 그린다.
 */

/** 폰과 데스크톱은 같은 `/settings` 주소를 쓰므로 섹션 id 어휘도 하나다. 폰 전용 상세는 아래 LOCAL_IDS다. */
type MobileSectionId = SettingsSectionId | LocalSectionId;
type LocalSectionId = "color-mode" | "font-scale" | "layout" | "about" | "help";
const LOCAL_IDS: ReadonlySet<string> = new Set(["color-mode", "font-scale", "layout", "about", "help"]);

interface MobileSettingsRow {
  readonly id: MobileSectionId;
  readonly title: string;
  /** What this row currently holds, so the list answers without being opened. */
  readonly value: string | null;
  readonly icon: ReactNode;
  /** 상세 대신 시트·동작으로 가는 행(새 기능). */
  readonly act?: () => void;
  /** 값이 플러그인 섹션에서 오는 행 — 그 섹션의 `mobile.summary`가 보조 줄을 그리고 `subscribe`로 갱신한다. */
  readonly summarySection?: PluginSettingsNavItem;
}

type MobileSettingsGroupId = "display" | "agent" | "use" | "about";

interface MobileSettingsGroup {
  readonly key: string;
  readonly rows: readonly MobileSettingsRow[];
}

/** A detail screen was reached from the list here, so its Back retraces that step. */
interface MobileSettingsLocationState {
  readonly mobileSettingsEntry?: true;
}

export function MobileSettingsPage() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields.size > 0;
  const registry = usePluginRegistry();
  const locale = useConsoleLocale();
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const appearance = useMobileAppearance();
  const viewMode = useViewMode();
  const consoleState = useConsoleState();

  useEffect(() => {
    const controller = new AbortController();
    void loadGlobalSettings(controller.signal);
    return () => controller.abort();
  }, []);

  const pluginSections = collectPluginSettingsSections(registry.providers, locale, t, "mobile");
  const open = (id: MobileSectionId) => {
    const entry: MobileSettingsLocationState = { mobileSettingsEntry: true };
    navigate({ pathname: "/settings", search: `?section=${encodeURIComponent(id)}` }, { state: entry });
  };
  const groups = buildMobileSettingsGroups({ state, appearance, viewMode: viewMode.preference, version: consoleState.version, consoleLatest: !consoleState.updateAvailable, pluginSections, t, locale });
  const rows = groups.flatMap((group) => group.rows);
  const requested = new URLSearchParams(location.search).get("section");
  // 폰 전용 상세는 그대로, 그 밖의 옛 id와 상대 레이아웃이 만든 id는 데스크톱과 같은 판정으로 옮긴다.
  const resolved = requested !== null && LOCAL_IDS.has(requested) ? requested : resolveSettingsSectionId(requested, new Set(rows.map((row) => row.id)));
  const active = resolved === null ? null : rows.find((row) => row.id === resolved && row.act === undefined) ?? (resolved === "language" ? LANGUAGE_ROW(t) : null);

  const close = () => {
    // Popping is only correct when the entry above is this list. A direct load or a reload has no
    // such entry, and popping there would leave the Console entirely.
    if ((location.state as MobileSettingsLocationState | null)?.mobileSettingsEntry) { navigate(-1); return; }
    navigate({ pathname: "/settings", search: "" }, { replace: true });
  };

  // 막대는 호스트가 그린다 — 목록은 ≡ + ⓘ(버전), 섹션 상세는 ‹(목록에서 왔으면 history 되돌리기).
  useClaimMobileBar(active !== null
    ? { variant: "centered", title: active.title, leading: "back", onBack: close }
    : { variant: "centered", title: t("mobile.drawer.settings"), leading: "menu", actions: [{ id: "about", icon: <MobileIcon name="info" />, label: t("mobile.settings.about"), run: () => open("about") }] });

  // 섹션 상세가 열려 있는 동안 하드웨어 뒤로는 그것을 닫는다(목록으로).
  const closeRef = useRef(close);
  closeRef.current = close;
  const detailOpen = active !== null;
  useEffect(() => (detailOpen ? pushBackLayer(() => closeRef.current()) : undefined), [detailOpen]);

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
        <h1 id="mobile-settings-detail-title" className="mobile-visually-hidden">{active.title}</h1>
        <span className="mobile-settings-saving" role="status" aria-live="polite">{saving ? t("settings.saving") : ""}</span>
        <div className="mobile-settings-scroll">
          <div className="mobile-settings-detail">
            {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
            {LOCAL_IDS.has(active.id)
              ? <LocalDetail id={active.id as LocalSectionId} appearance={appearance} viewMode={viewMode.preference} version={consoleState.version} consoleLatest={!consoleState.updateAvailable} openSection={open} />
              : renderSettingsSection(active.id as SettingsSectionId, state, settings.savingFields, pluginSections, t)}
          </div>
        </div>
      </section>
    );
  }

  const connected = consoleState.connection === "live";
  const consoleName = appearance.console?.label ?? window.location.hostname;
  return (
    <section className="mobile-settings-page" aria-labelledby="mobile-settings-title">
      <h1 id="mobile-settings-title" className="mobile-visually-hidden">{t("mobile.drawer.settings")}</h1>
      <div className="mobile-settings-scroll">
        <div className="mobile-settings-groups">
          {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
          <button type="button" className="mobile-console-card" onClick={() => pushMobileSheet({ kind: "console" })}>
            <MobileMonogram label={consoleName} toneKey={consoleName} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? null} round size={36} />
            <span className="mobile-console-card-copy"><strong>{consoleName}</strong><small>{window.location.host}</small></span>
            <span className="mobile-state-chip"><span className={statusGlyphClassName(connected ? "idle" : "running")} aria-hidden="true" />{t(connected ? "mobile.settings.connected" : "mobile.settings.reconnecting")}</span>
            <MobileIcon name="down" size={18} className="mobile-group-row-caret" />
          </button>
          {groups.map((group) => (
            <div className="mobile-group is-flush" key={group.key}>
              {group.rows.map((row) => (
                <button type="button" className={`mobile-group-row${row.value === null && !row.summarySection ? "" : " is-two"}`} key={row.id} onClick={() => (row.act ? row.act() : open(row.id))}>
                  <span className="mobile-group-row-icon" aria-hidden="true">{row.icon}</span>
                  <span className="mobile-group-row-copy">{row.title}{row.summarySection ? <SectionSummary section={row.summarySection} locale={locale} /> : row.value === null ? null : <small>{row.value}</small>}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** 플러그인 섹션이 올린 요약 한 줄 — 구독 신호가 오면 다시 읽는다. 값이 없으면 줄 자체를 그리지 않는다. */
function SectionSummary({ section, locale }: { readonly section: PluginSettingsNavItem; readonly locale: ConsoleLocale }) {
  const mobile = section.mobile;
  const text = useSyncExternalStore(mobile?.subscribe ?? NO_SUBSCRIBE, () => mobile?.summary?.(locale) ?? null, () => null);
  return text === null ? null : <small>{text}</small>;
}
const NO_SUBSCRIBE = () => () => undefined;

const LANGUAGE_ROW = (t: (key: CoreMessageKey) => string): MobileSettingsRow => ({ id: "language", title: t("settings.core.language.label" as CoreMessageKey), value: null, icon: null });

/** 폰 전용 상세 — 라디오 행과 한 줄 설명으로만 이루어진다. */
function LocalDetail({ id, appearance, viewMode, version, consoleLatest, openSection }: {
  readonly id: LocalSectionId;
  readonly appearance: MobileAppearanceSnapshot;
  readonly viewMode: ViewModePreference;
  readonly version: string;
  readonly consoleLatest: boolean;
  readonly openSection: (id: MobileSectionId) => void;
}) {
  const t = useT();
  if (id === "color-mode") {
    return (
      <>
        <div className="mobile-group is-flush">
          <RadioRow checked={appearance.colorMode === "system"} label={t("mobile.settings.color.system")} sub={t("mobile.settings.color.systemSub")} onSelect={() => setMobileColorMode("system")} />
          <RadioRow checked={appearance.colorMode === "dark"} label={t("mobile.settings.color.dark")} onSelect={() => setMobileColorMode("dark")} />
          <RadioRow checked={appearance.colorMode === "light"} label={t("mobile.settings.color.light")} onSelect={() => setMobileColorMode("light")} />
        </div>
        <p className="mobile-secnote">{t("mobile.settings.color.note")}</p>
      </>
    );
  }
  if (id === "font-scale") {
    return (
      <div className="mobile-group is-flush">
        {(["small", "default", "large"] as const).map((scale) => (
          <RadioRow key={scale} checked={appearance.fontScale === scale} label={t(`mobile.settings.font.${scale}`)} onSelect={() => setMobileFontScale(scale)} />
        ))}
      </div>
    );
  }
  if (id === "layout") {
    // Fleet 앱에서는 데스크톱 배치를 고를 수 없다(D38) — 브라우저에서는 활성이고 여기서 늘 돌아올 수 있다.
    const app = isFleetMobileShell();
    return (
      <div className="mobile-group is-flush">
        <RadioRow checked={viewMode === "auto"} label={t("mobile.settings.layout.auto")} sub={t("mobile.settings.layout.autoSub")} onSelect={() => setViewModePreference("auto")} />
        <RadioRow checked={viewMode === "mobile"} label={t("mobile.settings.layout.mobile")} sub={t("mobile.settings.layout.mobileSub")} onSelect={() => setViewModePreference("mobile")} />
        <RadioRow checked={viewMode === "desktop"} label={t("mobile.settings.layout.desktop")} sub={app ? t("mobile.settings.layout.desktopApp") : undefined} disabled={app} onSelect={() => setViewModePreference("desktop")} />
      </div>
    );
  }
  if (id === "help") {
    return (
      <>
        <div className="mobile-group is-flush">
          {(["drawer", "start", "request", "pairing"] as const).map((topic) => (
            <div className="mobile-group-row" key={topic}>
              <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="help" /></span>
              <span className="mobile-group-row-copy">{t(`mobile.settings.help.${topic}`)}</span>
            </div>
          ))}
        </div>
        <p className="mobile-secnote">{t("mobile.settings.help.note")}</p>
      </>
    );
  }
  return (
    <div className="mobile-group is-flush">
      <div className="mobile-group-row is-two"><span className="mobile-group-row-copy">Console<small>{version}{consoleLatest ? ` · ${t("mobile.settings.latest")}` : ""}</small></span></div>
      <button type="button" className="mobile-group-row" onClick={() => openWhatsNew()}><span className="mobile-group-row-copy">{t("mobile.settings.whatsNewView")}</span></button>
      <button type="button" className="mobile-group-row" onClick={() => openSection("help")}><span className="mobile-group-row-copy">{t("mobile.settings.helpRow")}</span></button>
    </div>
  );
}

function RadioRow({ checked, label, sub, disabled, onSelect }: { readonly checked: boolean; readonly label: string; readonly sub?: string; readonly disabled?: boolean; readonly onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={`mobile-group-row${sub ? " is-two" : ""}${disabled ? " is-dim" : ""}`} disabled={disabled} onClick={onSelect}>
      <span className={`mobile-radio${checked ? " is-on" : ""}`} aria-hidden="true" />
      <span className="mobile-group-row-copy">{label}{sub ? <small>{sub}</small> : null}</span>
    </button>
  );
}

/**
 * 폰은 목록과 섹션을 두 화면으로 가르지만, 어떤 섹션이 있는지는 데스크톱과 같은 어휘로 읽는다 —
 * 두 레이아웃이 같은 주소를 공유하므로 한쪽만 아는 섹션이 생기면 그 링크가 다른 쪽에서 끊긴다.
 * 각 행은 열지 않고도 지금 무엇이 들어 있는지 말한다. 행의 대응은 spec-decisions D37.
 */
function buildMobileSettingsGroups({ state, appearance, viewMode, version, consoleLatest, pluginSections, t, locale }: {
  readonly state: GlobalSettingsState | null;
  readonly appearance: MobileAppearanceSnapshot;
  readonly viewMode: ViewModePreference;
  readonly version: string;
  readonly consoleLatest: boolean;
  readonly pluginSections: readonly PluginSettingsNavItem[];
  readonly t: (key: CoreMessageKey) => string;
  readonly locale: ConsoleLocale;
}): readonly MobileSettingsGroup[] {
  const byOrder = (a: PluginSettingsNavItem, b: PluginSettingsNavItem) => (a.mobile?.order ?? 0) - (b.mobile?.order ?? 0);
  const sectionRow = (section: PluginSettingsNavItem, icon: MobileIconName): MobileSettingsRow => ({
    id: section.id, title: section.sectionTitle, value: null, icon: <MobileIcon name={icon} />,
    ...(section.mobile?.summary ? { summarySection: section } : {}),
  });
  // 섹션이 자리를 말하지 않으면 데스크톱 묶음에서 파생한다: setup → 화면, work·machine → 에이전트, experiments는 실험 페이지 안의 카드.
  const placed = (section: PluginSettingsNavItem): MobileSettingsGroupId | null =>
    section.mobile?.group ?? (section.group === "setup" ? "display" : section.group === "experiments" ? null : "agent");
  const display: MobileSettingsRow[] = [
    { id: "color-mode", title: t("mobile.settings.colorMode"), value: t(`mobile.settings.color.${appearance.colorMode}`), icon: <MobileIcon name="moon" /> },
    { id: "font-scale", title: t("mobile.settings.fontScale"), value: t(`mobile.settings.font.${appearance.fontScale}`), icon: <MobileIcon name="text" /> },
    { id: "language", title: t("mobile.settings.language"), value: state === null ? null : languageLabel(state, t, locale), icon: <MobileIcon name="globe" /> },
    { id: "layout", title: t("mobile.settings.layout"), value: t(`mobile.settings.layout.${viewMode}`), icon: <MobileIcon name="layout" /> },
  ];
  // 플러그인이 선언한 group은 두 레이아웃에서 같은 뜻이어야 한다 — 하네스·터미널·AI Gateway 같은 작업 섹션이 「에이전트」, 고급이 그 끝이다.
  const agent: MobileSettingsRow[] = [];
  const use: MobileSettingsRow[] = [];
  const iconFor = (title: string): MobileIconName => {
    const lower = title.toLowerCase();
    return lower.includes("gateway") ? "gate" : lower.includes("terminal") || lower.includes("터미널") ? "term" : lower.includes("usage") || lower.includes("한도") || lower.includes("사용량") ? "chart" : "harness";
  };
  const AGENT_RANK = ["harness", "general", "agent-cli"];
  const rank = (section: PluginSettingsNavItem) => { const index = AGENT_RANK.findIndex((suffix) => section.id.endsWith(`:${suffix}`)); return index < 0 ? AGENT_RANK.length : index; };
  for (const section of [...pluginSections].sort((a, b) => byOrder(a, b) || rank(a) - rank(b))) {
    const where = placed(section);
    if (where === "display") display.push(sectionRow(section, iconFor(section.sectionTitle)));
    else if (where === "agent") agent.push(sectionRow(section, iconFor(section.sectionTitle)));
    else if (where === "use") use.push(sectionRow(section, iconFor(section.sectionTitle)));
  }
  agent.push({ id: "advanced", title: t("settings.core.advanced.label"), value: null, icon: <MobileIcon name="gate" /> });
  use.push(
    { id: "experiments", title: t("settings.core.experiments.label"), value: describeConnectivity(state, t), icon: <MobileIcon name="flask" /> },
  );
  const about: MobileSettingsRow[] = [
    { id: "about", title: t("mobile.settings.whatsNew"), value: version, icon: <MobileIcon name="spark" />, act: () => openWhatsNew() },
    { id: "help", title: t("mobile.settings.helpRow"), value: null, icon: <MobileIcon name="help" /> },
    { id: "about", title: t("mobile.settings.version"), value: `Console ${version}${consoleLatest ? ` · ${t("mobile.settings.latest")}` : ""}`, icon: <MobileIcon name="info" /> },
  ];
  return [{ key: "display", rows: display }, { key: "agent", rows: agent }, { key: "use", rows: use }, { key: "about", rows: about }];
}

function languageLabel(state: GlobalSettingsState, t: (key: CoreMessageKey) => string, locale: ConsoleLocale): string {
  // 자동이면 지금 풀린 언어를 괄호로 덧붙인다 — 「자동(한국어)」.
  if (state.language === "auto") return `${locale === "ko" ? "자동" : "Auto"}(${locale === "ko" ? t("settings.language.ko") : t("settings.language.en")})`;
  return state.language === "ko" ? t("settings.language.ko") : t("settings.language.en");
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

