import { AiGatewayModelsCard as GatewayModelsCard, AiGatewayModelsEntry as GatewayModelsEntry } from "./gateway-models-card.js";
import { AiGatewayCandidatesCard } from "./gateway-candidates-card.js";
import { launchProviderGlyph, serviceGlyph } from "./components/launch-provider-glyphs.js";
import * as React from "react";
import { SegmentedThumb } from "@fleet-console/ui/react";
import { Select } from "../../settings/client/mobile-host.js";
import { SettingsCheckbox, SettingsGroup, SettingsHelpTip, SettingsInputRow, SettingsItem, SettingsSegments, SettingsToggle, defineSettingsSection } from "../../settings/client/preferences-context.js";
import { useMobileSettingsHost } from "../../settings/client/mobile-host.js";
import { getT, useTerminalLocale } from "../../execution/client/agent/i18n/index.js";
import { getSystemPromptSettingsStoreState, loadSystemPromptSettings, setSystemPromptSettingsField, subscribe as subscribeSystemPromptSettings, useSystemPromptSettingsStore, type AiGatewayCatalogModel, type AiGatewayCatalogProvider, type AiGatewayProviderId, type AiGatewaySettings, type CompactCeiling } from "../../settings/client/execution-settings.js";
import { ModelCoordinatePicker, type ModelCoordinatePickerLabels } from "./components/model-coordinate-picker.js";
import { findRosterRow, rosterRows } from "../shared/models.js";
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
      getT(locale)("terminal.settings.aiGatewayDiagnostics"),
      getT(locale)("terminal.settings.aiGatewayWireLog"),
    ].join(" "),
    "gateway provider model api key codex xai delegation subagent workflow diagnostics wire log compact",
    "게이트웨이 공급자 모델 키 배정 위임 서브에이전트 워크플로 진단 와이어 로그 압축",
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
  return <>{mobile ? <GatewayModelsEntry /> : <GatewayModelsCard />}<AiGatewayCandidatesCard /><AiGatewayCompactTimingCard /><AiGatewayDiagnosticsCard /></>;
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
