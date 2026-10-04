import { FontMenu } from "./font-menu.js";
import { fontCjkScripts } from "../../execution/client/terminal/shared/cjk-coverage.js";
import { DEFAULT_FONTS, FONT_BUILT_INS, FONT_SIZE_RANGES, fontFamilyForAxis, type FontAxis, type FontAxisSettings, type ConsoleFontSettings } from "@fleet-console/sdk/settings/fonts";
import { type FontPickerInstalledFont, type FontPickerLabels } from "@fleet-console/font-picker/browser";
import { correctHostMonospace } from "@fleet-console/font-picker/local-fonts";
import { fontResolves } from "@fleet-console/font-picker/resolve";
import "@fleet-console/font-picker/styles.css";
import { SystemFontsFetchError, fetchSystemFonts } from "@fleet-console/font-picker/system-fonts";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { PluginErrorBoundary, SegmentedThumb } from "@fleet-console/sdk/react/browser";
import type { SettingsSectionDescriptor, SettingsSectionGroup } from "@fleet-console/sdk/settings";
import { SettingsSlider, SettingsToggle } from "@fleet-console/sdk/settings/browser";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RemoteAccessSection } from "../../remote-access/client/settings-section.js";
export { RemoteAccessSection } from "../../remote-access/client/settings-section.js";

import { BackendApiSection } from "../../../core/client/src/chrome/components/backend-api-section.js";
import { desktopAsksForLocalFonts, isDesktopShell, useDesktopShellHome } from "../../../core/client/src/integration/desktop-shell.js";
import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { renderMessage, useT, type CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import { setActiveTheme, setUnfocusedPanelFade } from "../../../core/client/src/integration/store.js";
import { type GlobalSettingsState, type ThemeId } from "../../../core/client/src/integration/types.js";
import { loadDeviceFonts, requestDesktopDeviceFonts, useDeviceFonts, useDeviceFontsPermission } from "./device-fonts.js";
import { ExperimentsSection } from "./experiments-section.js";
import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, type GlobalSettingsField } from "./global-settings-store.js";
import { ShortcutsCard } from "./shortcuts-section.js";

interface LanguageOption {
  readonly id: GlobalSettingsState["language"];
  readonly label: string;
}

interface ThemeOption {
  readonly id: ThemeId;
  readonly label: string;
  readonly polarity: string;
  readonly swatch: readonly [string, string, string];
}

interface PortModeOption {
  readonly id: GlobalSettingsState["consolePortMode"];
  readonly label: string;
}

export type CoreSettingsSectionId = "appearance" | "language" | "shortcuts" | "connectivity" | "advanced" | "experiments";
type PluginSettingsSectionId = `${string}:${string}`;
export type SettingsSectionId = CoreSettingsSectionId | PluginSettingsSectionId;

/**
 * 옛 주소는 계속 열려야 한다. 섹션을 일 기준으로 다시 묶으면서 id가 움직였고, 사람들의
 * 북마크와 이전 릴리스가 만든 링크는 옛 id를 그대로 들고 온다 — 여기서 새 자리로 넘긴다.
 */
const LEGACY_SECTION_IDS: Readonly<Record<string, CoreSettingsSectionId>> = {
  general: "appearance",
  console: "language",
  "remote-access": "connectivity",
  "backend-api": "advanced",
};

/**
 * 주소에 적힌 섹션을 이 빌드가 아는 섹션으로 옮긴다. 데스크톱과 폰이 같은 `/settings` 주소를
 * 공유하므로 판정도 하나여야 한다 — 한쪽만 아는 id가 생기면 데스크톱이 만든 링크가 폰에서
 * 쿼리째 지워지고, 창을 좁히는 것만으로 열려 있던 섹션이 사라진다.
 *
 * 닿지 못한 id는 `null`로 돌려준다. 무엇으로 대신할지는 레이아웃마다 다르기 때문이다 —
 * 데스크톱은 목록 옆에 언제나 섹션 하나가 서 있어야 하고, 폰에는 돌아갈 목록 화면이 따로 있다.
 * 여기서 한쪽 기본값을 심으면 사라진 플러그인을 가리키던 오래된 링크가 폰에서 목록 대신
 * 엉뚱한 설정을 연다.
 */
export function resolveSettingsSectionId(requested: string | null, available: ReadonlySet<string>): SettingsSectionId | null {
  const migrated = requested !== null && requested in LEGACY_SECTION_IDS ? LEGACY_SECTION_IDS[requested] : requested;
  if (migrated === null || migrated === undefined) return null;
  return available.has(migrated) ? migrated as SettingsSectionId : null;
}

export interface SettingsSectionNavItem {
  readonly id: CoreSettingsSectionId;
  readonly group: SettingsSectionGroup;
  readonly label: string;
  /** 검색이 이 섹션에 닿는 말. 제목에 없는 이름으로도 찾을 수 있어야 한다. */
  readonly entries: readonly string[];
  /** 칩 옆 '?'가 여는 설명. 카드 본문에는 되풀이하지 않는다. */
  readonly help?: string;
  /**
   * 자기 칩 없이 다른 섹션의 페이지 안에 카드로 서는 섹션. id는 주소·확대 표면·팔레트 링크를 위해
   * 살아 있되, 칩 줄에는 나타나지 않고 검색은 품는 섹션으로 데려간다.
   */
  readonly embeddedIn?: CoreSettingsSectionId;
}

export interface PluginSettingsNavItem {
  readonly id: PluginSettingsSectionId;
  readonly group: SettingsSectionGroup;
  readonly pluginId: string | null;
  readonly pluginLabel: string;
  readonly sectionTitle: string;
  readonly entries: readonly string[];
  readonly render?: () => ReactNode;
}

export const SETTINGS_GROUP_ORDER: readonly SettingsSectionGroup[] = ["setup", "work", "machine", "experiments"];

export const SETTINGS_GROUP_LABEL_KEYS: Readonly<Record<SettingsSectionGroup, CoreMessageKey>> = {
  setup: "settings.group.setup",
  work: "settings.group.work",
  machine: "settings.group.machine",
  experiments: "settings.group.experiments",
};

type T = Translate<CoreMessageKey>;

