import { isProviderCatalogVisible } from "@fleet-console/ai-gateway/model-family";
import { AiGatewayModelsCard as GatewayModelsCard, AiGatewayModelsEntry as GatewayModelsEntry } from "./gateway-models-card.js";
import { launchProviderGlyph, serviceGlyph } from "./components/launch-provider-glyphs.js";
import * as React from "react";
import { SegmentedThumb } from "@fleet-console/ui/react";
import { Select } from "../../settings/client/mobile-host.js";
import { SettingsCheckbox, SettingsGroup, SettingsHelpTip, SettingsInputRow, SettingsItem, SettingsSegments, SettingsSubScreenRow, SettingsToggle, defineSettingsSection } from "../../settings/client/preferences-context.js";
import { useMobileSettingsHost } from "../../settings/client/mobile-host.js";
import { getT, useTerminalLocale, type TerminalMessageKey } from "../../execution/client/agent/i18n/index.js";
import { getSystemPromptSettingsStoreState, loadSystemPromptSettings, setSystemPromptSettingsField, subscribe as subscribeSystemPromptSettings, useSystemPromptSettingsStore, type AiGatewayCatalogModel, type AiGatewayCatalogProvider, type AiGatewayProviderId, type AiGatewaySettings, type CompactCeiling, type DelegationRoutingMode } from "../../settings/client/execution-settings.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore, type ModelAuthProviderState } from "./model-auth.js";
import { SyncedTextarea } from "../../execution/client/composer-primitives/input.js";
import { ModelCoordinatePicker, modelCoordinateDisplay, type ModelCoordinatePickerLabels } from "./components/model-coordinate-picker.js";
import { ROSTER_FALLBACK_MODEL, clampRosterEffort, findRosterRow, isAgentEffort, rosterRowEfforts, rosterRows, type ModelRoster } from "../shared/models.js";
import { pushBackLayer } from "../../../core/client/src/chrome/mobile/mobile-back.js";
import { reportSheetChrome, reportShellChrome } from "../../../core/client/src/chrome/mobile/mobile-chrome.js";
import { pushOverlayHistory, releaseOverlayHistory } from "../../../core/client/src/chrome/mobile/mobile-overlay-history.js";
import { useModelRoster } from "./model-roster-store.js";

/** 이 화면의 모델 선택기 문구 — 접근 이름은 그 행의 제목이다. */
function rosterPickerLabels(t: ReturnType<typeof getT>, title: string): ModelCoordinatePickerLabels {
  return {
    menu: title,
    // 강도 묶음 제목·게이지 접근 이름은 행 제목이 아니다. 다른 좌표 메뉴와 같은 「추론 강도」다.
    effort: t("terminal.chat.coordMenuEffortTrack"),
    auto: t("terminal.settings.models.auto"),
    back: t("terminal.settings.models.back"),
    loading: t("terminal.settings.models.loading"),
    empty: t("terminal.settings.models.empty"),
    off: t("terminal.settings.models.off"),
    providerRemoved: t("terminal.settings.models.providerRemoved"),
    chooseAnotherModel: t("terminal.settings.models.chooseAnotherModel"),
    fallback: t("terminal.settings.models.fallback"),
  };
}
export const aiGatewaySettingsSection = defineSettingsSection({
  id: "agent-cli",
  title: (locale) => getT(locale)("terminal.settings.agentCli"),
  group: "work",
  keywords: [
    (locale) => [
      getT(locale)("terminal.settings.aiGatewayModels"),
      getT(locale)("terminal.settings.compactTiming"),
      getT(locale)("terminal.settings.aiGatewayRouting"),
      getT(locale)("terminal.settings.aiGatewayDiagnostics"),
      getT(locale)("terminal.settings.aiGatewayWireLog"),
    ].join(" "),
    "gateway provider model api key codex xai routing delegation subagent workflow diagnostics wire log compact",
    "게이트웨이 공급자 모델 키 라우팅 배정 위임 서브에이전트 워크플로 진단 와이어 로그 압축",
  ],
  render: () => <AiGatewaySection />,
  // 폰의 설정 목록 보조 줄 — 켠 모델이 하나라도 있으면 켜짐(데스크톱은 이 필드를 읽지 않는다).
  mobile: {
    summary: (locale) => {
      const state = getSystemPromptSettingsStoreState().state;
      if (state === null) return null;
      return getT(locale)((state.aiGateway?.models?.length ?? 0) > 0 ? "terminal.settings.mobileGatewayOn" : "terminal.settings.mobileGatewayOff");
    },
    subscribe: (listener) => {
      void loadSystemPromptSettings();
      return subscribeSystemPromptSettings(listener);
    },
  },
});

