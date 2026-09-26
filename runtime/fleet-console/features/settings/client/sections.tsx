import { FontPicker, type FontPickerInstalledFont, type FontPickerSelection } from "@fleet-console/font-picker/browser";
import "@fleet-console/font-picker/styles.css";
import { SystemFontsFetchError, fetchSystemFonts } from "@fleet-console/font-picker/system-fonts";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { PluginErrorBoundary, SegmentedThumb } from "@fleet-console/sdk/react/browser";
import type { SettingsSectionDescriptor, SettingsSectionGroup } from "@fleet-console/sdk/settings";
import { SettingsSlider, SettingsToggle } from "@fleet-console/sdk/settings/browser";
import { useEffect, useState, type ReactNode } from "react";
import { RemoteAccessSection } from "../../remote-access/client/settings-section.js";
export { RemoteAccessSection } from "../../remote-access/client/settings-section.js";

import { BackendApiSection } from "../../../core/client/src/chrome/components/backend-api-section.js";
import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { renderMessage, useT, type CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import { setActiveTheme, setActiveUiFont, setLiquidGlass, setUnfocusedPanelFade, themePolarity } from "../../../core/client/src/integration/store.js";
import { type GlobalSettingsState, type ThemeId, type UiFontId, type UiFontSettings } from "../../../core/client/src/integration/types.js";
import { ExperimentsSection } from "./experiments-section.js";
import { isSavingGlobalSettingsField, setGlobalSettingsField, type GlobalSettingsField } from "./global-settings-store.js";
import { ShortcutsCard } from "./shortcuts-section.js";
import { DEFAULT_UI_FONT, UI_FONT_BUILT_INS, UI_FONT_DESCRIPTION_KEYS, UI_FONT_SIZE_RANGE, uiFontFamily } from "./ui-font.js";

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
      entries: [t("settings.theme.title"), t("settings.theme.label"), t("settings.theme.liquidGlass"), t("settings.theme.panelFade"), t("settings.typography.title"), t("settings.typography.label"), t("settings.typography.sizeTitle"), t("settings.theme.railOpacity"), t("settings.theme.sideBarOpacity"), t("settings.theme.sideBarBlur"), t("settings.core.appearance.keywords")],
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
        t("settings.experiments.promptRefine.title"),
        t("settings.experiments.sessionWatch.title"),
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
          <ThemeCard state={state} saving={saving} extras={options?.themeCardExtras} />
          <TypographyCard state={state} saving={saving.has("uiFont")} />
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
  /* 라이트 테마는 유리를 받지 않는다(theme.css 게이트가 극성으로 제외한다). 그래서 이 줄은
     저장된 선호가 아니라 **지금 화면에 실제로 실린 재질**을 말해야 한다 — 크롬이 불투명한데
     손잡이만 켜져 있으면 화면과 컨트롤이 서로 다른 말을 한다. 켜진 채로 흐려진 손잡이는
     이 저장소에서 이미 "꺼진 것으로 읽힌다"고 못박은 실패 양식이기도 하다(agent-cli 강도 사다리).
     저장값 자체는 건드리지 않는다 — 쓰기는 toggleLiquidGlass 하나뿐이고, 다크로 돌아오면
     사용자가 고른 값이 그대로 다시 선다. */
  const lightTheme = themePolarity(activeTheme) === "light";
  const liquidGlass = (state?.liquidGlass ?? true) && !lightTheme;
  const savedPanelFade = state?.unfocusedPanelFade ?? UNFOCUSED_PANEL_FADE_DEFAULT;
  // 끄는 동안의 값은 화면이 들고, 서버 값은 손을 뗄 때 따라온다. 저장 왕복마다 손잡이가
  // 서버 값으로 되튀면 연속 조작이 끊긴다.
  const [draftPanelFade, setDraftPanelFade] = useState<number | null>(null);
  const panelFade = draftPanelFade ?? savedPanelFade;
  const previewPanelFade = (next: number) => {
    setDraftPanelFade(next);
    setUnfocusedPanelFade(next);
  };
  const commitPanelFade = (next: number) => {
    if (next === savedPanelFade) {
      setDraftPanelFade(null);
      return;
    }
    void setGlobalSettingsField("unfocusedPanelFade", next).then((saved) => {
      setDraftPanelFade(null);
      if (!saved) setUnfocusedPanelFade(savedPanelFade);
    });
  };
  const toggleLiquidGlass = (enabled: boolean) => {
    if (!state) return;
    // 낙관 적용 후 저장 실패 시 되돌린다 — selectTheme의 실패 복원과 같은 문법.
    setLiquidGlass(enabled);
    void setGlobalSettingsField("liquidGlass", enabled).then((saved) => {
      if (!saved) setLiquidGlass(!enabled);
    });
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
                {t("settings.theme.liquidGlass")}
                {/* 라이트 테마에서는 비활성 이유를 안내한다. */}
                <SettingsHelp title={t("settings.theme.liquidGlass")}>
                  {t(lightTheme ? "settings.theme.liquidGlassLightHelp" : "settings.theme.liquidGlassHelp")}
                </SettingsHelp>
              </p>
            </div>
            <SettingsToggle
              checked={liquidGlass}
              disabled={saving.has("liquidGlass") || state === null || lightTheme}
              ariaLabel={t("settings.theme.liquidGlass")}
              onChange={toggleLiquidGlass}
            />
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
                연속값은 SDK 슬라이더 한 문법이다(−/+·값·기본값 버튼) — 백분율 표기는 두 로케일에서
                같은 문자열이라 메시지 키 없이 여기서 조립한다. */}
            <SettingsSlider
              value={panelFade}
              min={UNFOCUSED_PANEL_FADE_MIN}
              max={UNFOCUSED_PANEL_FADE_MAX}
              step={5}
              disabled={saving.has("unfocusedPanelFade") || state === null}
              label={t("settings.theme.panelFade")}
              formatValue={(value) => `${value}%`}
              decreaseLabel={t("settings.slider.decrease", { title: t("settings.theme.panelFade") })}
              increaseLabel={t("settings.slider.increase", { title: t("settings.theme.panelFade") })}
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
      </div>
    </section>
  );
}