// 테마 카드의 3톤 스와치는 각 테마의 ground/brass/aurora 시그니처를 미리 보여 준다(콘텐츠 색이라
// 역할색 규칙과 무관). 라이트도 같은 카드 문법을 쓴다 — 모드 버튼 뒤에 다크 셋을 숨겨 두면
// 라이트를 쓰는 사람은 무엇이 있는지 보려고 콘솔 전체를 한 번 뒤집어야 했다.
function buildThemeOptions(t: T): readonly ThemeOption[] {
  return [
    { id: "instrument", label: t("settings.theme.instrument"), polarity: t("settings.theme.group.dark"), swatch: ["oklch(16.5% 0.016 245)", "oklch(80% 0.085 78)", "oklch(77% 0.085 200)"] },
    { id: "maritime", label: t("settings.theme.maritime"), polarity: t("settings.theme.group.dark"), swatch: ["oklch(20% 0.045 248)", "oklch(78% 0.13 75)", "oklch(82% 0.13 195)"] },
    { id: "carbon", label: t("settings.theme.carbon"), polarity: t("settings.theme.group.dark"), swatch: ["oklch(18% 0.007 255)", "oklch(76% 0.115 62)", "oklch(80% 0.105 205)"] },
    { id: "whites", label: t("settings.theme.whites"), polarity: t("settings.theme.group.light"), swatch: ["oklch(95.5% 0.005 100)", "oklch(56% 0.125 82)", "oklch(50% 0.1 210)"] },
  ];
}

function buildPortModes(t: T): readonly PortModeOption[] {
  return [
    { id: "dynamic", label: t("settings.port.dynamic") },
    { id: "static", label: t("settings.port.static") },
  ];
}

function buildLanguages(t: T): readonly LanguageOption[] {
  return [
    { id: "auto", label: t("settings.language.auto") },
    { id: "en", label: t("settings.language.en") },
    { id: "ko", label: t("settings.language.ko") },
  ];
}

/**
 * 원격 접속에는 remoteAccess가 실리지 않는다. 그 부재를 그대로 읽어 섹션을 세우지 않는다 —
 * 비활성 항목으로 남겨 두면 손님이 열어 보고 빈 카드를 만나고, 그 카드가 다루는 값은
 * 애초에 이 자리에서 볼 것이 아니다. 원격이 없으면 Connectivity는 콘솔 포트만 담는다.
 */
export function buildCoreSettingsSections(t: T, state: GlobalSettingsState | null): readonly SettingsSectionNavItem[] {
  const remoteAvailable = state === null || state.remoteAccess !== undefined;
  return [
    {
      id: "appearance",
      group: "setup",
      label: t("settings.core.appearance.label"),
      // 도구 패널 불투명도는 데스크톱 페인이 테마 카드에 덧세우는 행이다 — 검색은 그
      // 행 이름으로도 닿아야 한다. 모바일은 이 entries를 읽지 않으므로 여기 실어도 무해하다.
      entries: [t("settings.theme.title"), t("settings.theme.label"), t("settings.theme.panelFade"), t("settings.fonts.title"), t("settings.fonts.ui"), t("settings.fonts.content"), t("settings.fonts.code"), t("settings.fonts.advanced"), t("settings.theme.glassTitle"), t("settings.theme.windowOpacity"), t("settings.theme.barOpacity"), t("settings.theme.sideBarOpacity"), t("settings.theme.railOpacity"), t("settings.motion.reduce"), t("settings.motion.unfocused"), t("settings.core.appearance.keywords")],
    },
    {
      id: "language",
      group: "setup",
      // 표시 언어는 자기 칩을 갖지 않고 겉모습 페이지의 첫 카드로 선다 — 언어도 콘솔이 어떻게
      // 보이는가의 일부이고, 한 행짜리 칩은 목록만 길게 했다. 검색과 옛 주소는 겉모습으로 착지한다.
      embeddedIn: "appearance",
      label: t("settings.core.language.label"),
      entries: [t("settings.language.title"), t("settings.language.label"), t("settings.core.language.keywords")],
    },
    {
      id: "shortcuts",
      group: "setup",
      label: t("settings.core.shortcuts.label"),
      help: t("settings.shortcuts.help"),
      entries: [t("settings.shortcuts.title"), t("settings.shortcuts.groupCompanion"), t("settings.core.shortcuts.keywords")],
    },
    {
      id: "connectivity",
      group: "experiments",
      embeddedIn: "experiments",
      label: t("settings.core.connectivity.label"),
      entries: [
        t("settings.port.title"),
        t("settings.port.label"),
        ...(remoteAvailable ? [t("settings.remote.title"), t("settings.core.connectivity.remoteKeywords")] : []),
        t("settings.core.connectivity.keywords"),
      ],
    },
    {
      id: "advanced",
      group: "machine",
      label: t("settings.core.advanced.label"),
      entries: [t("settings.core.backendApi.label"), t("settings.core.advanced.keywords")],
    },
    {
      id: "experiments",
      group: "experiments",
      label: t("settings.core.experiments.label"),
      help: t("settings.experiments.intro"),
      entries: [
        t("settings.experiments.aiCard"),
        t("settings.computerUse.title"),
        "Computer Use",
        t("settings.core.experiments.keywords"),
      ],
    },
  ];
}

const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;

/**
 * 비포커스 패널 흐리기 세기의 구간과 기본값. 브라우저 코드는 호스트를 import하지 않으므로
 * 정적 포트 상·하한과 같은 관례로 여기에 적는다 — 서버는 settings-domain에서 같은 수로
 * 검증한다. 상한이 70인 이유는 CSS 쪽 주석에 있다: 그 아래로 내려가면 곁을 훑는 일까지 끊긴다.
 */
const UNFOCUSED_PANEL_FADE_MIN = 0;
const UNFOCUSED_PANEL_FADE_MAX = 70;
const UNFOCUSED_PANEL_FADE_DEFAULT = 50;

// 플러그인 render()를 경계 자손의 렌더 단계에서 호출해야 동기 throw가 PluginErrorBoundary에 잡힌다.
export function PluginSettingsSectionBody({ render }: { readonly render: () => ReactNode }) {
  return <>{render()}</>;
}