function AiGatewaySection() {
  useLoadSystemPromptSettings();
  const mobile = useMobileSettingsHost() !== null;
  // 폰: 모델 카드는 길어서 「모델 목록」 행 하나로 접고, 그 하위 화면에서 연다(키트 어댑터가 적용된 같은 카드).
  return <>{mobile ? <GatewayModelsEntry /> : <GatewayModelsCard />}<AiGatewayRoutingCard /><AiGatewayCompactTimingCard /><AiGatewayDiagnosticsCard /></>;
}
const AI_GATEWAY_PROVIDER_LABEL_KEYS = {
  antigravity: "terminal.settings.aiGatewayProviderAntigravity",
  claude: "terminal.settings.aiGatewayProviderClaude",
  codex: "terminal.settings.aiGatewayProviderCodex",
  xai: "terminal.settings.aiGatewayProviderXai",
  "muse-code": "terminal.settings.aiGatewayProviderMuseCode",
} as const;

/**
 * 공급자 표시 순서: Claude가 맨 앞, 나머지 구독·CLI 공급자는 카탈로그 순서.
 * 표시 순서는 소진 우선순위를 바꾸지 않는다.
 */
export function orderAiGatewayProviders<T extends { readonly id: string }>(providers: readonly T[]): T[] {
  const claude = providers.filter((provider) => provider.id === "claude");
  const subscription = providers.filter((provider) => provider.id !== "claude");
  return [...claude, ...subscription];
}

function formatAiGatewayContextWindow(contextWindow: number | null): string | null {
  if (contextWindow === null) return null;
  return contextWindow >= 1_000_000 ? "1M" : `${Math.round(contextWindow / 1000)}K`;
}

const COMPACT_CEILING_EARLY = 88;
const COMPACT_CEILING_LATE = 97;
const COMPACT_CEILING_CUSTOM_MIN = 70;
const COMPACT_CEILING_CUSTOM_MAX = 99;
const PROVIDER_COMPACT_RESERVE = 16_000;
const COMPACT_CROWD_RESERVE = 8_000;

function compactPolicyFromCeiling(ceiling: CompactCeiling | null): "auto" | "early" | "late" | "custom" {
  if (ceiling === null) return "auto";
  if (ceiling === "early") return "early";
  if (ceiling === "late") return "late";
  return "custom";
}

function compactPercent(ceiling: CompactCeiling | null): number | undefined {
  if (ceiling === "early") return COMPACT_CEILING_EARLY;
  if (ceiling === "late") return COMPACT_CEILING_LATE;
  if (typeof ceiling === "number") return ceiling;
  return undefined;
}

function compactAtTokens(window: number, ceiling: CompactCeiling | null): number {
  const percent = compactPercent(ceiling);
  if (percent === undefined) return window - PROVIDER_COMPACT_RESERVE;
  return Math.floor(window * percent / 100);
}

/** Map a 70–99 compact percent onto the custom track (left = 70, right = 99). */
export function compactTrackFillPercent(windowPercent: number): number {
  const clamped = Math.min(
    COMPACT_CEILING_CUSTOM_MAX,
    Math.max(COMPACT_CEILING_CUSTOM_MIN, windowPercent),
  );
  return (clamped - COMPACT_CEILING_CUSTOM_MIN)
    / (COMPACT_CEILING_CUSTOM_MAX - COMPACT_CEILING_CUSTOM_MIN)
    * 100;
}

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  return `${Math.round(n / 1000)}K`;
}

const COMPACT_VALUE_KEYS = new Set([
  "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
  "End", "Home", "PageDown", "PageUp",
]);

