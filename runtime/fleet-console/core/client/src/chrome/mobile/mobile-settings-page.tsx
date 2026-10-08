import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";

import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";
import { isFleetMobileShell } from "@fleet-console/link/core";
import { useLocation, useNavigate } from "react-router-dom";

import { loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
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
import { openConsoleSwitcher, setMobileColorMode, setMobileFontScale, useMobileAppearance, type MobileAppearanceSnapshot, type MobileColorMode, type MobileFontScale } from "../../integration/mobile-appearance-store.js";
import { openWhatsNew } from "../../integration/store.js";
import type { GlobalSettingsState } from "../../integration/types.js";
import { setViewModePreference, useViewMode, type ViewModePreference } from "../../integration/view-mode-store.js";
import { MobileIcon, type MobileIconName } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { openMobileChoice, type HostChoiceOption } from "./mobile-choice-store.js";
import { pushMobileSheet } from "./mobile-store.js";
import { clearMobileSubScreens, popMobileSubScreen, useMobileSubScreens } from "./mobile-subscreen-store.js";
import { pushOverlayHistory, releaseOverlayHistory } from "./mobile-overlay-history.js";
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
type LocalSectionId = "help";
const LOCAL_IDS: ReadonlySet<string> = new Set(["help"]);

/** 상세 화면이 없는 목록 행의 id(팝업·시트·토글·정보). */
type PopupRowId = "color-mode" | "font-scale" | "layout" | "whatsnew" | "version" | "reduce-motion";

interface MobileSettingsRow {
  readonly id: MobileSectionId | PopupRowId;
  readonly title: string;
  /** What this row currently holds, so the list answers without being opened. */
  readonly value: string | null;
  readonly icon: ReactNode;
  /** 상세 대신 시트·팝업·동작으로 가는 행(새 기능, 선택 팝업). `anchor`는 눌린 행의 세로 범위다. */
  readonly act?: (anchor: { readonly top: number; readonly bottom: number }) => void;
  /** 값이 플러그인 섹션에서 오는 행 — 그 섹션의 `mobile.summary`가 보조 줄을 그리고 `subscribe`로 갱신한다. */
  readonly summarySection?: PluginSettingsNavItem;
  /** 읽기 전용 값(P-2의 정보 행) — 누를 수 없고 누름 면이 없다. */
  readonly info?: true;
  /** 켬/끔 행(P-2) — 설명이 제목 아래 여러 줄로 선다. */
  readonly toggle?: { readonly checked: boolean; readonly busy: boolean; readonly disabled: boolean; readonly hint: string; readonly onChange: (next: boolean) => void };
}

type MobileSettingsGroupId = "display" | "agent" | "use" | "about";

interface MobileSettingsGroup {
  readonly key: string;
  readonly rows: readonly MobileSettingsRow[];
  /** 묶음 아래 한 줄 안내(secnote). */
  readonly note?: string;
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
  const groups = buildMobileSettingsGroups({ state, savingFields: settings.savingFields, appearance, viewMode: viewMode.preference, version: consoleState.version, consoleLatest: !consoleState.updateAvailable, pluginSections, t, locale });
  const rows = groups.flatMap((group) => group.rows);
  const requested = new URLSearchParams(location.search).get("section");
  // 폰 전용 상세는 그대로, 그 밖의 옛 id와 상대 레이아웃이 만든 id는 데스크톱과 같은 판정으로 옮긴다.
  const resolved = requested !== null && LOCAL_IDS.has(requested) ? requested : resolveSettingsSectionId(requested, new Set(rows.map((row) => row.id)));
  const active = resolved === null ? null : rows.find((row) => row.id === resolved && row.act === undefined) ?? null;

  const close = () => {
    // Popping is only correct when the entry above is this list. A direct load or a reload has no
    // such entry, and popping there would leave the Console entirely.
    if ((location.state as MobileSettingsLocationState | null)?.mobileSettingsEntry) { navigate(-1); return; }
    navigate({ pathname: "/settings", search: "" }, { replace: true });
  };

  // 막대는 호스트가 그린다 — 목록은 ≡ + ⓘ(버전), 섹션 상세는 ‹(목록에서 왔으면 history 되돌리기).
  const subScreens = useMobileSubScreens();
  const subScreen = subScreens.at(-1) ?? null;
  useClaimMobileBar(subScreen !== null
    ? { variant: "centered", title: subScreen.title, leading: "back", onBack: popMobileSubScreen }
    : active !== null
    ? { variant: "centered", title: active.title, leading: "back", onBack: close }
    : { variant: "centered", title: t("mobile.drawer.settings"), leading: "menu", actions: [{ id: "about", icon: <MobileIcon name="info" />, label: t("mobile.settings.about"), run: () => document.getElementById("mobile-settings-version")?.scrollIntoView({ block: "center", behavior: "smooth" }) }] });

  // 섹션 상세가 열려 있는 동안 하드웨어 뒤로는 그것을 닫는다(목록으로).
  const closeRef = useRef(close);
  closeRef.current = close;
  const detailOpen = active !== null;
  useEffect(() => (detailOpen ? pushBackLayer(() => closeRef.current()) : undefined), [detailOpen]);

  // 하위 화면은 한 단마다 뒤로 레지스트리 층과 history 항목 하나를 든다 — 하드웨어·브라우저 뒤로가 한 단씩 걷는다.
  const subDepth = subScreens.length;
  const subHistoryRef = useRef<number[]>([]);
  useEffect(() => {
    const ids = subHistoryRef.current;
    while (ids.length < subDepth) ids.push(pushOverlayHistory(() => { popMobileSubScreen(); }));
    while (ids.length > subDepth) releaseOverlayHistory(ids.pop()!);
  }, [subDepth]);
  useEffect(() => (subDepth > 0 ? pushBackLayer(() => popMobileSubScreen()) : undefined), [subDepth]);
  // 하위 화면은 섹션과 같은 스크롤 칸에 그려진다 — 들어가면 맨 위에서 시작하고, 나오면 들어가기 전 자리로 돌아간다.
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollRef = useRef<number[]>([]);
  const lastDepthRef = useRef(subDepth);
  useLayoutEffect(() => {
    const scroller = detailScrollRef.current;
    const saved = savedScrollRef.current;
    const previous = lastDepthRef.current;
    lastDepthRef.current = subDepth;
    if (scroller === null || previous === subDepth) return;
    if (subDepth > previous) { saved[previous] = scroller.scrollTop; scroller.scrollTop = 0; return; }
    scroller.scrollTop = saved[subDepth] ?? 0;
    saved.length = subDepth;
  }, [subDepth]);
  // 다른 섹션으로 가거나 목록으로 돌아가면 하위 화면은 모두 걷는다.
  const activeId = active?.id ?? null;
  useEffect(() => () => clearMobileSubScreens(), [activeId]);

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
        <div className="mobile-settings-scroll" ref={detailScrollRef}>
          <div className="mobile-settings-detail">
            {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
            {subScreen !== null
              ? subScreen.render()
              : LOCAL_IDS.has(active.id)
              ? <LocalDetail id={active.id as LocalSectionId} />
              : renderSettingsSection(active.id as SettingsSectionId, state, settings.savingFields, pluginSections, t)}
          </div>
        </div>
      </section>
    );
  }

  const connected = consoleState.connection === "live";
  const consoleName = appearance.console?.label ?? window.location.hostname;
  // 앱에서는 네이티브가 알려 준 주소만 보인다 — 웹뷰가 보는 루프백 주소는 사용자의 Console 주소가 아니다(NV-5).
  const consoleAddress = appearance.nativeOwned ? appearance.console?.address ?? null : window.location.host;
  return (
    <section className="mobile-settings-page" aria-labelledby="mobile-settings-title">
      <h1 id="mobile-settings-title" className="mobile-visually-hidden">{t("mobile.drawer.settings")}</h1>
      <div className="mobile-settings-scroll">
        <div className="mobile-settings-groups">
          {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
          <button type="button" className="mobile-console-card" onClick={() => { if (!openConsoleSwitcher()) pushMobileSheet({ kind: "console" }); }}>
            <MobileMonogram label={consoleName} toneKey={consoleName} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? consoleName.charAt(0).toUpperCase()} round size={36} />
            <span className="mobile-console-card-copy"><strong>{consoleName}</strong>{consoleAddress === null ? null : <small>{consoleAddress}</small>}</span>
            <span className="mobile-state-chip"><span className={statusGlyphClassName(connected ? "idle" : "running")} aria-hidden="true" />{t(connected ? "mobile.settings.connected" : "mobile.settings.reconnecting")}</span>
            <MobileIcon name="down" size={18} className="mobile-group-row-caret" />
          </button>
          {groups.map((group) => (
            <div className="mobile-settings-group" key={group.key}>
              <div className="mobile-group is-flush">
                {group.rows.map((row) => <SettingsListRow key={row.id} row={row} locale={locale} onOpen={(id) => open(id)} />)}
              </div>
              {group.note ? <p className="mobile-secnote is-tight">{group.note}</p> : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** 목록의 한 행 — 누르면 상세·팝업·동작으로 가는 행, 읽기 전용 값 행, 켬/끔 행(P-2). */
function SettingsListRow({ row, locale, onOpen }: { readonly row: MobileSettingsRow; readonly locale: ConsoleLocale; readonly onOpen: (id: MobileSectionId) => void }) {
  if (row.toggle) {
    return (
      <SettingsRow label={row.title} hint={row.toggle.hint} icon={row.icon} disabled={row.toggle.disabled}>
        <SettingsToggle checked={row.toggle.checked} onChange={row.toggle.onChange} ariaLabel={row.title} busy={row.toggle.busy} disabled={row.toggle.disabled} />
      </SettingsRow>
    );
  }
  const body = (
    <>
      <span className="mobile-group-row-icon" aria-hidden="true">{row.icon}</span>
      <span className="mobile-group-row-copy">{row.title}{row.summarySection ? <SectionSummary section={row.summarySection} locale={locale} /> : row.value === null ? null : <small>{row.value}</small>}</span>
    </>
  );
  const two = row.value === null && !row.summarySection ? "" : " is-two";
  if (row.info) return <div className={`mobile-group-row${two} is-info`} id={`mobile-settings-${row.id}`}>{body}</div>;
  return (
    <button type="button" className={`mobile-group-row${two}`} onClick={(event) => (row.act ? row.act(event.currentTarget.getBoundingClientRect()) : onOpen(row.id as MobileSectionId))}>
      {body}
    </button>
  );
}

/** 플러그인 섹션이 올린 요약 한 줄 — 구독 신호가 오면 다시 읽는다. 값이 없으면 줄 자체를 그리지 않는다. */
function SectionSummary({ section, locale }: { readonly section: PluginSettingsNavItem; readonly locale: ConsoleLocale }) {
  const mobile = section.mobile;
  const text = useSyncExternalStore(mobile?.subscribe ?? NO_SUBSCRIBE, () => mobile?.summary?.(locale) ?? null, () => null);
  return text === null ? null : <small>{text}</small>;
}
const NO_SUBSCRIBE = () => () => undefined;

/** 폰 전용 상세 — 읽을거리 목록(도움말). */
function LocalDetail({ id: _id }: { readonly id: LocalSectionId }) {
  const t = useT();
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

/**
 * 폰은 목록과 섹션을 두 화면으로 가르지만, 어떤 섹션이 있는지는 데스크톱과 같은 어휘로 읽는다 —
 * 두 레이아웃이 같은 주소를 공유하므로 한쪽만 아는 섹션이 생기면 그 링크가 다른 쪽에서 끊긴다.
 * 각 행은 열지 않고도 지금 무엇이 들어 있는지 말한다. 행의 대응은 spec-decisions D37.
 */
function buildMobileSettingsGroups({ state, savingFields, appearance, viewMode, version, consoleLatest, pluginSections, t, locale }: {
  readonly savingFields: ReadonlySet<string>;
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
  // 선택형 행은 하위 화면 없이 목록 위 팝업으로 고친다 — 보조 줄이 지금 값을 말한다.
  const choose = (title: string, value: string, options: readonly HostChoiceOption[], onSelect: (next: string) => void) =>
    (anchor: { readonly top: number; readonly bottom: number }) => openMobileChoice({ title, value, options, onSelect, anchor });
  const app = isFleetMobileShell();
  const display: MobileSettingsRow[] = [
    {
      id: "color-mode", title: t("mobile.settings.colorMode"), value: t(`mobile.settings.color.${appearance.colorMode}`), icon: <MobileIcon name="moon" />,
      act: choose(t("mobile.settings.colorMode"), appearance.colorMode, [
        { value: "system", label: t("mobile.settings.color.system"), icon: <MobileIcon name="monitor" /> },
        { value: "light", label: t("mobile.settings.color.light"), icon: <MobileIcon name="sun" /> },
        { value: "dark", label: t("mobile.settings.color.dark"), icon: <MobileIcon name="moon" /> },
      ], (next) => setMobileColorMode(next as MobileColorMode)),
    },
    {
      id: "font-scale", title: t("mobile.settings.fontScale"), value: t(`mobile.settings.font.${appearance.fontScale}`), icon: <MobileIcon name="text" />,
      act: choose(t("mobile.settings.fontScale"), appearance.fontScale, (["small", "default", "large"] as const).map((scale) => ({ value: scale, label: t(`mobile.settings.font.${scale}`), previewSize: scale === "small" ? 15 : scale === "large" ? 19.5 : 17 })), (next) => setMobileFontScale(next as MobileFontScale)),
    },
    {
      id: "language", title: t("mobile.settings.language"), value: state === null ? null : languageLabel(state, t, locale), icon: <MobileIcon name="globe" />,
      act: state === null ? () => undefined : choose(t("mobile.settings.language"), state.language, [
        { value: "auto", label: t("mobile.settings.language.auto"), description: `${t("mobile.settings.language.autoSub")} · ${locale === "ko" ? t("settings.language.ko") : t("settings.language.en")}` },
        { value: "en", label: t("settings.language.en") },
        { value: "ko", label: t("settings.language.ko") },
      ], (next) => { void setGlobalSettingsField("language", next as GlobalSettingsState["language"]); }),
    },
    {
      // Fleet 앱에서는 데스크톱 배치를 고를 수 없다(D38) — 브라우저에서는 활성이고 여기서 늘 돌아올 수 있다.
      id: "layout", title: t("mobile.settings.layout"), value: t(`mobile.settings.layout.${viewMode}`), icon: <MobileIcon name="layout" />,
      act: choose(t("mobile.settings.layout"), viewMode, [
        { value: "auto", label: t("mobile.settings.layout.auto"), description: t("mobile.settings.layout.autoSub") },
        { value: "mobile", label: t("mobile.settings.layout.mobile"), description: t("mobile.settings.layout.mobileSub") },
        { value: "desktop", label: t("mobile.settings.layout.desktop"), ...(app ? { description: t("mobile.settings.layout.desktopApp"), disabled: true } : {}) },
      ], (next) => setViewModePreference(next as ViewModePreference)),
    },
  ];
  // 플러그인이 선언한 group은 두 레이아웃에서 같은 뜻이어야 한다 — 터미널·AI Gateway 같은 작업 섹션이 「에이전트」, 고급이 그 끝이다.
  const agent: MobileSettingsRow[] = [];
  const use: MobileSettingsRow[] = [];
  const iconFor = (title: string): MobileIconName => {
    const lower = title.toLowerCase();
    return lower.includes("gateway") ? "gate" : lower.includes("terminal") || lower.includes("터미널") ? "term" : lower.includes("usage") || lower.includes("한도") || lower.includes("사용량") ? "chart" : "harness";
  };
  const AGENT_RANK = ["general", "agent-cli"];
  const rank = (section: PluginSettingsNavItem) => { const index = AGENT_RANK.findIndex((suffix) => section.id.endsWith(`:${suffix}`)); return index < 0 ? AGENT_RANK.length : index; };
  for (const section of [...pluginSections].sort((a, b) => byOrder(a, b) || rank(a) - rank(b))) {
    const where = placed(section);
    if (where === "display") display.push(sectionRow(section, iconFor(section.sectionTitle)));
    else if (where === "agent") agent.push(sectionRow(section, iconFor(section.sectionTitle)));
    else if (where === "use") use.push(sectionRow(section, iconFor(section.sectionTitle)));
  }
  // 「움직임 줄이기」는 겉모습 섹션을 숨겨도 폰에서 뜻이 있다 — 화면 묶음 끝의 토글 행(D42).
  display.push({
    id: "reduce-motion", title: t("settings.motion.reduce" as CoreMessageKey), value: null, icon: <MobileIcon name="spark" />,
    toggle: { checked: state?.reduceMotion === true, busy: savingFields.has("reduceMotion"), disabled: state === null, hint: t("settings.motion.reduceHelp" as CoreMessageKey), onChange: (next) => { void setGlobalSettingsField("reduceMotion", next); } },
  });
  agent.push({ id: "advanced", title: t("settings.core.advanced.label"), value: null, icon: <MobileIcon name="gate" /> });
  use.push(
    { id: "experiments", title: t("settings.core.experiments.label"), value: describeExperiments(state, t), icon: <MobileIcon name="flask" /> },
  );
  const appVersion = appearance.appVersion;
  const about: MobileSettingsRow[] = [
    { id: "whatsnew", title: t("mobile.settings.whatsNew"), value: version, icon: <MobileIcon name="spark" />, act: () => openWhatsNew() },
    { id: "help", title: t("mobile.settings.helpRow"), value: null, icon: <MobileIcon name="help" /> },
    { id: "version", title: t("mobile.settings.version"), value: `Console ${version}${consoleLatest ? ` · ${t("mobile.settings.latest")}` : ""}${appVersion ? ` · ${t("mobile.settings.appVersion")} ${appVersion}` : ""}`, icon: <MobileIcon name="info" />, info: true },
  ];
  return [{ key: "display", rows: display, note: t("mobile.settings.color.note") }, { key: "agent", rows: agent }, { key: "use", rows: use }, { key: "about", rows: about }];
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
/**
 * 「실험 기능」 행의 보조 줄 — 켜진 실험 기능의 개수(시안 S-47: 「{n}개 켜짐」, 하나도 없으면 「꺼짐」).
 * 세는 것은 이 페이지의 켬/끔 기능(자율 운영 · 컴퓨터 사용)이다. 포트·원격 접속은 같은 페이지에 있어도 실험 기능 개수가 아니다.
 */
function describeExperiments(state: GlobalSettingsState | null, t: (key: CoreMessageKey, params?: Record<string, string | number>) => string): string | null {
  if (state === null) return null;
  const on = [state.experiments.commodore, state.experiments.computerUse].filter(Boolean).length;
  return on === 0 ? t("mobile.settings.off") : t("mobile.settings.experimentsOn", { count: on });
}