export function renderSettingsSection(sectionId: SettingsSectionId, state: GlobalSettingsState | null, saving: ReadonlySet<GlobalSettingsField>, pluginSections: readonly PluginSettingsNavItem[], t: T, options?: {
  /** 데스크톱 페인이 테마 카드에 덧세우는 행(도구 패널 불투명도) — 도구 패널 없는 모바일은 넘기지 않는다. */
  readonly themeCardExtras?: ReactNode;
}) {
  if (sectionId.includes(":")) {
    const pluginSection = pluginSections.find((section) => section.id === sectionId);
    return pluginSection?.render ? (
      <PluginErrorBoundary fallback={<div className="fc-plugin-error">{t("settings.pluginFailed")}</div>}>
        <PluginSettingsSectionBody render={pluginSection.render} />
      </PluginErrorBoundary>
    ) : <p className="global-settings-help">{t("settings.pluginUnavailable")}</p>;
  }
  switch (sectionId) {
    case "appearance":
      return (
        <>
          {state === null ? null : <LanguageCard state={state} saving={saving.has("language")} />}
          <ThemeCard state={state} saving={saving} />
          {options?.themeCardExtras}
          <TypographyCard state={state} saving={saving.has("fonts")} />
        </>
      );
    // 언어는 겉모습에 품겨 있다 — 주소로 직접 들어온 옛 링크만 이 가지를 탄다.
    case "language":
      if (state === null) return <p className="global-settings-help">{t("settings.general.loading")}</p>;
      return <LanguageCard state={state} saving={saving.has("language")} />;
    case "connectivity":
      if (state === null) return <p className="global-settings-help">{t("settings.general.loading")}</p>;
      return (
        <>
          <ConsolePortCard state={state} saving={saving.has("consolePortMode") || saving.has("consoleStaticPort")} />
          {/* 목록에서 뺀 것과 별개로 경로도 막는다 — 주소로 직접 들어오는 길이 남으면 숨긴 것이 아니다. */}
          {state.remoteAccess === undefined ? null : <RemoteAccessSection remote={state.remoteAccess} saving={saving.has("remoteAccess")} />}
        </>
      );
    case "shortcuts":
      return <ShortcutsCard state={state} saving={saving.has("shortcuts")} />;
    case "advanced":
      return <BackendApiSection />;
    case "experiments":
      if (state === null) return <p className="global-settings-help">{t("settings.general.loading")}</p>;
      return (
        <>
          <ExperimentsSection state={state} saving={saving.has("experiments")} />
          {renderEmbeddedPluginSections(pluginSections, t)}
          <ConsolePortCard state={state} saving={saving.has("consolePortMode") || saving.has("consoleStaticPort")} />
          {state.remoteAccess === undefined ? null : <RemoteAccessSection remote={state.remoteAccess} saving={saving.has("remoteAccess")} />}
        </>
      );
  }
}

/**
 * 실험 그룹의 플러그인 섹션은 자기 칩이 없고 여기 카드로 선다. 각 섹션은 자기 경계 안에서 렌더된다 —
 * 한 플러그인 카드의 실패가 코어 카드까지 지우지 않는다.
 */
export function renderEmbeddedPluginSections(pluginSections: readonly PluginSettingsNavItem[], t: T): ReactNode {
  return pluginSections
    .filter((section) => section.group === "experiments")
    .map((section) => (
      <PluginErrorBoundary key={section.id} fallback={<div className="fc-plugin-error">{t("settings.pluginFailed")}</div>}>
        {section.render ? <PluginSettingsSectionBody render={section.render} /> : <p className="global-settings-help">{t("settings.pluginUnavailable")}</p>}
      </PluginErrorBoundary>
    ));
}

export function collectPluginSettingsSections(
  plugins: readonly { readonly id: string | null; readonly settingsSections?: readonly SettingsSectionDescriptor[] }[],
  locale: ConsoleLocale,
  t: T,
): readonly PluginSettingsNavItem[] {
  return plugins.flatMap((plugin) =>
    (plugin.settingsSections ?? []).map((section) => ({
      id: `${plugin.id ?? "terminal"}:${section.id}` as const,
      // 플러그인 설정은 대부분 작업 도구의 동작이다. 다른 자리가 필요하면 섹션이 직접 말한다.
      group: section.group ?? "work" as const,
      pluginId: plugin.id,
      pluginLabel: formatPluginLabel(plugin.id, t),
      sectionTitle: resolveLocalizedText(section.title, locale),
      entries: (section.keywords ?? []).map((keyword) => resolveLocalizedText(keyword, locale)),
      render: section.render,
    })),
  );
}

function formatPluginLabel(pluginId: string | null, t: T): string {
  if (pluginId === null || pluginId === "terminal") return t("settings.plugin.terminal");
  return pluginId.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || pluginId;
}