function AiGatewayCompactTimingCard() {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields.has("compactCeiling");
  const mobile = useMobileSettingsHost() !== null;
  const [previewId, setPreviewId] = React.useState<string>("");
  const previewRoster = useModelRoster("agent");
  // 끌리는 동안의 값은 화면에만 싣고, 손을 뗄 때(pointerup·값을 움직인 keyup·blur) 한 번 저장한다 —
  // SettingsSlider와 같은 계약. 키 한 번마다 저장하면 방향키를 누르고 있는 동안 설정 문서가 연달아 다시 쓰인다.
  const [dragPercent, setDragPercent] = React.useState<number | null>(null);
  const dragPercentRef = React.useRef<number | null>(null);

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={t("terminal.settings.compactTiming")}>
        <p className="global-settings-resp-title">{t("terminal.settings.compactTiming")}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  const ceiling = state.compactCeiling;
  const policy = compactPolicyFromCeiling(ceiling);
  // 미리보기도 모델 로스터(켠 모델)에서 고른다 — 로스터가 비면 기본 창(272K)으로 그린다.
  const previewModels = rosterRows(previewRoster).filter((row) => typeof row.contextWindow === "number" && row.contextWindow > 0);
  const preview = (previewId ? findRosterRow(previewRoster, previewId) : null) ?? previewModels[0];
  const previewWindow = preview?.contextWindow ?? 272_000;
  const liveCeiling: CompactCeiling | null = policy === "custom" && dragPercent !== null
    ? dragPercent
    : ceiling;
  const at = compactAtTokens(previewWindow, liveCeiling);
  const shownPercent = Math.round(at * 100 / previewWindow);
  const trackFill = compactTrackFillPercent(shownPercent);
  const crowded = at >= previewWindow - COMPACT_CROWD_RESERVE || shownPercent >= 99;
  const lateBeforeAuto = compactAtTokens(previewWindow, "late") < compactAtTokens(previewWindow, null)
    && (liveCeiling === "late" || (typeof liveCeiling === "number" && liveCeiling === COMPACT_CEILING_LATE));

  const savePolicy = (next: "auto" | "early" | "late" | "custom"): void => {
    if (next === "auto") {
      void setSystemPromptSettingsField("compactCeiling", null);
      return;
    }
    if (next === "early" || next === "late") {
      void setSystemPromptSettingsField("compactCeiling", next);
      return;
    }
    const seed = typeof ceiling === "number"
      ? ceiling
      : ceiling === "early"
        ? COMPACT_CEILING_EARLY
        : ceiling === "late"
          ? COMPACT_CEILING_LATE
          : 94;
    void setSystemPromptSettingsField("compactCeiling", seed);
  };

  const saveCustom = (percent: number): void => {
    const clamped = Math.min(COMPACT_CEILING_CUSTOM_MAX, Math.max(COMPACT_CEILING_CUSTOM_MIN, Math.round(percent)));
    void setSystemPromptSettingsField("compactCeiling", clamped);
  };

  const previewCustom = (percent: number): void => {
    dragPercentRef.current = percent;
    setDragPercent(percent);
  };

  const commitCustom = (): void => {
    const next = dragPercentRef.current;
    if (next === null) return;
    dragPercentRef.current = null;
    setDragPercent(null);
    if (next !== ceiling) saveCustom(next);
  };

  return (
    <SettingsGroup ariaLabel={t("terminal.settings.compactTiming")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <SettingsItem
        label={t("terminal.settings.compactTiming")}
        labelId="compact-timing-label"
        helpTip={(
          <SettingsHelp title={t("terminal.settings.compactTiming")}>
            <p>{t("terminal.settings.compactTimingHelp")}</p>
          </SettingsHelp>
        )}
      >
        <SettingsSegments
          ariaLabelledBy="compact-timing-label"
          value={policy}
          disabled={saving}
          options={[
            { value: "auto" as const, label: t("terminal.settings.compactTimingAuto") },
            { value: "early" as const, label: t("terminal.settings.compactTimingEarly") },
            { value: "late" as const, label: t("terminal.settings.compactTimingLate") },
            // 폰에는 직접 고르는 트랙이 없다 — 데스크톱에서 정해 둔 「직접」일 때만 옵션이 남는다.
            ...(mobile && policy !== "custom" ? [] : [{ value: "custom" as const, label: t("terminal.settings.compactTimingCustom") }]),
          ]}
          onChange={savePolicy}
        />
      </SettingsItem>
      {previewModels.length > 0 ? (
        <SettingsItem
          label={t("terminal.settings.compactTimingPreview")}
          labelId="compact-timing-preview-label"
          helpTip={<SettingsHelp title={t("terminal.settings.compactTimingPreview")}>{t("terminal.settings.compactTimingPreviewHelp")}</SettingsHelp>}
        >
          <ModelCoordinatePicker
            roster={previewRoster?.map((group) => ({ ...group, rows: group.rows.filter((row) => previewModels.includes(row)) })).filter((group) => group.rows.length > 0) ?? null}
            value={{ ...(preview ? { model: preview.launch.model ?? preview.id } : {}) }}
            effort="none"
            onChange={(next) => { if (next.model) setPreviewId(next.model); }}
            labels={rosterPickerLabels(t, t("terminal.settings.compactTimingPreview"))}
            trigger={{ variant: "field", className: "ai-gateway-field-trigger", text: preview ? `${preview.label} · ${formatAiGatewayContextWindow(preview.contextWindow ?? null) ?? ""}` : undefined }}
          />
        </SettingsItem>
      ) : null}
      {/* 트랙·수치·안내는 행 하나로 묶어 같은 면에 잇는다 — 카드 형제로 두면 면 밖에 떠 따로 읽힌다. */}
      {mobile ? null : (
        <div className="global-settings-row is-stack compact-timing-body">
      <div className="compact-timing-track-wrap">
        {/* 보이는 range 하나가 트랙이다 — 숨긴 range와 따로 그린 손잡이를 겹치면 포커스 링이 트랙 래퍼
            전체에 서서 카드 가장자리에서 잘린다. 손잡이와 포커스 링은 공유 `.fleet-slider`가 그리고, 막대와
            채움은 이 카드가 그린다: 채움이 경고(is-warn)를 싣는 계기라 brass 채움을 쓰지 않는다. */}
        <div className={`compact-timing-track${policy === "custom" ? " is-live" : ""}${crowded ? " is-warn" : ""}`}>
          <div className="compact-timing-bar">
            {/* 채움 끝은 손잡이 중심을 따른다 — 막대가 양끝 4px 안쪽에 서므로 손잡이 중심은 막대 양끝에서
                흰 면의 반지름(10px)만큼 안쪽을 오간다. */}
            <div className="compact-timing-fill" style={{ width: `calc(10px + (100% - 20px) * ${trackFill / 100})` }} />
          </div>
          <input
            className="fleet-slider compact-timing-range"
            type="range"
            min={COMPACT_CEILING_CUSTOM_MIN}
            max={COMPACT_CEILING_CUSTOM_MAX}
            step={1}
            value={typeof liveCeiling === "number" ? liveCeiling : shownPercent}
            disabled={policy !== "custom"}
            aria-label={t("terminal.settings.compactTimingCustomAria")}
            aria-valuetext={`${shownPercent}%`}
            onChange={(event) => previewCustom(Number(event.currentTarget.value))}
            onPointerUp={commitCustom}
            onKeyUp={(event) => {
              if (COMPACT_VALUE_KEYS.has(event.key)) commitCustom();
            }}
            onBlur={commitCustom}
          />
        </div>
        <div className="compact-timing-ticks">
          <span>70%</span>
          <span>{shownPercent}%</span>
          <span>{t("terminal.settings.compactTimingWindow")}</span>
        </div>
      </div>
      <div className="compact-timing-readout">
        <div className="compact-timing-stat">
          <span>{t("terminal.settings.compactTimingAt")}</span>
          <strong>{formatCompactTokens(at)}</strong>
        </div>
        <div className="compact-timing-stat">
          <span>{t("terminal.settings.compactTimingOfWindow")}</span>
          <strong>{shownPercent}%</strong>
        </div>
        <div className="compact-timing-stat">
          <span>{t("terminal.settings.compactTimingCatalog")}</span>
          <strong>{formatAiGatewayContextWindow(previewWindow)}</strong>
        </div>
      </div>
      {crowded || lateBeforeAuto ? (
        <p className="compact-timing-note">
          {crowded
            ? t("terminal.settings.compactTimingCrowd")
            : t("terminal.settings.compactTimingLateBeforeAuto", {
              late: formatCompactTokens(at),
              auto: formatCompactTokens(compactAtTokens(previewWindow, null)),
            })}
        </p>
      ) : null}
        </div>
      )}
    </SettingsGroup>
  );
}

/**
 * 배정 카드. 모델 카드 바로 아래에 놓는다 — 여기서 켜는 것은 그 위에서 노출한 모델을
 * 쓰는 방식이고, 노출을 정하기 전에 배정을 묻는 순서는 읽는 사람에게 거꾸로다.
 */
function AiGatewayRoutingCard() {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const settings = useSystemPromptSettingsStore();
  const auth = useModelAuthStore();
  const routingRoster = useModelRoster("agent");
  const mobileHost = useMobileSettingsHost();
  const [testOpen, setTestOpen] = React.useState(false);
  const testPanelId = React.useId();
  const state = settings.state;
  const saving = settings.savingFields;

  React.useEffect(() => {
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);

  if (!state) {
    return <section className="global-settings-card"><p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p></section>;
  }
  const typesafeSignedIn = auth.state?.providers.some(entry => entry.provider === "typesafe" && entry.signedIn) === true;
  const mode = state.delegationRoutingMode;
  const modeSaving = saving.has("delegationRoutingMode");
  const routingSaving = saving.has("delegationRoutingEnabled");
  const jevStored = mode === "jev";
  const jevActive = jevStored && typesafeSignedIn;
  const jevFallback = jevStored && !typesafeSignedIn;
  const routingPickerLabels = rosterPickerLabels(t, t("terminal.settings.aiGatewayRoutingModel"));
  // 저장한 강도가 있으면 그 값을, 없으면 실행과 같은 기본(low 우선)을 표시에 실어 표기가 갈리지 않게 한다.
  const routingValue = state.delegationRoutingModel
    ? { model: state.delegationRoutingModel, ...withEffort(routingJudgeEffort(routingRoster, state.delegationRoutingModel, state.delegationRoutingEffort)) }
    : {};
  const routingFallback = { model: ROSTER_FALLBACK_MODEL, effort: "low" };
  // 폰의 선택기 행은 「모델 · 강도」를 한 문자열로 그려 CSS가 강도만 내릴 수 없다 — 설정의 데스크톱
  // 트리거(settings-pane.css)처럼 강도를 소문자로 읽히게 문구를 여기서 넘긴다.
  const routingPickerText = (() => {
    if (!mobileHost) return undefined;
    const display = modelCoordinateDisplay(routingRoster, routingValue, routingFallback, routingPickerLabels);
    const effort = display.words.effort && display.words.effort !== routingPickerLabels.auto ? display.words.effort.toLowerCase() : display.words.effort;
    return [display.words.model, effort, display.badge].filter(Boolean).join(" · ");
  })();
  const saveMode = (next: DelegationRoutingMode): void => {
    if (next === "jev" && !typesafeSignedIn) return;
    void setSystemPromptSettingsField("delegationRoutingMode", next);
  };
  // 안내는 행 사이의 문단이 아니라 그 행의 보조 줄이다 — 문단이 끼면 한 묶음의 면이 조각난다.
  const lines = (key: TerminalMessageKey): string => t(key).split("\n").join(" ");
  const modeHint = jevActive
    ? lines("terminal.settings.aiGatewayDelegationRoutingJevNotice")
    : jevFallback
      ? `${t("terminal.settings.aiGatewayDelegationRoutingJevFallback")} ${t("terminal.settings.aiGatewayDelegationRoutingJevSignIn")}`
      : !typesafeSignedIn
        ? t("terminal.settings.aiGatewayDelegationRoutingJevSignIn")
        : undefined;
  return (
    <SettingsGroup ariaLabel={t("terminal.settings.aiGatewayRouting")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <SettingToggleRow
        title={t("terminal.settings.aiGatewayRouting")}
        help={t("terminal.settings.aiGatewayRoutingHelp")}
        value={state.delegationRoutingEnabled}
        busy={routingSaving}
        onToggle={() => void setSystemPromptSettingsField("delegationRoutingEnabled", !state.delegationRoutingEnabled)}
      />
      {state.delegationRoutingEnabled ? (
        <>
          <SettingsItem
            label={t("terminal.settings.aiGatewayDelegationRoutingMode")}
            labelId="delegation-routing-mode-label"
            hint={modeHint}
            helpTip={(
              <SettingsHelp title={t("terminal.settings.aiGatewayDelegationRoutingMode")}>
                <p>{t("terminal.settings.aiGatewayDelegationRoutingModeHelp")}</p>
              </SettingsHelp>
            )}
          >
            <SettingsSegments
              ariaLabelledBy="delegation-routing-mode-label"
              value={jevStored ? "jev" : mode}
              disabled={modeSaving}
              options={[
                { value: "jev", label: t("terminal.settings.aiGatewayDelegationRoutingJev"), disabled: !typesafeSignedIn },
                { value: "model", label: t("terminal.settings.aiGatewayRoutingModel") },
              ] as const}
              onChange={saveMode}
            />
          </SettingsItem>
          {mode === "model" ? (
            <SettingsItem label={t("terminal.settings.aiGatewayRoutingModel")} labelId="routing-model-label" hint={lines("terminal.settings.aiGatewayRoutingModelNotice")}>
              {/* 다른 화면과 같은 강도 게이지. 고르지 않으면 저장하지 않고, 실행은 low(없으면 가장 낮은 단)다. */}
              <ModelCoordinatePicker
                roster={routingRoster}
                value={routingValue}
                fallback={routingFallback}
                effort="track"
                disabled={saving.has("delegationRoutingModel") || saving.has("delegationRoutingEffort")}
                onChange={(next) => { saveRoutingCoordinate(state.delegationRoutingModel, state.delegationRoutingEffort, next); }}
                labels={routingPickerLabels}
                trigger={{ variant: "field", className: "ai-gateway-field-trigger", ...(routingPickerText ? { text: routingPickerText } : {}) }}
              />
            </SettingsItem>
          ) : null}
          {/* 테스트는 사용량이 드는 실제 요청이라 펼쳐야 보낸다. 폰은 하위 화면으로 연다. */}
          {mobileHost ? (
            <SettingsSubScreenRow
              label={t("terminal.settings.routingTest")}
              summary={t("terminal.settings.routingTestUsage")}
              render={() => <RoutingTestPanel />}
            />
          ) : (
            <div className={`global-settings-row is-stack ai-gateway-routing-test-row${testOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="ai-gateway-routing-test-toggle"
                aria-expanded={testOpen}
                aria-controls={testOpen ? testPanelId : undefined}
                onClick={() => setTestOpen((open) => !open)}
              >
                <span className="global-settings-row-text">
                  <span className="global-settings-resp-title">{t("terminal.settings.routingTest")}</span>
                  <span className="global-settings-help">{t("terminal.settings.routingTestHint")}</span>
                </span>
                <span className="ai-gateway-glyph ai-gateway-model-chevron" aria-hidden="true">{testOpen ? "▾" : "▸"}</span>
              </button>
              {testOpen ? <div id={testPanelId}><RoutingTestPanel /></div> : null}
            </div>
          )}
        </>
      ) : null}
    </SettingsGroup>
  );
}

/**
 * 트리거가 말하는 강도. 저장값이 그 모델 사다리에 있으면 그대로, 없으면 실행과 같이 사다리 안으로 맞춘다.
 * 저장값이 없으면 low(사다리에 없으면 첫 단). 사다리가 없으면 생략한다 — host/routing-model.ts와 같다.
 */
function routingJudgeEffort(roster: ModelRoster | null, model: string, stored: string | null): string | undefined {
  const ladder = rosterRowEfforts(findRosterRow(roster, model));
  if (ladder.length === 0) return undefined;
  return clampRosterEffort(ladder, stored && isAgentEffort(stored) ? stored : "low");
}

/** 선택기가 확정한 모델과 강도를 각각 저장한다. 강도 없는 모델은 저장 강도를 지워 기본 규칙으로 되돌린다. */
function saveRoutingCoordinate(
  model: string | null,
  effort: string | null,
  next: { readonly model?: string; readonly effort?: string },
): void {
  if (!next.model) return;
  if (next.model !== model) void setSystemPromptSettingsField("delegationRoutingModel", next.model);
  const chosen = next.effort && isAgentEffort(next.effort) ? next.effort : null;
  if (chosen !== effort) void setSystemPromptSettingsField("delegationRoutingEffort", chosen);
}

function withEffort(effort: string | undefined): { readonly effort?: string } {
  return effort ? { effort } : {};
}

/** 라우팅 테스트의 자리 — 데스크톱 펼침 행과 폰 하위 화면이 같은 패널을 쓴다. 스토어에서 지금 방식과 후보를 다시 읽는다. */
function RoutingTestPanel() {
  const settings = useSystemPromptSettingsStore();
  const auth = useModelAuthStore();
  // 폰에서는 이 패널이 하위 화면으로 따로 마운트되고 라우팅 카드는 내려가며 자기 인증 요청을 끊는다 — 인증 상태가 아직
  // 없으면 패널이 직접 불러온다. 카드가 이미 불러 둔 데스크톱 펼침에서는 요청하지 않는다.
  const authLoaded = auth.state !== null;
  React.useEffect(() => {
    if (authLoaded) return undefined;
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, [authLoaded]);
  const state = settings.state;
  if (!state) return null;
  const typesafeSignedIn = auth.state?.providers.some(entry => entry.provider === "typesafe" && entry.signedIn) === true;
  const mode = state.delegationRoutingMode;
  const delegable = (state.aiGateway?.models ?? []).filter((entry) => {
    const provider = state.aiGatewayCatalog.providers.find((group) => group.models.some((model) => model.id === entry.id));
    const status = provider ? state.aiGatewayLogin[provider.id] : null;
    return isProviderCatalogVisible(status, provider?.id);
  }).length;
  return (
    <RoutingTest
      key={`${mode}:${state.delegationRoutingModel ?? ROSTER_FALLBACK_MODEL}`}
      mode={mode}
      disabled={settings.savingFields.has("delegationRoutingMode") || delegable === 0 || (mode === "jev" && !typesafeSignedIn)}
    />
  );
}

type RoutingTestPreset = "Light" | "Medium" | "Heavy";

function RoutingTest({ mode, disabled }: { readonly mode: DelegationRoutingMode; readonly disabled: boolean }) {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const [prompt, setPrompt] = React.useState("");
  const [preset, setPreset] = React.useState<RoutingTestPreset | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ model?: string; label?: string; effort?: string; elapsedMs: number; fallback: boolean; because: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const active = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => active.current?.abort(), []);
  const run = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(null); setResult(null);
    try {
      const response = await fetch("/api/v1/ai-gateway/routing-test", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }), signal: controller.signal,
      });
      // 게이트웨이는 장애를 JSON이 아닌 텍스트(예: 502 "Bad gateway")로 돌려줄 수 있다 —
      // response.json()은 그 본문에서 SyntaxError를 내고 상태·본문을 삼킨다. 텍스트로
      // 읽어 JSON이면 파싱하고, 아니면 상태와 본문을 그대로 보여 준다.
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.trim().slice(0, 200)}`);
      }
      const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      if (!response.ok) throw new Error(record.error === "routing_disabled_or_no_candidates" ? t("terminal.settings.aiGatewayRoutingNoCandidates") : typeof record.error === "string" ? record.error : `HTTP ${response.status}`);
      if (!controller.signal.aborted) setResult(data as { model?: string; label?: string; effort?: string; elapsedMs: number; fallback: boolean; because: string });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (active.current === controller) active.current = null;
    }
  };
  return <section className="ai-gateway-routing-test" aria-label={`${t("terminal.settings.routingTest")} · ${mode === "jev" ? "Jev" : t("terminal.settings.aiGatewayRoutingModel")}`}>
    <div className="ai-gateway-routing-presets" role="group" aria-label={t("terminal.settings.routingTestPresets")}>
      <span className="ai-gateway-routing-presets-label" aria-hidden="true">{t("terminal.settings.routingTestPresets")}</span>
      {(["Light", "Medium", "Heavy"] as const).map(level => (
        <button key={level} type="button" className="ai-gateway-chip-button" aria-pressed={preset === level} disabled={busy}
          onClick={() => { setPrompt(t(`terminal.settings.routingTest${level}Prompt`)); setPreset(level); setResult(null); setError(null); }}>
          {t(`terminal.settings.routingTest${level}`)}
        </button>
      ))}
    </div>
    <SyncedTextarea className="ai-gateway-routing-task" aria-label={t("terminal.settings.routingTestTask")} rows={3} maxLength={65536}
      value={prompt} disabled={busy}
      placeholder={t("terminal.settings.routingTestTask")} onChange={event => { setPrompt(event.target.value); setPreset(null); setResult(null); }} />
    {/* 사용량이 드는 요청은 이 버튼 하나뿐이다 — 예시 칩과 같은 모양이면 무엇이 요청을 보내는지 가려지지 않는다. */}
    <div className="ai-gateway-routing-foot">
      <p className="ai-gateway-routing-cost">{t("terminal.settings.routingTestHelp")}</p>
      <button type="button" className="ai-gateway-run-button" disabled={disabled || busy || !prompt.trim()} onClick={() => void run()}>
        {busy ? t("terminal.settings.routingTestRunning") : t("terminal.settings.routingTestRun")}
      </button>
    </div>
    {error ? <p className="global-settings-error" role="alert">{error}</p> : null}
    {result ? <div role="status" className="ai-gateway-routing-result">
      <p className="ai-gateway-routing-result-head">{result.fallback ? t("terminal.settings.routingTestFallback") : t("terminal.settings.routingTestSuccess")}</p>
      <dl>
        <dt>{t("terminal.settings.routingTestAssignedModel")}</dt>
        <dd>{result.label ?? t("terminal.settings.routingTestNoAssignment")}</dd>
        {result.effort ? <><dt>{t("terminal.settings.routingTestAssignedEffort")}</dt><dd>{result.effort}</dd></> : null}
        <dt>{t("terminal.settings.routingTestDuration")}</dt>
        <dd>{result.elapsedMs} ms</dd>
      </dl>
      {result.fallback ? <p className="ai-gateway-routing-because">{result.because}</p> : null}
    </div> : null}
  </section>;
}

function AiGatewayDiagnosticsCard() {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields;

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayDiagnostics")}>
        <p className="global-settings-resp-title">{t("terminal.settings.aiGatewayDiagnostics")}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  return (
    <SettingsGroup ariaLabel={t("terminal.settings.aiGatewayDiagnostics")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <SettingToggleRow
        title={t("terminal.settings.aiGatewayWireLog")}
        help={t("terminal.settings.aiGatewayWireLogHelp")}
        value={state.wireLogEnabled}
        busy={saving.has("wireLogEnabled")}
        onToggle={() => void setSystemPromptSettingsField("wireLogEnabled", !state.wireLogEnabled)}
      />
    </SettingsGroup>
  );
}

function SettingsHelp({ title, id, children }: {
  readonly title: string;
  readonly id?: string;
  readonly children: React.ReactNode;
}) {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  return (
    <SettingsHelpTip ariaLabel={t("terminal.settings.helpTipAria", { title })} id={id}>
      {children}
    </SettingsHelpTip>
  );
}
function useLoadSystemPromptSettings() {
  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);
}
function SettingToggleRow({ title, help, value, busy, onToggle }: SettingToggleRowProps) {
  return (
    <SettingsItem label={title} helpTip={<SettingsHelp title={title}>{help}</SettingsHelp>}>
      {/* 켬/끔은 콘솔 전체에서 SDK 스위치 한 모양이다 — 예전의 "Off" 글자 버튼은 스타일 없는 세 번째 문법이었다. */}
      <SettingsToggle
        checked={value}
        busy={busy}
        ariaLabel={title}
        onChange={onToggle}
      />
    </SettingsItem>
  );
}

interface SettingToggleRowProps { readonly title: string; readonly help: string; readonly value: boolean; readonly busy: boolean; readonly onToggle: () => void }