export function TypographyCard({
  state,
  saving,
}: {
  readonly state: GlobalSettingsState | null;
  readonly saving: boolean;
}) {
  const t = useT();
  const activeUiFont = state?.uiFont ?? DEFAULT_UI_FONT;
  const [installedFonts, setInstalledFonts] = useState<readonly FontPickerInstalledFont[]>([]);
  const [fontsLoading, setFontsLoading] = useState(true);
  const [fontsError, setFontsError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSystemFonts({ signal: controller.signal }).then((response) => {
      setInstalledFonts(response.fonts.filter((font) => font.uiSuitable).map(({ family, monospace }) => ({ family, monospace })));
      setFontsError(null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setInstalledFonts([]);
        // SystemFontsFetchError는 고정 영문 메시지를 담고 오므로 그대로 노출하면 로케일을 벗어난다.
        // 예상된 탐색 실패는 카탈로그 문구로 바꾸고, 예상 밖 오류만 원문을 남긴다.
        const expected = error instanceof SystemFontsFetchError;
        setFontsError(!expected && error instanceof Error ? error.message : t("settings.typography.fontsLoadError"));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setFontsLoading(false);
    });
    return () => controller.abort();
  }, [t]);

  const saveUiFont = (uiFont: UiFontSettings) => {
    if (isSavingGlobalSettingsField("uiFont")) return;
    const previousUiFont = activeUiFont;
    setActiveUiFont(uiFont);
    void setGlobalSettingsField("uiFont", uiFont).then((saved) => {
      if (!saved) setActiveUiFont(previousUiFont);
    });
  };

  const selectUiFont = (selection: FontPickerSelection) => {
    const uiFont: UiFontSettings = selection.source === "builtin"
      ? { source: "builtin", id: selection.id as UiFontId, size: activeUiFont.size }
      : { source: "system", familyName: selection.familyName, size: activeUiFont.size };
    saveUiFont(uiFont);
  };

  return (
    <section className="global-settings-card" aria-label={t("settings.typography.aria")}>
      <h3 className="global-settings-card-title">{t("settings.typography.title")}</h3>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("settings.typography.label")}
            <SettingsHelp title={t("settings.typography.label")}>{t("settings.typography.help")}</SettingsHelp>
          </p>
        </div>
        <button
          type="button"
          className="fc-settings-reset"
          disabled={!state || saving || activeUiFont.source === "builtin" && activeUiFont.id === "manrope" && activeUiFont.size === UI_FONT_SIZE_RANGE.defaultValue}
          onClick={() => saveUiFont(DEFAULT_UI_FONT)}
        >
          {t("settings.typography.reset")}
        </button>
      </div>
      <FontPicker
        builtIns={UI_FONT_BUILT_INS.map(({ id, label, family, aliases }) => ({
          id,
          label,
          family,
          aliases,
          description: t(UI_FONT_DESCRIPTION_KEYS[id]),
        }))}
        installedFonts={installedFonts}
        selected={activeUiFont.source === "builtin" ? { source: "builtin", id: activeUiFont.id } : { source: "system", familyName: activeUiFont.familyName }}
        selectedSystemFont={activeUiFont.source === "system" ? activeUiFont.familyName : null}
        fallbackStack={uiFontFamily(DEFAULT_UI_FONT)}
        previewText={t("settings.typography.preview")}
        size={activeUiFont.size}
        sizeRange={UI_FONT_SIZE_RANGE}
        loading={fontsLoading}
        error={fontsError}
        disabled={!state || saving}
        labels={{
          browserAria: t("settings.typography.picker.browserAria"),
          searchLabel: t("settings.typography.picker.searchLabel"),
          searchPlaceholder: t("settings.typography.picker.searchPlaceholder"),
          loading: t("settings.typography.picker.loading"),
          choicesAria: t("settings.typography.picker.choicesAria"),
          builtInGroup: t("settings.typography.picker.builtInGroup"),
          installedGroup: t("settings.typography.picker.installedGroup"),
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
        }}
        onSelectionChange={selectUiFont}
        onSizeCommit={(size) => saveUiFont({ ...activeUiFont, size })}
      />
    </section>
  );
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