export function ThemeCard({
  state,
  saving,
  extras,
}: {
  readonly state: GlobalSettingsState | null;
  readonly saving: ReadonlySet<GlobalSettingsField>;
  /** 비포커스 패널 흐리기 아래에 서는 추가 행 — 데스크톱 전용 크롬 재질 취향(좌·우 사이드바)이 들어온다. */
  readonly extras?: ReactNode;
}) {
  const t = useT();
  const themes = buildThemeOptions(t);
  const activeTheme = state?.theme ?? "instrument";
  const selectTheme = (theme: ThemeId) => {
    if (isSavingGlobalSettingsField("theme")) return;
    const previousTheme = activeTheme;
    setActiveTheme(theme);
    void setGlobalSettingsField("theme", theme).then((saved) => {
      if (!saved) setActiveTheme(previousTheme);
    });
  };
  const savedPanelFade = state?.unfocusedPanelFade ?? UNFOCUSED_PANEL_FADE_DEFAULT;
  // 끄는 동안의 값은 화면이 들고, 서버 값은 손을 뗄 때 따라온다. 저장 왕복마다 손잡이가
  // 서버 값으로 되튀면 연속 조작이 끊긴다.
  const [draftPanelFade, setDraftPanelFade] = useState<number | null>(null);
  const panelFade = draftPanelFade ?? savedPanelFade;
  const previewPanelFade = (next: number) => {
    setDraftPanelFade(next);
    setUnfocusedPanelFade(next);
  };
  // 슬라이더는 저장 중에도 켜 둔다 — 끄면 키보드 포커스가 빠져 방향키 한 번마다 Tab으로 다시 들어가야
  // 한다. 전역 설정 스토어는 같은 필드의 겹친 저장을 거절(false)하므로, 도는 저장이 있으면 마지막 값만
  // 맡겨 두었다가 그 저장이 끝나는 대로 이어 보낸다. 마지막 값이 이긴다.
  const pendingPanelFadeRef = useRef<number | null>(null);
  const savePanelFade = (next: number) => {
    if (isSavingGlobalSettingsField("unfocusedPanelFade")) {
      pendingPanelFadeRef.current = next;
      return;
    }
    void setGlobalSettingsField("unfocusedPanelFade", next).then((saved) => {
      const pending = pendingPanelFadeRef.current;
      pendingPanelFadeRef.current = null;
      if (pending !== null && pending !== next) {
        savePanelFade(pending);
        return;
      }
      setDraftPanelFade(null);
      // 실패하면 스토어가 이 필드를 직전 값으로 되감는다 — 화면도 그 값으로 맞춘다.
      if (!saved) setUnfocusedPanelFade(getGlobalSettingsStoreState().state?.unfocusedPanelFade ?? UNFOCUSED_PANEL_FADE_DEFAULT);
    });
  };
  const commitPanelFade = (next: number) => {
    if (next === savedPanelFade && !isSavingGlobalSettingsField("unfocusedPanelFade")) {
      setDraftPanelFade(null);
      return;
    }
    savePanelFade(next);
  };
  return (
    <section className="global-settings-card appearance-card" aria-label={t("settings.theme.aria")}>
      {/* CLI 테마 각주는 카드 전체의 이야기라 카드 제목 팁이 진다 — 행 팁은 자기 줄만 말한다. */}
      <h3 className="global-settings-card-title">
        {t("settings.theme.title")}
        <SettingsHelp title={t("settings.theme.title")}>{t("settings.theme.cliNote")}</SettingsHelp>
      </h3>
      <div className="appearance-controls">
          <div className="global-settings-row is-stack">
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t("settings.theme.label")}
                <SettingsHelp title={t("settings.theme.label")}>{t("settings.theme.help")}</SettingsHelp>
              </p>
            </div>
            {/* 라이트와 다크가 같은 카드 문법을 쓴다. 모드 버튼 뒤에 다크 셋을 감추면 라이트를
                쓰는 사람은 무엇이 있는지 보려고 콘솔 전체를 한 번 뒤집어야 한다. */}
            <div className="theme-grid" role="group" aria-label={t("settings.theme.aria")}>
              {themes.map((theme) => {
                const isActive = theme.id === activeTheme;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    aria-pressed={isActive}
                    className={`theme-card ${isActive ? "is-active" : ""}`}
                    disabled={saving.has("theme") || state === null}
                    onClick={() => selectTheme(theme.id)}
                  >
                    <span className="theme-card-swatch" aria-hidden="true">
                      {theme.swatch.map((color) => <i key={color} style={{ background: color }} />)}
                    </span>
                    <span className="theme-card-name">
                      <span className="theme-card-label">{theme.label}</span>
                      <span className="theme-card-check" aria-hidden="true">{isActive ? <CheckIcon /> : null}</span>
                    </span>
                    <span className="theme-card-polarity">{theme.polarity}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="global-settings-row">
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t("settings.theme.panelFade")}
                <SettingsHelp title={t("settings.theme.panelFade")}>{t("settings.theme.panelFadeHelp")}</SettingsHelp>
              </p>
            </div>
            {/* 값은 끌리는 동안 화면에 즉시 적용된다 — 세기는 숫자가 아니라 화면으로 고르는
                것이라, 손을 뗀 뒤에야 보이면 고를 수가 없다. 저장은 손을 뗄 때 한 번만 나간다.
                연속값은 SDK 슬라이더 한 문법이다(트랙·값·기본값 버튼) — 백분율 표기는 두 로케일에서
                같은 문자열이라 메시지 키 없이 여기서 조립한다. */}
            <SettingsSlider
              value={panelFade}
              min={UNFOCUSED_PANEL_FADE_MIN}
              max={UNFOCUSED_PANEL_FADE_MAX}
              step={5}
              disabled={state === null}
              label={t("settings.theme.panelFade")}
              formatValue={(value) => `${value}%`}
              onPreview={previewPanelFade}
              onCommit={commitPanelFade}
              defaultValue={UNFOCUSED_PANEL_FADE_DEFAULT}
              resetLabel={t("settings.slider.reset")}
              resetAriaLabel={t("settings.slider.resetAria", { title: t("settings.theme.panelFade") })}
            />
          </div>

          {/* 재가된 배치: 도구 패널 불투명도는 비포커스 패널 흐리기 바로 아래에 서고, 좌측
              사이드바 손잡이 둘이 그 아래에 붙는다. 행 자체는 데스크톱 페인이 주입한다 — 사이드바도
              레일도 없는 모바일에 죽은 슬라이더를 세우지 않기 위해. */}
          {extras}

          <div className="global-settings-row">
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t("settings.motion.reduce")}
                <SettingsHelp title={t("settings.motion.reduce")}>{t("settings.motion.reduceHelp")}</SettingsHelp>
              </p>
            </div>
            <SettingsToggle checked={state?.reduceMotion === true} disabled={state === null} busy={saving.has("reduceMotion")} ariaLabel={t("settings.motion.reduce")} onChange={(value) => { void setGlobalSettingsField("reduceMotion", value); }} />
          </div>
          <div className="global-settings-row">
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t("settings.motion.unfocused")}
                <SettingsHelp title={t("settings.motion.unfocused")}>{t("settings.motion.unfocusedHelp")}</SettingsHelp>
              </p>
            </div>
            <SettingsToggle checked={state?.lowerUnfocusedFrameRate !== false} disabled={state === null} busy={saving.has("lowerUnfocusedFrameRate")} ariaLabel={t("settings.motion.unfocused")} onChange={(value) => { void setGlobalSettingsField("lowerUnfocusedFrameRate", value); }} />
          </div>
      </div>
    </section>
  );
}


export function TypographyCard({ state, saving }: { readonly state: GlobalSettingsState | null; readonly saving: boolean }) {
  const t = useT();
  const fonts = state?.fonts ?? DEFAULT_FONTS;
  const [installedFonts, setInstalledFonts] = useState<readonly (FontPickerInstalledFont & { readonly uiSuitable: boolean })[]>([]);
  const [fontsLoading, setFontsLoading] = useState(true);
  const [fontsError, setFontsError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const card = useRef<HTMLElement>(null);
  const [cjkFonts, setCjkFonts] = useState<readonly FontPickerInstalledFont[]>([]);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchSystemFonts({ signal: controller.signal }).then((response) => {
      if (controller.signal.aborted) return;
      setInstalledFonts(response.fonts);
      setFontsError(null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFontsError(error instanceof SystemFontsFetchError ? t("settings.typography.fontsLoadError") : String(error));
    }).finally(() => { if (!controller.signal.aborted) setFontsLoading(false); });
    return () => controller.abort();
  }, [t]);
  const deviceFonts = useDeviceFonts();
  const devicePermission = useDeviceFontsPermission();
  const shellHome = useDesktopShellHome();
  const deviceLoaded = deviceFonts.status === "loaded";
  // 이미 허용된 기기라면 묻지 않고 불러온다 — 허용된 상태의 열거에는 사용자 제스처가 필요 없다. Desktop이 이 기기의
  // Console에 미리 허용한 경우, 원격 Console을 이 실행에서 허용한 경우, 브라우저 사이트가 허용된 경우가 여기에 든다.
  // 'prompt'에서는 버튼을 기다린다. 목록은 여전히 이 화면의 메모리에만 머문다.
  useEffect(() => {
    // 거부로 판정했던 상태(브라우저 거부, Desktop 거부)에서도 허용이 확인되면 되살린다. 'failed'는 제외한다 —
    // 허용된 채 실패한 열거를 되풀이하지 않기 위해서다(버튼으로 다시 시도한다).
    if (devicePermission === "granted" && (deviceFonts.status === "idle" || deviceFonts.status === "denied" || deviceFonts.status === "desktopDenied")) void loadDeviceFonts();
  }, [devicePermission, deviceFonts.status]);
  // 이 기기의 목록을 받았으면 그것이 진실이다. 호스트에만 있는 family는 "이 기기에 없음"으로 내린다.
  // Windows 호스트 목록은 등폭 여부가 비어 온다 — 이 화면이 그릴 수 있는 것은 여기서 재서 고친다.
  const hostFonts = useMemo(() => correctHostMonospace(installedFonts, (family) => fontResolves(family)), [installedFonts]);
  const pickerFonts = useMemo(() => {
    if (deviceFonts.status !== "loaded") return hostFonts;
    const deviceKeys = new Set(deviceFonts.fonts.map((font) => font.family.toLocaleLowerCase()));
    return [
      ...deviceFonts.fonts.map((font) => ({ ...font, available: true })),
      // 호스트에만 있는 이름이 이 기기에 없다는 뜻은 아니다 — Windows 호스트는 GDI 이름("Segoe UI Semibold")을,
      // 렌더러 목록은 DirectWrite family("Segoe UI")를 준다. 그래서 단정하지 않고 폭 탐침에 맡긴다.
      ...hostFonts.filter((font) => !deviceKeys.has(font.family.toLocaleLowerCase())),
    ];
  }, [deviceFonts, hostFonts]);
  useEffect(() => {
    if (!advanced) return;
    let cancelled = false;
    setScanning(true);
    void (async () => {
      const candidates: FontPickerInstalledFont[] = [];
      const scanned = pickerFonts.filter((font) => font.available !== false);
      for (let index = 0; index < scanned.length; index += 24) {
        if (cancelled) return;
        for (const font of scanned.slice(index, index + 24)) {
          if ((await fontCjkScripts(font.family)).length) candidates.push({ ...font, available: true });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!cancelled) { setCjkFonts(candidates); setScanning(false); }
    })();
    return () => { cancelled = true; };
  }, [advanced, pickerFonts]);
  // 목록은 Console 호스트의 것이고 판정은 이 화면의 것이다. 둘이 다른 기기임을 아는 쪽은 렌더러뿐이라,
  // 그 축에 보이는 호스트 서체 대부분을 여기서 그릴 수 없을 때만 알린다. 폭 탐침은 라틴으로 묻기 때문에
  // 같은 기기라도 라틴이 없는 서체는 없는 것으로 읽힌다 — 그래서 원인(WSL·원격·라틴 없음)은 단정하지 않는다.
  const hostMismatch = (axisFonts: readonly FontPickerInstalledFont[]): boolean => axisFonts.length > 0 && axisFonts.filter((font) => !fontResolves(font.family)).length * 2 >= axisFonts.length;
  // 저장된 서체가 축 목록에서 빠져도(예: 등폭 서체를 UI 축에 저장) 이 기기의 목록이 있으면 그것으로 답한다.
  // 목록에서 찾으면 있는 것이고, 못 찾았다고 없는 것은 아니다(이름 체계가 다를 수 있다) — 그때는 폭 탐침에 맡긴다.
  const deviceFontAvailable = (family: string): true | undefined => deviceFonts.status === "loaded" && deviceFonts.fonts.some((font) => font.family.toLocaleLowerCase() === family.toLocaleLowerCase()) ? true : undefined;
  // 거부된 동안에는 누를 수 없는 버튼을 세우지 않는다. 브라우저의 거부는 사이트 설정에서 풀 수 있으므로 그
  // 방법만 알린다 — 풀면 권한 변경을 듣고 있다가 버튼을 다시 세운다. Desktop은 이 기기의 Console에는 미리
  // 허용하고, 원격 Console에는 거부한 채로 둔다가 이 버튼을 누르면 확인창으로 묻는다. 그 신호를 모르는 옛
  // 셸이거나 이 실행에서 이미 거부한 origin이면 버튼을 세우지 않는다.
  const desktopShell = isDesktopShell();
  const askDesktop = desktopShell && devicePermission === "denied" && desktopAsksForLocalFonts(shellHome.capabilities);
  const desktopDenied = askDesktop && deviceFonts.status === "desktopDenied";
  const canLoadDeviceFonts = devicePermission !== null && !deviceLoaded && (devicePermission !== "denied" || (askDesktop && !desktopDenied));
  const deviceDenied = !desktopShell && devicePermission === "denied" && !deviceLoaded;
  const pickerFooter = (axisFonts: readonly FontPickerInstalledFont[]): ReactNode => {
    const mismatch = !deviceLoaded && hostMismatch(axisFonts);
    const notes = [
      mismatch ? <p key="mismatch" className="settings-font-note">{t("settings.typography.picker.hostMismatch")}{canLoadDeviceFonts ? ` ${t("settings.typography.picker.hostMismatchLoad")}` : ""}</p> : null,
      canLoadDeviceFonts ? deviceFontsAction : null,
      deviceDenied ? <p key="denied" className="settings-font-note" role="status">{t("settings.typography.picker.deviceFontsDenied")}</p> : null,
      desktopDenied ? <p key="desktop-denied" className="settings-font-note" role="status">{t("settings.typography.picker.deviceFontsDesktopDenied")}</p> : null,
      canLoadDeviceFonts && deviceFonts.status === "failed" ? <p key="failed" className="settings-font-note" role="status">{t("settings.typography.picker.deviceFontsFailed")}</p> : null,
      mismatch ? <p key="wsl" className="settings-font-note">{t("settings.typography.picker.wslFontsHint")}</p> : null,
    ].filter(Boolean);
    return notes.length ? notes : null;
  };
  const deviceFontsBusy = deviceFonts.status === "loading" || deviceFonts.status === "awaitingDesktop";
  const deviceFontsAction = <div key="device" className="settings-device-fonts">
      <button type="button" className="settings-device-fonts-button" aria-disabled={deviceFontsBusy || undefined} onClick={(event) => {
        if (deviceFontsBusy) return;
        // 목록이 바뀌면 이 버튼은 사라진다. 포커스가 문서로 빠지지 않게 검색 칸으로 돌려놓는다.
        const search = event.currentTarget.closest(".fc-font-browser")?.querySelector<HTMLInputElement>("input[type=search]");
        void (askDesktop ? requestDesktopDeviceFonts() : loadDeviceFonts()).then(() => search?.focus());
      }}>{t(deviceFonts.status === "awaitingDesktop" ? "settings.typography.picker.deviceFontsAwaitingDesktop" : deviceFonts.status === "loading" ? "settings.typography.picker.deviceFontsLoading" : "settings.typography.picker.loadDeviceFonts")}</button>
      <p className="settings-font-note">{t("settings.typography.picker.deviceFontsPrivacy")}</p>
    </div>;
  const pickerLabels: FontPickerLabels = {
    browserAria: t("settings.typography.picker.browserAria"),
    searchLabel: t("settings.typography.picker.searchLabel"),
    searchPlaceholder: t("settings.typography.picker.searchPlaceholder"),
    loading: t("settings.typography.picker.loading"),
    choicesAria: t("settings.typography.picker.choicesAria"),
    builtInGroup: t("settings.typography.picker.builtInGroup"),
    installedGroup: t(deviceLoaded ? "settings.typography.picker.deviceGroup" : "settings.typography.picker.installedGroup"),
    missingGroup: t("settings.typography.picker.missingGroup"),
    missingGroupNote: t(deviceLoaded ? "settings.typography.picker.hostOnlyNote" : "settings.typography.picker.missingGroupNote"),
    missingSummary: (count) => t(`settings.typography.picker.${deviceLoaded ? "hostOnlySummary" : "missingSummary"}_${count === 1 ? "one" : "other"}`, { count }),
    noMatch: t("settings.typography.picker.noMatch"),
    preview: t("settings.typography.picker.preview"),
    available: t("settings.typography.picker.available"),
    unavailable: t("settings.typography.picker.unavailable"),
    fontSizeAria: t("settings.typography.picker.fontSizeAria"),
    decreaseSizeAria: t("settings.typography.picker.decreaseSizeAria"),
    sizeValueAria: t("settings.typography.picker.sizeValueAria"),
    increaseSizeAria: t("settings.typography.picker.increaseSizeAria"),
    sizeSliderAria: t("settings.typography.picker.sizeSliderAria"),
    monospace: t("settings.typography.picker.monospace"),
    systemFont: t("settings.typography.picker.systemFont"),
    savedSystemFont: t("settings.typography.picker.savedSystemFont"),
  };
  const save = (next: ConsoleFontSettings) => { void setGlobalSettingsField("fonts", next); };
  // 로딩 전(!state)만 native disabled다. 저장 중은 aria-disabled로 막는다 — 키보드로 막 누른 컨트롤에서 포커스가 문서로 빠지지 않게.
  const unavailable = !state;
  const labelFor = (selection: FontAxisSettings["font"]) => selection.source === "inherit" ? t("settings.fonts.inherit") : selection.source === "system" ? selection.familyName : FONT_BUILT_INS[selection.id].label;
  const axisRow = (axis: FontAxis | "terminal") => {
    const value = fonts[axis]!;
    const role = axis === "terminal" ? "code" : axis;
    const range = FONT_SIZE_RANGES[role];
    const axisFonts = pickerFonts.filter((font) => role === "code" ? font.monospace : font.uiSuitable);
    const label = t(`settings.fonts.${axis}`);
    const setAxis = (next: typeof value) => save({ ...fonts, [axis]: next });
    const selected = value.font.source === "inherit" ? { source: "builtin" as const, id: "inherit" } : value.font;
    const choices: { id: string; label: string; family: string }[] = Object.entries(FONT_BUILT_INS).filter(([id]) => role === "code" ? id !== "manrope" : id !== "cascadia" && id !== "fira-code").map(([id, font]) => ({ id, label: font.label, family: font.family }));
    if (role === "content") choices.unshift({ id: "inherit", label: t("settings.fonts.inherit"), family: fontFamilyForAxis(fonts, "ui") });
    return <div key={axis} className="global-settings-row settings-font-row" data-font-axis={axis}>
      <div className="global-settings-row-text"><p className="global-settings-resp-title">{label}</p><p className="global-settings-help">{t(`settings.fonts.${axis}Hint`)}</p></div>
      <div className="settings-font-controls">
        <FontMenu label={label} selectedLabel={labelFor(value.font)} builtIns={choices} installedFonts={axisFonts} selected={selected}
          selectedSystemFont={value.font.source === "system" ? value.font.familyName : null}
          selectedSystemFontAvailable={value.font.source === "system" ? deviceFontAvailable(value.font.familyName) : undefined}
          fallbackStack={fontFamilyForAxis(fonts, role)} previewText={t("settings.typography.preview")} loading={fontsLoading} error={fontsError} disabled={unavailable} busy={saving}
        labels={pickerLabels} footer={pickerFooter(axisFonts)}
          onSelectionChange={(selection) => setAxis({ ...value, font: selection.source === "builtin" && selection.id === "inherit" ? { source: "inherit" } : selection as FontAxisSettings["font"] })}
        />
        <div className="settings-font-size" role="group" aria-label={t("settings.fonts.sizeAria", { axis: label })}>
          <button type="button" disabled={unavailable || value.size <= range.min} aria-disabled={saving || undefined} aria-label={t("settings.slider.decrease", { title: label })} onClick={() => { if (!saving) setAxis({ ...value, size: value.size - 1 }); }}>−</button>
          <output>{value.size}px</output>
          <button type="button" disabled={unavailable || value.size >= range.max} aria-disabled={saving || undefined} aria-label={t("settings.slider.increase", { title: label })} onClick={() => { if (!saving) setAxis({ ...value, size: value.size + 1 }); }}>+</button>
        </div>
      </div>
    </div>;
  };
  // 초기화 버튼은 값이 기본값이 되는 즉시 사라진다. 포커스가 문서로 빠지지 않게 먼저 바로 다음 컨트롤인
  // UI 글꼴 선택기로 옮긴다 — 저장 중에도 포커스를 받고, 실패로 되돌려져도 그대로 남아 있다.
  const resetFonts = () => {
    card.current?.querySelector<HTMLElement>('[data-font-axis="ui"] .settings-font-trigger')?.focus();
    save(DEFAULT_FONTS);
  };
  return <section ref={card} className="global-settings-card settings-font-group" aria-label={t("settings.fonts.title")}>
    <h3 className="global-settings-card-title">{t("settings.fonts.title")}{JSON.stringify(fonts) !== JSON.stringify(DEFAULT_FONTS) ? <button type="button" className="settings-group-reset" disabled={unavailable || saving} onClick={resetFonts}>{t("settings.fonts.reset")}</button> : null}</h3>
    <div className="settings-group-surface">
      {(["ui", "content", "code"] as const).map(axisRow)}
      <div className="settings-font-preview" aria-label={t("settings.typography.picker.preview")}>
        <div><span>{t("settings.fonts.ui")}</span><p style={{ fontFamily: fontFamilyForAxis(fonts, "ui"), fontSize: fonts.ui.size }}>{t("settings.fonts.uiPreview")}</p></div>
        <div><span>{t("settings.fonts.content")}</span><p style={{ fontFamily: fontFamilyForAxis(fonts, "content"), fontSize: fonts.content.size }}>{t("settings.typography.preview")}</p></div>
        <div><span>{t("settings.fonts.code")}</span><p style={{ fontFamily: fontFamilyForAxis(fonts, "code"), fontSize: fonts.code.size }}>const fleet = "ready";<br />{t("settings.fonts.codePreview")}</p></div>
      </div>
      <details className="settings-font-advanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <summary>{t("settings.fonts.advanced")}</summary>
        {(["ui", "content", "code"] as const).map((axis) => <div className="global-settings-row" key={axis}>
          <div className="global-settings-row-text"><p className="global-settings-resp-title">{t("settings.fonts.cjkAxis", { axis: t(`settings.fonts.${axis}`) })}</p></div>
          <div className="settings-font-controls">
            <FontMenu label={t("settings.fonts.cjkAxis", { axis: t(`settings.fonts.${axis}`) })} selectedLabel={fonts[axis].cjk || t("settings.fonts.automatic")} selected={fonts[axis].cjk ? { source: "system", familyName: fonts[axis].cjk } : { source: "builtin", id: "auto" }}
              selectedSystemFontAvailable={fonts[axis].cjk ? deviceFontAvailable(fonts[axis].cjk) : undefined}
              builtIns={[{ id: "auto", label: t("settings.fonts.automatic"), family: fontFamilyForAxis({ ...fonts, [axis]: { ...fonts[axis], cjk: "" } }, axis) }]}
              installedFonts={cjkFonts} fallbackStack={fontFamilyForAxis(fonts, axis)} previewText={t("settings.typography.preview")} loading={fontsLoading || scanning} error={fontsError} disabled={unavailable} busy={saving}
              labels={pickerLabels}
              onSelectionChange={(selection) => save({ ...fonts, [axis]: { ...fonts[axis], cjk: selection.source === "system" ? selection.familyName : "" } })} />
          </div>
        </div>)}
        <div className="global-settings-row"><div className="global-settings-row-text"><p className="global-settings-resp-title">{t("settings.fonts.separateTerminal")}</p></div>
          <SettingsToggle checked={!!fonts.terminal} ariaLabel={t("settings.fonts.separateTerminal")} disabled={unavailable} busy={saving} onChange={(enabled) => save({ ...fonts, terminal: enabled ? { font: fonts.code.font, size: fonts.code.size } : null })} />
        </div>
        {fonts.terminal ? axisRow("terminal") : null}
      </details>
    </div>
  </section>;
}

/**
 * 언어와 콘솔 포트는 성격이 다르다. 언어는 누르는 즉시 화면 전체가 다시 칠해지고, 포트는
 * 콘솔이 다시 시작할 때 적용된다. 예전에는 둘이 한 카드에 묶여 "새로 시작한 세션에 적용된다"는
 * 각주 하나를 공유했고, 그 문장은 두 줄 모두에 대해 사실이 아니었다.
 */
export function LanguageCard({
  state,
  saving,
}: {
  readonly state: GlobalSettingsState;
  readonly saving: boolean;
}) {
  const t = useT();
  const languages = buildLanguages(t);
  return (
    <section className="global-settings-card" aria-label={t("settings.language.aria")}>
      <h3 className="global-settings-card-title">{t("settings.fonts.displayGroup")}</h3>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("settings.language.label")}
            <SettingsHelp title={t("settings.language.label")}>{t("settings.language.help")}</SettingsHelp>
          </p>
        </div>
        <div className="segmented language-picker" role="group" aria-label={t("settings.language.aria")}>
          <SegmentedThumb />
          {languages.map((language) => {
            const isActive = state.language === language.id;
            return (
              <button
                key={language.id}
                type="button"
                aria-pressed={isActive}
                className={`segmented-option ${isActive ? "is-active" : ""}`}
                disabled={saving}
                onClick={() => void setGlobalSettingsField("language", language.id)}
              >
                {language.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function ConsolePortCard({
  state,
  saving,
}: {
  readonly state: GlobalSettingsState;
  readonly saving: boolean;
}) {
  const t = useT();
  const consoleState = useConsoleState();
  return (
    <section className="global-settings-card" aria-label={t("settings.port.title")}>
      <h3 className="global-settings-card-title">{t("settings.port.title")}</h3>
      <ConsolePortSettings state={state} saving={saving} consoleState={consoleState} />
    </section>
  );
}

/**
 * Settings → Remote access. 시안 그대로 — Desktop 설치 경로, 보안 경고, 수신 주소, 이 콘솔의
 * 신원, 액세스 링크와 그것을 쓴 기기들. 각 카드는 자기 사실만 말하고 서로의 상태를 추측하지 않는다.
 */
function ConsolePortSettings({
  state,
  saving,
  consoleState,
}: {
  readonly state: GlobalSettingsState;
  readonly saving: boolean;
  readonly consoleState: ReturnType<typeof useConsoleState>;
}) {
  const t = useT();
  const portModes = buildPortModes(t);
  const [draftPort, setDraftPort] = useState(state.consoleStaticPort?.toString() ?? "");
  const effectivePort = consoleState.effectivePort;
  const fallbackActive = consoleState.portMode === "static" && !consoleState.portHonored;
  // runtimeRequestedPort는 마지막 기동에서 실제로 시도한 포트(런타임 사실)이고,
  // 다음 재시작 동작은 저장된 설정(state)으로 안내해야 한다 — 둘을 섞으면 오안내가 된다.
  const runtimeRequestedPort = consoleState.requestedPort;
  const nextRestartStatic = state.consolePortMode === "static" && state.consoleStaticPort !== null;
  const trimmedDraftPort = draftPort.trim();
  const parsedPort = Number(trimmedDraftPort);
  const draftHasValue = trimmedDraftPort.length > 0;
  const draftIsValid = draftHasValue && isValidConsoleStaticPort(parsedPort);
  const draftIsInvalid = state.consolePortMode === "static" && draftHasValue && !draftIsValid;

  useEffect(() => {
    setDraftPort(state.consoleStaticPort?.toString() ?? "");
  }, [state.consoleStaticPort]);

  return (
    <div className="global-settings-row is-stack console-port-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {t("settings.port.label")}
          <SettingsHelp title={t("settings.port.label")}>{t("settings.port.help")}</SettingsHelp>
        </p>
      </div>
      <div className="console-port-control">
        <div className="segmented" role="group" aria-label={t("settings.port.modeAria")}>
          <SegmentedThumb />
          {portModes.map((mode) => {
            const isActive = state.consolePortMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={isActive}
                className={`segmented-option ${isActive ? "is-active" : ""}`}
                disabled={saving}
                onClick={() => void setGlobalSettingsField("consolePortMode", mode.id)}
              >
                {mode.label}
              </button>
            );
          })}
        </div>

        <div className={`console-port-reveal ${state.consolePortMode === "static" ? "is-open" : ""}`}>
          <div className="console-port-reveal-inner">
            <label className="console-port-input-label" htmlFor="console-static-port-input">{t("settings.port.staticPort")}</label>
            <input
              id="console-static-port-input"
              className={`console-port-input ${draftIsInvalid ? "is-invalid" : ""}`}
              inputMode="numeric"
              placeholder="8080"
              value={draftPort}
              disabled={saving}
              aria-invalid={draftIsInvalid}
              aria-describedby="console-static-port-hint"
              onChange={(event) => {
                const next = event.target.value;
                setDraftPort(next);
                const nextPort = Number(next.trim());
                if (isValidConsoleStaticPort(nextPort)) void setGlobalSettingsField("consoleStaticPort", nextPort);
              }}
            />
            <span id="console-static-port-hint" className={`console-port-hint ${draftIsInvalid ? "is-invalid" : ""}`}>
              {t("settings.port.hint")}
            </span>
          </div>
        </div>

        <div className={`console-port-effective ${fallbackActive ? "is-fallback" : ""}`} aria-live="polite">
          <span className="console-port-effective-dot" aria-hidden="true" />
          <div>
            <p className="console-port-effective-label">{t("settings.port.currentlyReachable")}</p>
            <p className="console-port-effective-value">
              127.0.0.1:<span>{effectivePort || "..."}</span>{fallbackActive ? t("settings.port.dynamicSuffix") : ""}
            </p>
          </div>
        </div>

        {fallbackActive && runtimeRequestedPort ? (
          <div className="console-port-warning" role="status">
            {renderMessage(t("settings.port.fallback"), {
              port: <strong>{runtimeRequestedPort}</strong>,
              mode: <strong>{t("settings.port.dynamic")}</strong>,
              host: <strong>{`127.0.0.1:${effectivePort || "..."}`}</strong>,
            })}{" "}
            {nextRestartStatic
              ? renderMessage(t("settings.port.nextRestartStatic"), {
                  port: <strong>{state.consoleStaticPort}</strong>,
                })
              : t("settings.port.nextRestartDynamic")}
          </div>
        ) : null}

      </div>
    </div>
  );
}

function isValidConsoleStaticPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}

export function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
