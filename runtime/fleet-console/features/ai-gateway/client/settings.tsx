import { launchProviderGlyph, serviceGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";
import { React } from "@fleet-console/sdk/plugin/browser";
import { SegmentedThumb, Select } from "@fleet-console/sdk/react/browser";
import { ModelPicker, SettingsHelpTip, SettingsToggle, defineSettingsSection } from "@fleet-console/sdk/settings/browser";
import { getT, useTerminalLocale, type TerminalMessageKey } from "../../execution/client/agent/i18n/index.js";
import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore, type AiGatewayCapabilityClass, type AiGatewayCatalogModel, type AiGatewayCatalogProvider, type AiGatewayProviderId, type AiGatewaySettings, type CompactCeiling } from "../../settings/client/execution-settings.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore, type ModelAuthProviderState } from "./model-auth.js";
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
    "gateway provider model api key codex cursor opencode xai kimi routing delegation subagent workflow diagnostics wire log compact",
    "게이트웨이 공급자 모델 키 라우팅 배정 위임 서브에이전트 워크플로 진단 와이어 로그 압축",
  ],
  render: () => <AiGatewaySection />,
});

function AiGatewaySection() {
  useLoadSystemPromptSettings();
  return <><AiGatewayModelsCard /><AiGatewayRoutingCard /><AiGatewayCompactTimingCard /><AiGatewayDiagnosticsCard /></>;
}
const AI_GATEWAY_PROVIDER_LABEL_KEYS = {
  antigravity: "terminal.settings.aiGatewayProviderAntigravity",
  codex: "terminal.settings.aiGatewayProviderCodex",
  cursor: "terminal.settings.aiGatewayProviderCursor",
  kimi: "terminal.settings.aiGatewayProviderKimi",
  opencode: "terminal.settings.aiGatewayProviderOpencode",
  xai: "terminal.settings.aiGatewayProviderXai",
} as const;

/**
 * API key로 연결하는 공급자. 어느 공급자가 키를 요구하는지는 서버(model-auth 상태)가 권위이고,
 * 이 목록은 그 응답이 오기 전 첫 렌더가 같은 답을 내게 하는 기본값이다.
 */
const AI_GATEWAY_KEY_PROVIDER_IDS: ReadonlySet<string> = new Set(["kimi", "opencode"]);

/**
 * 공급자 표시 순서: 구독·CLI 로그인 공급자가 카탈로그 순서 그대로 먼저, API key 공급자가 뒤에
 * (OpenCode Go, Kimi). 프로바이더 카드와 팔레트 묶음이 같은 순서를 쓴다.
 */
export function orderAiGatewayProviders<T extends { readonly id: string }>(providers: readonly T[]): T[] {
  const keyOrder = ["opencode", "kimi"];
  const subscription = providers.filter((provider) => !AI_GATEWAY_KEY_PROVIDER_IDS.has(provider.id));
  const apiKey = providers
    .filter((provider) => AI_GATEWAY_KEY_PROVIDER_IDS.has(provider.id))
    .sort((a, b) => keyOrder.indexOf(a.id) - keyOrder.indexOf(b.id));
  return [...subscription, ...apiKey];
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

export function compactPercentFromTrackRatio(ratio: number): number {
  const next = COMPACT_CEILING_CUSTOM_MIN
    + ratio * (COMPACT_CEILING_CUSTOM_MAX - COMPACT_CEILING_CUSTOM_MIN);
  return Math.min(
    COMPACT_CEILING_CUSTOM_MAX,
    Math.max(COMPACT_CEILING_CUSTOM_MIN, Math.round(next)),
  );
}

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  return `${Math.round(n / 1000)}K`;
}

function AiGatewayCompactTimingCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields.has("compactCeiling");
  const [previewId, setPreviewId] = React.useState<string>("");
  const [dragPercent, setDragPercent] = React.useState<number | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);
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
  const previewModels = state.aiGatewayCatalog.providers.flatMap((provider) => provider.models
    .filter((model) => typeof model.contextWindow === "number" && model.contextWindow > 0)
    .map((model) => ({ ...model, provider: provider.id })));
  const preview = previewModels.find((model) => model.id === previewId) ?? previewModels[0];
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

  const setCustomFromClientX = (clientX: number): void => {
    const bar = trackRef.current?.getBoundingClientRect();
    if (!bar || bar.width <= 0) return;
    const next = compactPercentFromTrackRatio((clientX - bar.left) / bar.width);
    dragPercentRef.current = next;
    setDragPercent(next);
  };

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.compactTiming")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            <span id="compact-timing-label">{t("terminal.settings.compactTiming")}</span>
            <SettingsHelp title={t("terminal.settings.compactTiming")}>
              <p>{t("terminal.settings.compactTimingHelp")}</p>
            </SettingsHelp>
          </p>
        </div>
        <div className="segmented" role="group" aria-labelledby="compact-timing-label">
          <SegmentedThumb />
          <button type="button" className={`segmented-option${policy === "auto" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("auto")}>
            {t("terminal.settings.compactTimingAuto")}
          </button>
          <button type="button" className={`segmented-option${policy === "early" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("early")}>
            {t("terminal.settings.compactTimingEarly")}
          </button>
          <button type="button" className={`segmented-option${policy === "late" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("late")}>
            {t("terminal.settings.compactTimingLate")}
          </button>
          <button type="button" className={`segmented-option${policy === "custom" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("custom")}>
            {t("terminal.settings.compactTimingCustom")}
          </button>
        </div>
      </div>
      {previewModels.length > 0 ? (
        <div className="global-settings-row">
          <div className="global-settings-row-text">
            <p className="global-settings-resp-title">
              {/* id는 제목 글자만 감싼 span이 진다 — 팁 버튼이 제목 안에 서면 그 접근성 이름까지 선택기 이름에 딸려 들어간다. */}
              <span id="compact-timing-preview-label">{t("terminal.settings.compactTimingPreview")}</span>
              <SettingsHelp title={t("terminal.settings.compactTimingPreview")}>{t("terminal.settings.compactTimingPreviewHelp")}</SettingsHelp>
            </p>
          </div>
          <ModelPicker
            value={preview?.id ?? ""}
            options={previewModels.map((model) => ({ id: model.id, label: model.name, provider: model.provider, contextWindow: model.contextWindow }))}
            aria-labelledby="compact-timing-preview-label"
            onChange={(id) => setPreviewId(id)}
          />
        </div>
      ) : null}
      <div className="compact-timing-track-wrap">
        <div
          ref={trackRef}
          className={`compact-timing-track${policy === "custom" && !saving ? " is-live" : ""}${crowded ? " is-warn" : ""}`}
          onPointerDown={(event) => {
            if (policy !== "custom" || saving) return;
            draggingRef.current = true;
            (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
            setCustomFromClientX(event.clientX);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            setCustomFromClientX(event.clientX);
          }}
          onPointerUp={() => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            const next = dragPercentRef.current;
            dragPercentRef.current = null;
            setDragPercent(null);
            if (next !== null) saveCustom(next);
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
            dragPercentRef.current = null;
            setDragPercent(null);
          }}
        >
          <div className="compact-timing-bar">
            <div className="compact-timing-fill" style={{ width: `${trackFill}%` }} />
          </div>
          <div className="compact-timing-thumb" style={{ left: `${trackFill}%` }} />
          <input
            className="compact-timing-sr"
            type="range"
            min={COMPACT_CEILING_CUSTOM_MIN}
            max={COMPACT_CEILING_CUSTOM_MAX}
            step={1}
            value={typeof liveCeiling === "number" ? liveCeiling : shownPercent}
            disabled={policy !== "custom" || saving}
            aria-label={t("terminal.settings.compactTimingCustomAria")}
            onChange={(event) => saveCustom(Number(event.target.value))}
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
    </section>
  );
}

/**
 * 배정 카드. 모델 카드 바로 아래에 놓는다 — 여기서 켜는 것은 그 위에서 노출한 모델을
 * 쓰는 방식이고, 노출을 정하기 전에 배정을 묻는 순서는 읽는 사람에게 거꾸로다.
 */
function AiGatewayRoutingCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields;

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayRouting")}>
        <p className="global-settings-resp-title">{t("terminal.settings.aiGatewayRouting")}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayRouting")}>
      <p className="global-settings-resp-title">
        {t("terminal.settings.aiGatewayRouting")}
        <SettingsHelp title={t("terminal.settings.aiGatewayRouting")}>
          <p>{t("terminal.settings.aiGatewayRoutingHelp")}</p>
        </SettingsHelp>
      </p>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <SettingToggleRow
        title={t("terminal.settings.aiGatewayDelegationRouting")}
        help={t("terminal.settings.aiGatewayDelegationRoutingHelp")}
        value={state.delegationRoutingEnabled}
        disabled={saving.has("delegationRoutingEnabled")}
        onToggle={() => void setSystemPromptSettingsField(
          "delegationRoutingEnabled",
          !state.delegationRoutingEnabled,
        )}
      />
    </section>
  );
}

function AiGatewayDiagnosticsCard() {
  const t = getT(useTerminalLocale());
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
    <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayDiagnostics")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <SettingToggleRow
        title={t("terminal.settings.aiGatewayDiagnostics")}
        help={t("terminal.settings.aiGatewayDiagnosticsHelp")}
        value={state.cursorDiagnosticsEnabled}
        disabled={saving.has("cursorDiagnosticsEnabled")}
        onToggle={() => void setSystemPromptSettingsField(
          "cursorDiagnosticsEnabled",
          !state.cursorDiagnosticsEnabled,
        )}
      />
      <SettingToggleRow
        title={t("terminal.settings.aiGatewayWireLog")}
        help={t("terminal.settings.aiGatewayWireLogHelp")}
        value={state.wireLogEnabled}
        disabled={saving.has("wireLogEnabled")}
        onToggle={() => void setSystemPromptSettingsField("wireLogEnabled", !state.wireLogEnabled)}
      />
    </section>
  );
}

/**
 * 켜진 모델 한 줄. 로스터는 공급자 묶음 아래에 모델을 들여 쓰므로 공급자 정체성은 묶음
 * 머리글이 지고, 줄은 등급 → 이름·속성 → 조작만 말한다.
 */
interface AiGatewayRosterEntry {
  readonly provider: AiGatewayCatalogProvider;
  readonly model: AiGatewayCatalogModel;
  readonly efforts: readonly string[] | undefined;
  readonly hostOnly: boolean;
  /** 우선 소진 순서에서의 0-기준 자리. 순서 밖이면 -1. */
  readonly rank: number;
}

/** 한 공급자의 켠 모델 묶음. 순위 셀렉트와 xAI 엔드포인트는 이 머리글에 선다. */
interface AiGatewayRosterGroup {
  readonly provider: AiGatewayCatalogProvider;
  readonly rank: number;
  readonly entries: readonly AiGatewayRosterEntry[];
}

/** 정렬된 로스터를 공급자 묶음으로 접는다 — 정렬이 공급자를 연속으로 두므로 한 번 훑으면 된다. */
export function groupAiGatewayRoster(entries: readonly AiGatewayRosterEntry[]): AiGatewayRosterGroup[] {
  const groups: { provider: AiGatewayCatalogProvider; rank: number; entries: AiGatewayRosterEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.provider === entry.provider) last.entries.push(entry);
    else groups.push({ provider: entry.provider, rank: entry.rank, entries: [entry] });
  }
  return groups;
}

/**
 * 로스터 정렬: 우선 소진 공급자가 순위대로 먼저, 나머지는 카탈로그 순, 같은 공급자 안에서는
 * 켠 순서. 순위를 바꾸면 줄이 자리를 옮기지만 그것이 곧 순위의 의미라 위치 기억과 충돌하지 않는다.
 */
export function buildAiGatewayRoster(
  providers: readonly AiGatewayCatalogProvider[],
  selection: AiGatewaySettings,
  priority: readonly AiGatewayProviderId[],
): AiGatewayRosterEntry[] {
  const entries = (selection.models ?? []).flatMap((entry, order) => {
    for (const provider of providers) {
      const model = provider.models.find((candidate) => candidate.id === entry.id);
      if (model) {
        return [{
          provider,
          model,
          efforts: entry.efforts,
          hostOnly: entry.hostOnly === true,
          rank: priority.indexOf(provider.id as AiGatewayProviderId),
          order,
        }];
      }
    }
    return [];
  });
  const providerOrder = (id: string): number => providers.findIndex((provider) => provider.id === id);
  return entries
    .sort((a, b) => {
      const rankA = a.rank < 0 ? Number.MAX_SAFE_INTEGER : a.rank;
      const rankB = b.rank < 0 ? Number.MAX_SAFE_INTEGER : b.rank;
      return rankA - rankB
        || providerOrder(a.provider.id) - providerOrder(b.provider.id)
        || a.order - b.order;
    })
    .map(({ order: _order, ...entry }) => entry);
}

function AiGatewayModelsCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const auth = useModelAuthStore();
  const state = settings.state;
  const saving = settings.savingFields.has("aiGateway");
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);
  // 닫힐 때 포커스는 연 버튼으로 돌아온다 — 팔레트 안에 있던 포커스가 문서 바닥으로 떨어지면
  // 키보드 사용자는 다음 Tab이 어디서 시작할지 알 수 없다.
  const closePalette = React.useCallback(() => {
    setPaletteOpen(false);
    addButtonRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);

  // 팔레트가 계열 묶기를 이 배열의 정체성으로 메모하므로 렌더마다 새 배열을 만들지 않는다.
  const catalogProviders = state?.aiGatewayCatalog.providers;
  const providers = React.useMemo(
    () => (catalogProviders ? orderAiGatewayProviders(catalogProviders) : []),
    [catalogProviders],
  );

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayModels")}>
        <p className="global-settings-resp-title">{t("terminal.settings.aiGatewayModels")}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  const selection = state.aiGateway ?? {};
  const enabled = selection.models ?? [];
  // 순위는 켠 공급자에 대한 선호다 — 로드아웃이 켠 모델 없는 공급자를 거르고 다시 번호를 매기므로,
  // 화면도 같은 순위를 읽는다. 예전 저장값에 남은 빈 공급자는 다음 순위 저장에서 함께 정리된다.
  const enabledProviderIds = new Set(
    providers.filter((provider) => provider.models.some((model) => enabled.some((entry) => entry.id === model.id))).map((provider) => provider.id),
  );
  const priority = (selection.providerPriority ?? []).filter(
    (id): id is AiGatewayProviderId => id in AI_GATEWAY_PROVIDER_LABEL_KEYS && enabledProviderIds.has(id),
  );

  const save = (next: AiGatewaySettings): void => {
    const models = next.models ?? [];
    // 우선순위는 이 저장에 싣지 않는다 — 키 부재를 서버가 "보존"으로 읽으므로, 다른
    // 호스트가 그 사이 바꾼 소진 순서를 모델 편집이 스테일 스냅숏으로 덮지 않는다.
    // 우선순위를 싣는 경로는 순위 셀렉트(savePriority)와, 순위가 실제로 바뀌는 제거뿐이다.
    const normalized = models.length === 0 ? null : { models };
    void setSystemPromptSettingsField("aiGateway", normalized);
  };

  const savePriority = (nextPriority: readonly AiGatewayProviderId[]): void => {
    // 전체-값 PUT 계약상 우선순위만 보내면 모델 선택이 지워진다 — 현재 스냅숏을 함께
    // 싣는다. 빈 배열은 명시 해제의 유일한 철자이고, 해제할 것도 없는 전량 공백만 null.
    const value: AiGatewaySettings = {
      ...(enabled.length > 0 ? { models: enabled } : {}),
      providerPriority: nextPriority,
    };
    const nothingElse = enabled.length === 0;
    const normalized = nothingElse && nextPriority.length === 0 && priority.length === 0 ? null : value;
    void setSystemPromptSettingsField("aiGateway", normalized);
  };

  const addModel = (model: AiGatewayCatalogModel): void => {
    if (enabled.some((entry) => entry.id === model.id)) return;
    save({ ...selection, models: [...enabled, { id: model.id }] });
  };
  const removeModel = (id: string): void => {
    const next = composeAiGatewayRemoval(selection, id, providers);
    // 마지막 모델이 빠져 순위가 실제로 바뀐 그 한 번만 순위를 함께 싣는다 — 로드아웃은 이미
    // 켠 모델 없는 공급자를 거르므로, 저장값과 화면을 그 사실에 맞추는 것이다.
    if ((next.providerPriority ?? []).length !== (selection.providerPriority ?? []).length) {
      const models = next.models ?? [];
      void setSystemPromptSettingsField(
        "aiGateway",
        models.length === 0 ? null : { models, providerPriority: next.providerPriority ?? [] },
      );
      return;
    }
    save(next);
  };
  // 사다리 전체는 부재로 접어 저장한다 — 저장형이 하나여야 "전체 노출"이 두 가지
  // 철자를 갖지 않는다. 마지막 한 단계는 UI가 끄지 못하게 막지만, 여기서도 지킨다.
  const setModelEfforts = (model: AiGatewayCatalogModel, efforts: readonly string[]): void => {
    const ladder = model.effort?.levels ?? [];
    const ordered = ladder.filter((level) => efforts.includes(level));
    if (ordered.length === 0) return;
    save({
      ...selection,
      models: enabled.map((entry) => entry.id !== model.id
        ? entry
        : {
          id: entry.id,
          ...(ordered.length === ladder.length ? {} : { efforts: ordered }),
          ...(entry.hostOnly === true ? { hostOnly: true } : {}),
        }),
    });
  };
  const setModelHostOnly = (model: AiGatewayCatalogModel, next: boolean): void => {
    save({
      ...selection,
      models: enabled.map((entry) => {
        if (entry.id !== model.id) return entry;
        const { hostOnly: _hostOnly, ...rest } = entry;
        return next ? { ...rest, hostOnly: true } : rest;
      }),
    });
  };

  const roster = buildAiGatewayRoster(providers, selection, priority);
  const groups = groupAiGatewayRoster(roster);
  const providerCount = groups.length;
  const authOf = (id: string): ModelAuthProviderState | undefined =>
    auth.state?.providers.find((entry) => entry.provider === id);
  // 카탈로그 밖 서비스 자격증명. 팔레트는 전부(로그인 자리로), 로스터는 로그인된 것만 세운다.
  const services = auth.state?.providers.filter((entry) => entry.kind === "service") ?? [];
  const signedInServices = services.filter((entry) => entry.signedIn);

  // 선택지는 켠 공급자 수까지만이다. 이미 순위에 있는 공급자는 자기 자리를 옮길 뿐이라 칸 수가
  // 늘지 않는다 — 한 칸 더 주면 placeAiGatewayPriority가 끝으로 접어 고른 숫자와 결과가 어긋난다.
  const rankOptionsFor = (providerId: string) => {
    const slots = priority.includes(providerId as AiGatewayProviderId) ? priority.length : priority.length + 1;
    return [
      { value: "", label: t("terminal.settings.aiGatewayPriorityNone") },
      ...Array.from({ length: Math.min(slots, groups.length) }, (_, index) => ({
        value: String(index),
        label: t("terminal.settings.aiGatewayPriorityRank", { rank: index + 1 }),
      })),
    ];
  };
  const rankProvider = (providerId: AiGatewayProviderId, rank: number | null): void => {
    savePriority(placeAiGatewayPriority(priority, providerId, rank));
  };

  return (
    <>
      <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayModels")}>
        <div className="agent-cli-head">
          <p className="global-settings-resp-title">
            {t("terminal.settings.aiGatewayModels")}
            <SettingsHelp title={t("terminal.settings.aiGatewayModels")}>
              <p>{t("terminal.settings.aiGatewayModelsHelp")}</p>
            </SettingsHelp>
          </p>
        </div>
        {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
        {auth.error ? <p className="global-settings-error" role="alert">{auth.error}</p> : null}
        <div className="ai-gateway-stack">
        <div className="ai-gateway-roster-head">
          <div className="ai-gateway-palette-anchor">
            <button
              ref={addButtonRef}
              type="button"
              className="ai-gateway-add-button"
              aria-haspopup="dialog"
              aria-expanded={paletteOpen}
              // 저장 중에도 잠그지 않는다 — 팔레트를 여는 것뿐이고, 추가가 저장을 시작하며 닫힐 때
              // 포커스가 이 버튼으로 돌아와야 하는데 잠긴 버튼은 포커스를 받지 못한다.
              onClick={() => setPaletteOpen((open) => !open)}
            >
              {`+ ${t("terminal.settings.aiGatewayAddModel")}`}
            </button>
            {paletteOpen ? (
              <AiGatewayModelPalette
                providers={providers}
                services={services}
                selection={selection}
                authOf={authOf}
                authBusy={auth.busyProvider}
                saving={saving}
                onAdd={addModel}
                onClose={closePalette}
              />
            ) : null}
          </div>
          {roster.length > 0 ? (
            <span className="ai-gateway-roster-count">
              {t("terminal.settings.aiGatewayRosterCount", { models: roster.length, providers: providerCount })}
            </span>
          ) : null}
        </div>
        {roster.length === 0 && signedInServices.length === 0 ? (
          <p className="global-settings-help">{t("terminal.settings.aiGatewayAllExposed")}</p>
        ) : (
          <div className="ai-gateway-groups">
            {signedInServices.map((service) => (
              <AiGatewayServiceGroup key={service.provider} service={service} busy={auth.busyProvider === service.provider} />
            ))}
            {groups.map((group) => {
              const providerId = group.provider.id as AiGatewayProviderId;
              return (
                <section
                  key={group.provider.id}
                  className={`ai-gateway-provider-group ai-gateway-provider is-${group.provider.id}${group.rank >= 0 ? " is-ranked" : ""}`}
                  aria-label={t(AI_GATEWAY_PROVIDER_LABEL_KEYS[providerId])}
                >
                  <div className="ai-gateway-group-head">
                    <span className="ai-gateway-provider-glyph" aria-hidden="true">{launchProviderGlyph(providerId)}</span>
                    <span className="ai-gateway-provider-name">{t(AI_GATEWAY_PROVIDER_LABEL_KEYS[providerId])}</span>
                    <span className="ai-gateway-chip">{t("terminal.settings.aiGatewayModelCount", { count: group.entries.length })}</span>
                    <span className="ai-gateway-group-controls">
                      {group.provider.id === "xai" ? <AiGatewayXaiEndpointRow saving={settings.savingFields.has("xaiEndpoint")} /> : null}
                      {/* 순위 셀렉트는 라벨과 함께 서고, hover·포커스에서 말풍선이 뜻을 말한다. 목록을 열면 말풍선은 물러난다. */}
                      <span className="ai-gateway-priority-wrap">
                        <span className="ai-gateway-field-label">{t("terminal.settings.aiGatewayPriority")}</span>
                        <Select
                          compact
                          className={group.rank >= 0 ? "ai-gateway-priority-select is-ranked" : "ai-gateway-priority-select"}
                          label={t("terminal.settings.aiGatewayPriorityAria", { provider: t(AI_GATEWAY_PROVIDER_LABEL_KEYS[providerId]) })}
                          value={group.rank >= 0 ? String(group.rank) : ""}
                          disabled={saving}
                          options={rankOptionsFor(group.provider.id)}
                          onChange={(value) => rankProvider(providerId, value === "" ? null : Number(value))}
                        />
                        <span className="ai-gateway-priority-tip" role="tooltip">{t("terminal.settings.aiGatewayPriorityTip")}</span>
                      </span>
                    </span>
                  </div>
                  <div className="ai-gateway-rows">
                    {group.entries.map((entry) => (
                      <AiGatewayModelRow
                        key={entry.model.id}
                        entry={entry}
                        saving={saving}
                        onRemove={() => removeModel(entry.model.id)}
                        onSetEfforts={(next) => setModelEfforts(entry.model, next)}
                        onToggleHostOnly={() => setModelHostOnly(entry.model, !entry.hostOnly)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        </div>
      </section>
    </>
  );
}

/**
 * 로스터의 서비스 줄. 카탈로그 모델이 아니므로 순위·추론 강도·제거 손잡이를 갖지 않고,
 * 왜 다르게 생겼는지는 hover·포커스에서 뜨는 말풍선이 말한다. 이름을 보여 주는 것이
 * 목적이지 고르게 하는 것이 아니다 — 고를 수 있게 만들면 대화 모델로 오인된다.
 */
function AiGatewayServiceGroup({ service, busy }: {
  readonly service: ModelAuthProviderState;
  readonly busy: boolean;
}) {
  const t = getT(useTerminalLocale());
  return (
    <section
      className="ai-gateway-provider-group ai-gateway-provider is-typesafe ai-gateway-service-group"
      aria-label={service.displayName}
    >
      <div className="ai-gateway-group-head">
        <span className="ai-gateway-provider-glyph" aria-hidden="true">{serviceGlyph("typesafe")}</span>
        <span className="ai-gateway-provider-name">{service.displayName}</span>
        <span className="ai-gateway-service-wrap">
          <span className="ai-gateway-chip is-strong">{t("terminal.settings.aiGatewayServiceBadge")}</span>
          <span className="ai-gateway-service-tip" role="tooltip">{t("terminal.settings.aiGatewayServiceTip")}</span>
        </span>
        <span className="ai-gateway-group-controls">
          <button
            type="button"
            className="ai-gateway-key-signout"
            disabled={busy}
            aria-label={`${service.displayName} · ${t("terminal.auth.signOut")}`}
            onClick={() => void signOutModel(service.provider)}
          >
            {busy ? t("terminal.auth.working") : t("terminal.auth.signOut")}
          </button>
        </span>
      </div>
      <div className="ai-gateway-service-rows">
        {(service.models ?? []).map((model) => (
          <div className="ai-gateway-service-row" key={model.id} tabIndex={0}>
            <span className="ai-gateway-service-model">{model.name}</span>
            <code className="ai-gateway-service-id">{model.id}</code>
            <span className="ai-gateway-service-tip" role="tooltip">{t("terminal.settings.aiGatewayServiceModelTip")}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 컨텍스트 변형의 id 접미사 — `-524k`, `-1m`, `-256k`. 이름 쪽은 대소문자만 다르다. */
const AI_GATEWAY_CONTEXT_SUFFIX = /-(\d+[km])$/i;
const AI_GATEWAY_FAST_SUFFIX = /-fast$/i;
const AI_GATEWAY_BASE_CONTEXT = "base";

export interface AiGatewayModelVariant {
  readonly contextKey: string;
  /** 변형 줄의 칸 라벨 — `272K`, `272K Fast`. */
  readonly label: string;
  readonly fast: boolean;
  readonly model: AiGatewayCatalogModel;
}

/**
 * 팔레트의 한 선택지. 카탈로그는 같은 모델의 컨텍스트·속도 조합을 각각 한 항목으로 나열하므로
 * (Codex 24종 = 4 계열 × 3 컨텍스트 × 2 속도), 사용자가 실제로 고르는 결정 단위인 계열로
 * 접고 조합은 팔레트 바닥의 변형 줄이 진다.
 */
export interface AiGatewayModelFamily {
  readonly key: string;
  readonly name: string;
  /** 기준 변형의 등급. 팔레트는 이 등급으로 flagship → standard → light → 별칭 순으로 세운다. */
  readonly capabilityClass: AiGatewayCapabilityClass | null;
  /** 작은 창부터, 같은 창 안에서는 기본이 Fast보다 앞. */
  readonly variants: readonly AiGatewayModelVariant[];
}

/**
 * 카탈로그를 계열로 묶는다. id에서 `-fast`와 컨텍스트 접미사를 벗긴 줄기가 계열 키다.
 *
 * 접미사가 언제나 변형 쌍을 뜻하지는 않는다. `grok-composer-2.5-fast`는 카탈로그에 없는
 * `grok-composer-2.5`의 빠른 빌드가 아니라 그 자체가 모델 이름이고, Kimi의 `k3-256k`·`k3-1m`은
 * 접미사 없는 `k3`가 없다. 그래서 변형은 있는 조합만 기록하고, 계열 이름은 변형이 둘 이상일
 * 때만 접미사를 벗긴다 — 홀로 선 모델은 카탈로그 이름 그대로 나타난다.
 */
export function groupAiGatewayModelFamilies(
  models: readonly AiGatewayCatalogModel[],
): AiGatewayModelFamily[] {
  const groups = new Map<string, Array<Omit<AiGatewayModelVariant, "label">>>();
  for (const model of models) {
    const stem = model.id.replace(AI_GATEWAY_FAST_SUFFIX, "");
    const contextMatch = AI_GATEWAY_CONTEXT_SUFFIX.exec(stem);
    const key = contextMatch ? stem.slice(0, contextMatch.index) : stem;
    const variant = {
      contextKey: contextMatch?.[1] ? contextMatch[1].toLowerCase() : AI_GATEWAY_BASE_CONTEXT,
      fast: stem !== model.id,
      model,
    };
    const list = groups.get(key);
    if (list) list.push(variant);
    else groups.set(key, [variant]);
  }

  const windowOf = (variant: { readonly model: AiGatewayCatalogModel }): number =>
    variant.model.contextWindow ?? Number.MAX_SAFE_INTEGER;

  return [...groups.entries()].flatMap(([key, variants]) => {
    const ordered = [...variants].sort((a, b) =>
      windowOf(a) - windowOf(b) || Number(a.fast) - Number(b.fast));
    const reference = ordered[0];
    if (reference === undefined) return [];
    let name = reference.model.name;
    if (ordered.length > 1) {
      if (reference.fast) name = name.replace(AI_GATEWAY_FAST_SUFFIX, "");
      if (reference.contextKey !== AI_GATEWAY_BASE_CONTEXT) name = name.replace(AI_GATEWAY_CONTEXT_SUFFIX, "");
    }
    const labeled: AiGatewayModelVariant[] = ordered.map((variant) => {
      const context = formatAiGatewayContextWindow(variant.model.contextWindow) ?? variant.contextKey.toUpperCase();
      return { ...variant, label: variant.fast ? `${context} Fast` : context };
    });
    return [{ key, name, capabilityClass: reference.model.capabilityClass, variants: labeled }];
  }).sort((a, b) => AI_GATEWAY_CLASS_RANK[a.capabilityClass ?? "unclassed"] - AI_GATEWAY_CLASS_RANK[b.capabilityClass ?? "unclassed"]);
}

/** 팔레트 묶음 순서. 등급 배지의 잉크 서열과 같고, 등급 없는 라우팅 별칭은 서열 밖이라 맨 뒤다. */
const AI_GATEWAY_CLASS_RANK = { flagship: 0, standard: 1, light: 2, unclassed: 3 } as const;

/** 팔레트 항목 오른쪽의 한 줄 — 컨텍스트 창 범위와 Fast 유무. 강도 범위는 켠 뒤 로스터에서만 다룬다. */
function describeAiGatewayFamily(family: AiGatewayModelFamily, fastLabel: string): string {
  const windows = family.variants
    .filter((variant) => !variant.fast)
    .map((variant) => formatAiGatewayContextWindow(variant.model.contextWindow))
    .filter((label): label is string => label !== null);
  const distinct = windows.length > 0 ? windows : family.variants
    .map((variant) => formatAiGatewayContextWindow(variant.model.contextWindow))
    .filter((label): label is string => label !== null);
  const first = distinct[0];
  const last = distinct[distinct.length - 1];
  const context = first === undefined ? null : first === last ? first : `${first}–${last}`;
  const fast = family.variants.some((variant) => variant.fast) ? fastLabel.toLowerCase() : null;
  return [context, fast].filter((part): part is string => part !== null).join(" · ");
}

export function composeAiGatewayRemoval(
  selection: AiGatewaySettings,
  id: string,
  providers: readonly AiGatewayCatalogProvider[],
): AiGatewaySettings {
  const { models, providerPriority, ...rest } = selection;
  const remaining = (models ?? []).filter((entry) => entry.id !== id);
  // 그 공급자의 마지막 모델이 빠지면 순위에서도 지운다 — 뒤 순번은 배열 순서라 저절로 당겨진다.
  // 순위는 켠 공급자에 대한 선호이지 공급자의 속성이 아니라, 다시 켜도 되돌리지 않는다.
  const removedProvider = providers.find((provider) => provider.models.some((model) => model.id === id));
  const stillEnabled = removedProvider !== undefined
    && remaining.some((entry) => removedProvider.models.some((model) => model.id === entry.id));
  const dropped = removedProvider !== undefined && !stillEnabled
    && (providerPriority ?? []).includes(removedProvider.id as AiGatewayProviderId);
  return {
    ...rest,
    models: remaining,
    ...(dropped
      ? { providerPriority: (providerPriority ?? []).filter((entry) => entry !== removedProvider.id) }
      : providerPriority !== undefined ? { providerPriority } : {}),
  };
}

interface AiGatewayPaletteHit {
  readonly provider: AiGatewayCatalogProvider;
  readonly family: AiGatewayModelFamily;
}

/**
 * 검색어로 카탈로그를 거른다. 띄어 쓴 토큰을 모두 포함하는 항목만 남고, 공급자 id·이름과
 * 계열 이름을 한 문자열로 본다 — "cursor opus"가 한 공급자의 한 계열을 짚는다.
 */
export function filterAiGatewayPalette(
  entries: readonly AiGatewayPaletteHit[],
  query: string,
  providerLabel: (id: string) => string,
): AiGatewayPaletteHit[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return [...entries];
  return entries.filter(({ provider, family }) => {
    // 변형의 카탈로그 이름·id도 건더기다 — 계열로 접으면 "K3-256K"·"gpt-6-astra-1m" 같은 정확한
    // 이름이 계열 이름에서 사라지므로, 그 이름으로 찾는 사용자에게도 같은 계열이 걸려야 한다.
    const variants = family.variants.map((variant) => `${variant.model.name} ${variant.model.id}`).join(" ");
    const haystack = `${provider.id} ${providerLabel(provider.id)} ${family.name} ${variants}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

interface AiGatewayModelPaletteProps {
  readonly providers: readonly AiGatewayCatalogProvider[];
  /** 카탈로그 밖 서비스 자격증명 — 로그인 자리와 그 서비스가 여는 모델 이름을 이 목록이 진다. */
  readonly services: readonly ModelAuthProviderState[];
  readonly selection: AiGatewaySettings;
  readonly authOf: (id: string) => ModelAuthProviderState | undefined;
  readonly authBusy: string | null;
  readonly saving: boolean;
  readonly onAdd: (model: AiGatewayCatalogModel) => void;
  readonly onClose: () => void;
}

/** 팔레트 크기 — 폭과 목록 높이. 브라우저별 기억이라 사이드바 폭과 같은 localStorage에 둔다. */
interface AiGatewayPaletteSize {
  readonly width: number;
  readonly listHeight: number;
}

const AI_GATEWAY_PALETTE_SIZE_KEY = "fleet.terminal.aiGatewayPalette.size";
const AI_GATEWAY_PALETTE_DEFAULT_SIZE: AiGatewayPaletteSize = { width: 720, listHeight: 460 };
const AI_GATEWAY_PALETTE_MIN_SIZE: AiGatewayPaletteSize = { width: 380, listHeight: 240 };

function readAiGatewayPaletteSize(): AiGatewayPaletteSize {
  try {
    const raw = window.localStorage.getItem(AI_GATEWAY_PALETTE_SIZE_KEY);
    if (!raw) return AI_GATEWAY_PALETTE_DEFAULT_SIZE;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed !== null
      && typeof (parsed as { width?: unknown }).width === "number"
      && typeof (parsed as { listHeight?: unknown }).listHeight === "number"
    ) {
      const { width, listHeight } = parsed as AiGatewayPaletteSize;
      if (Number.isFinite(width) && Number.isFinite(listHeight)) return { width, listHeight };
    }
  } catch {
    // 손상된 값은 기본 크기로 돌아간다.
  }
  return AI_GATEWAY_PALETTE_DEFAULT_SIZE;
}

function writeAiGatewayPaletteSize(size: AiGatewayPaletteSize): void {
  try {
    window.localStorage.setItem(AI_GATEWAY_PALETTE_SIZE_KEY, JSON.stringify(size));
  } catch {
    // 저장 불가는 이번 세션의 크기만 잃는다.
  }
}

/** 크기를 앵커 폭과 뷰포트 안쪽으로 접는다 — 하한은 고정, 상한은 열린 자리에 따라 다르다. */
export function clampAiGatewayPaletteSize(
  size: AiGatewayPaletteSize,
  bounds: { readonly maxWidth: number; readonly maxListHeight: number },
): AiGatewayPaletteSize {
  const width = Math.round(Math.min(Math.max(bounds.maxWidth, AI_GATEWAY_PALETTE_MIN_SIZE.width), Math.max(AI_GATEWAY_PALETTE_MIN_SIZE.width, size.width)));
  const listHeight = Math.round(Math.min(Math.max(bounds.maxListHeight, AI_GATEWAY_PALETTE_MIN_SIZE.listHeight), Math.max(AI_GATEWAY_PALETTE_MIN_SIZE.listHeight, size.listHeight)));
  return { width, listHeight };
}

type AiGatewayPaletteResizeEdge = "e" | "s" | "se";

/**
 * 팔레트 크기 조절. 오른쪽 변·아래 변·모서리를 끌면 폭과 목록 높이가 바뀌고, 놓으면 기억한다.
 * 상한은 매 이동마다 다시 잰다 — 앵커(로스터 머리글) 폭과 뷰포트 바닥이 곧 팔레트가 설 자리다.
 */
function useAiGatewayPaletteResize(rootRef: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = React.useState<AiGatewayPaletteSize>(readAiGatewayPaletteSize);
  const [resizing, setResizing] = React.useState<AiGatewayPaletteResizeEdge | null>(null);
  const boundsOf = React.useCallback((): { maxWidth: number; maxListHeight: number } => {
    const root = rootRef.current;
    const anchor = root?.offsetParent as HTMLElement | null;
    const list = root?.querySelector<HTMLElement>(".ai-gateway-palette-list");
    const maxWidth = anchor ? anchor.clientWidth : Number.POSITIVE_INFINITY;
    // 목록 위쪽(검색 줄)과 아래쪽(바닥 줄)은 크기가 정해져 있으므로, 남은 뷰포트가 목록의 상한이다.
    const chrome = root && list ? root.getBoundingClientRect().height - list.getBoundingClientRect().height : 0;
    const top = root ? root.getBoundingClientRect().top : 0;
    const maxListHeight = window.innerHeight - top - chrome - 24;
    return { maxWidth, maxListHeight };
  }, [rootRef]);

  // 열릴 때와 뷰포트가 바뀔 때 상한을 다시 적용한다 — 기억한 크기가 지금 자리보다 클 수 있다.
  React.useLayoutEffect(() => {
    const fit = (): void => setSize((current) => {
      const next = clampAiGatewayPaletteSize(current, boundsOf());
      return next.width === current.width && next.listHeight === current.listHeight ? current : next;
    });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [boundsOf]);

  const startResize = (edge: AiGatewayPaletteResizeEdge) => (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const origin = { x: event.clientX, y: event.clientY, ...size };
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    setResizing(edge);
    let latest = size;
    const onMove = (move: PointerEvent): void => {
      latest = clampAiGatewayPaletteSize({
        width: edge === "s" ? origin.width : origin.width + (move.clientX - origin.x),
        listHeight: edge === "e" ? origin.listHeight : origin.listHeight + (move.clientY - origin.y),
      }, boundsOf());
      setSize(latest);
    };
    const onUp = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      setResizing(null);
      writeAiGatewayPaletteSize(latest);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return { size, resizing, startResize };
}

/**
 * 모델 추가 팔레트. 검색 줄 하나, 공급자별로 묶인 계열 목록, 바닥의 변형 줄 — 한 번에 한 모델을
 * 켠다. 코어 Select 팝업(옵션 테두리·체크마크)을 빌리지 않는 이유는 이것이 선택지 하나를 고르는
 * 컨트롤이 아니라 카탈로그 60종을 훑어 하나를 켜는 작업 면이기 때문이다. 폭은 내용이 정한다 —
 * 기준 상자를 버튼이 아니라 헤더 줄로 두어야 가용 폭이 버튼 폭에 묶여 하한으로 접히지 않는다.
 */
function AiGatewayModelPalette({
  providers,
  services,
  selection,
  authOf,
  authBusy,
  saving,
  onAdd,
  onClose,
}: AiGatewayModelPaletteProps) {
  const t = getT(useTerminalLocale());
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const { size, resizing, startResize } = useAiGatewayPaletteResize(rootRef);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = React.useState("");
  /** 머리글의 "로그인"으로 펼친 키 입력 줄의 공급자. 한 번에 하나만 펼친다. */
  const [keyLineFor, setKeyLineFor] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<{ providerId: string; familyKey: string } | null>(null);
  const [variantId, setVariantId] = React.useState<string | null>(null);
  const listboxId = React.useId();

  const providerLabel = (id: string): string => t(AI_GATEWAY_PROVIDER_LABEL_KEYS[id as AiGatewayProviderId]);
  const entries = React.useMemo<AiGatewayPaletteHit[]>(
    () => providers.flatMap((provider) => groupAiGatewayModelFamilies(provider.models).map((family) => ({ provider, family }))),
    [providers],
  );
  const matched = filterAiGatewayPalette(entries, query, providerLabel);
  const enabledIds = new Set((selection.models ?? []).map((entry) => entry.id));
  // 키 공급자는 인증 상태가 도착하기 전에도 잠긴 것으로 본다 — 로딩·실패 중에 풀어 두면
  // 키 없는 경로를 저장할 수 있다. 서버 응답이 오면 그 답이 우선한다.
  const isLocked = (providerId: string): boolean => {
    const providerAuth = authOf(providerId);
    if (providerAuth === undefined) return AI_GATEWAY_KEY_PROVIDER_IDS.has(providerId);
    return !providerAuth.signedIn;
  };
  // 로그인되지 않은 공급자의 모델은 고를 수 없으므로 목록에서 감춘다 — 머리글만 남아 로그인 자리가 된다.
  const hits = matched.filter((hit) => !isLocked(hit.provider.id));
  const headingProviders = matched.map((hit) => hit.provider).filter((provider, index, all) => all.indexOf(provider) === index);
  // 서비스는 이름과 모델 id 어느 쪽으로도 찾을 수 있다 — 사용자가 "jev"를 칠 수 있어야 한다.
  const serviceQuery = query.trim().toLowerCase();
  const serviceHits = services.filter((service) =>
    serviceQuery.length === 0
    || service.displayName.toLowerCase().includes(serviceQuery)
    || (service.models ?? []).some((model) =>
      model.id.toLowerCase().includes(serviceQuery) || model.name.toLowerCase().includes(serviceQuery)));

  // 검색어가 있으면 첫 항목이 활성이라 Enter 한 번이 선택이다. 고른 항목이 검색에서 사라지면
  // 선택도 함께 접힌다 — 보이지 않는 계열에 변형 줄이 붙어 있으면 무엇을 켜는지 알 수 없다.
  const pickedHit = picked
    ? hits.find((hit) => hit.provider.id === picked.providerId && hit.family.key === picked.familyKey)
    : undefined;
  const activeHit = pickedHit ?? (query.trim().length > 0 ? hits[0] : undefined);
  const variant = pickedHit?.family.variants.find((candidate) => candidate.model.id === variantId);
  const variantEnabled = variant !== undefined && enabledIds.has(variant.model.id);

  React.useEffect(() => {
    searchRef.current?.focus();
  }, []);

  React.useEffect(() => {
    // 순위 셀렉트의 목록은 document.body로 포털되어 팔레트 밖에 그려진다 — 그 안의 클릭과
    // 열린 목록을 닫는 Escape는 팔레트의 바깥 클릭·닫기가 아니다.
    const insideSelectPopup = (path: readonly EventTarget[]): boolean =>
      path.some((node) => node instanceof HTMLElement && node.classList.contains("fc-select__popup"));
    const onPointerDown = (event: PointerEvent): void => {
      const path = event.composedPath();
      const root = rootRef.current;
      if (root && !path.includes(root) && !path.includes(root.parentElement as EventTarget) && !insideSelectPopup(path)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (document.querySelector('.fc-select__popup[data-open="true"]')) return;
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  const pick = (hit: AiGatewayPaletteHit): void => {
    setPicked({ providerId: hit.provider.id, familyKey: hit.family.key });
    // 검색어가 변형 이름("astra-1m", "K3-256K")을 짚었으면 그 칸을 먼저 놓는다. 그렇지 않으면 아직
    // 켜지 않은 첫 칸이고, 전부 켜져 있으면 첫 칸을 두어 "이미 켜져 있음"이 보이게 한다.
    const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    const named = tokens.length > 0
      ? hit.family.variants.find((candidate) =>
        tokens.every((token) => `${candidate.model.name} ${candidate.model.id}`.toLowerCase().includes(token)))
      : undefined;
    const first = named
      ?? hit.family.variants.find((candidate) => !enabledIds.has(candidate.model.id))
      ?? hit.family.variants[0];
    setVariantId(first?.model.id ?? null);
    searchRef.current?.focus();
  };

  // 한 번에 한 모델을 켜고 닫는다 — 켠 결과는 로스터에서 확인하는 것이고, 다음 모델은 다시 연다.
  const commit = (): void => {
    if (!variant || variantEnabled) return;
    onAdd(variant.model);
    onClose();
  };

  const moveActive = (delta: number): void => {
    if (hits.length === 0) return;
    const index = activeHit ? hits.indexOf(activeHit) : -1;
    const next = hits[Math.max(0, Math.min(hits.length - 1, index + delta))];
    if (next) pick(next);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && activeHit) {
      event.preventDefault();
      if (pickedHit === activeHit) commit();
      else pick(activeHit);
    }
  };

  React.useEffect(() => {
    rootRef.current?.querySelector(".ai-gateway-palette-hit.is-active")?.scrollIntoView({ block: "nearest" });
  }, [activeHit]);

  return (
    <div
      ref={rootRef}
      className={`ai-gateway-palette${resizing ? " is-resizing" : ""}`}
      role="dialog"
      aria-label={t("terminal.settings.aiGatewayAddModel")}
      style={{ "--ai-gateway-palette-width": `${size.width}px`, "--ai-gateway-palette-list-height": `${size.listHeight}px` } as React.CSSProperties}
    >
      <div className="ai-gateway-palette-search">
        <span className="ai-gateway-palette-search-glyph" aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          type="search"
          className="ai-gateway-palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={activeHit ? `${listboxId}-${activeHit.provider.id}` : undefined}
          aria-activedescendant={activeHit ? `${listboxId}-${activeHit.provider.id}-${activeHit.family.key}` : undefined}
          aria-autocomplete="list"
          aria-label={t("terminal.settings.aiGatewaySearchAria")}
          placeholder={t("terminal.settings.aiGatewaySearchPlaceholder")}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setPicked(null);
            setVariantId(null);
          }}
          onKeyDown={onSearchKeyDown}
        />
        <kbd className="ai-gateway-palette-kbd" aria-hidden="true">↑↓</kbd>
        <kbd className="ai-gateway-palette-kbd" aria-hidden="true">Enter</kbd>
      </div>
      {/* 목록 전체가 listbox가 아니다 — 머리글에 로그인·순위·엔드포인트 컨트롤이 서므로, 옵션만 담는
          listbox는 프로바이더마다 하나씩이고 바깥은 구조 없는 스크롤 면이다. */}
      <div className="ai-gateway-palette-list">
        {headingProviders.map((provider) => {
          const providerAuth = authOf(provider.id);
          return (
            <React.Fragment key={provider.id}>
              <AiGatewayPaletteGroupHead
                provider={provider}
                auth={providerAuth}
                busy={authBusy === provider.id}
                keyLineOpen={keyLineFor === provider.id}
                onToggleKeyLine={() => setKeyLineFor((current) => current === provider.id ? null : provider.id)}
                onKeyLineDone={() => setKeyLineFor(null)}
              />
              <div role="listbox" id={`${listboxId}-${provider.id}`} aria-label={providerLabel(provider.id)}>
              {hits.filter((hit) => hit.provider === provider).map((hit) => {
                const allEnabled = hit.family.variants.every((candidate) => enabledIds.has(candidate.model.id));
                const isActive = hit === activeHit;
                return (
                  <div
                    key={hit.family.key}
                    id={`${listboxId}-${hit.provider.id}-${hit.family.key}`}
                    role="option"
                    aria-selected={isActive}
                    className={`ai-gateway-palette-hit${isActive ? " is-active" : ""}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => pick(hit)}
                  >
                    <AiGatewayCapabilityBadge capabilityClass={hit.family.capabilityClass} />
                    <span className="ai-gateway-palette-hit-name">{hit.family.name}</span>
                    <span className="ai-gateway-palette-hit-hint">
                      {allEnabled ? t("terminal.settings.aiGatewayAllEnabled") : describeAiGatewayFamily(hit.family, t("terminal.settings.aiGatewayFast"))}
                    </span>
                  </div>
                );
              })}
              </div>
            </React.Fragment>
          );
        })}
        {serviceHits.map((service) => (
          <AiGatewayPaletteServiceGroup
            key={service.provider}
            service={service}
            busy={authBusy === service.provider}
            keyLineOpen={keyLineFor === service.provider}
            onToggleKeyLine={() => setKeyLineFor((current) => current === service.provider ? null : service.provider)}
            onKeyLineDone={() => setKeyLineFor(null)}
          />
        ))}
        {headingProviders.length === 0 && serviceHits.length === 0 ? (
          <p className="ai-gateway-palette-empty">{t("terminal.settings.aiGatewayNoMatch", { query: query.trim() })}</p>
        ) : null}
      </div>
      <div className="ai-gateway-palette-foot">
        {pickedHit === undefined ? (
          <span className="ai-gateway-field-label">
            {activeHit ? t("terminal.settings.aiGatewayVariantEnterHint") : t("terminal.settings.aiGatewayVariantPickHint")}
          </span>
        ) : (
          <>
            <span className="ai-gateway-field-label">{t("terminal.settings.aiGatewayVariant")}</span>
            <div className="ai-gateway-variant-row" role="radiogroup" aria-label={t("terminal.settings.aiGatewayVariant")}>
              {pickedHit.family.variants.map((candidate, index) => {
                const isPicked = candidate.model.id === variantId;
                const isEnabled = enabledIds.has(candidate.model.id);
                return (
                  <button
                    key={candidate.model.id}
                    type="button"
                    role="radio"
                    aria-checked={isPicked}
                    tabIndex={isPicked ? 0 : -1}
                    className={`ai-gateway-variant${isPicked ? " is-on" : ""}${isEnabled ? " is-enabled" : ""}`}
                    title={isEnabled ? t("terminal.settings.aiGatewayAlreadyEnabled") : candidate.model.id}
                    onClick={() => setVariantId(candidate.model.id)}
                    onKeyDown={(event) => {
                      const variants = pickedHit.family.variants;
                      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                        event.preventDefault();
                        const next = variants[(index + (event.key === "ArrowRight" ? 1 : variants.length - 1)) % variants.length];
                        if (next) {
                          setVariantId(next.model.id);
                          window.setTimeout(() => rootRef.current?.querySelector<HTMLButtonElement>(".ai-gateway-variant.is-on")?.focus(), 0);
                        }
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        commit();
                      }
                    }}
                  >
                    {candidate.label}
                  </button>
                );
              })}
            </div>
            {/* 이미 켠 칸을 고르면 버튼이 라벨로 그 사실을 말한다 — 별도 문구를 옆에 세우면
                한 줄이 넘쳐 버튼이 아래로 내려간다. */}
            <button
              type="button"
              className="ai-gateway-add-button ai-gateway-palette-add"
              disabled={saving || variant === undefined || variantEnabled}
              onClick={commit}
            >
              {variantEnabled ? t("terminal.settings.aiGatewayAlreadyEnabled") : t("terminal.settings.aiGatewayAddModel")}
            </button>
          </>
        )}
      </div>
      {/* 크기 손잡이 — 오른쪽 변은 폭, 아래 변은 목록 높이, 모서리는 둘 다. 보이는 것은 모서리 빗금뿐이고
          손잡이는 포인터 전용이라 Tab 순서에 들지 않는다(기본 크기로 돌아오는 길은 설정이 아니라 다시 끄는 것). */}
      <div className="ai-gateway-palette-resize is-e" aria-hidden="true" onPointerDown={startResize("e")} />
      <div className="ai-gateway-palette-resize is-s" aria-hidden="true" onPointerDown={startResize("s")} />
      <div className="ai-gateway-palette-resize is-se" title={t("terminal.settings.aiGatewayPaletteResize")} aria-hidden="true" onPointerDown={startResize("se")} />
    </div>
  );
}

/**
 * 순위 셀렉트의 결과 순서. 같은 숫자를 다른 공급자에 주면 기존 공급자가 한 칸 밀리고,
 * "순위 없음"을 고르면 뒤 순번이 당겨진다 — 드래그 프리미티브 없이 순서 전체를 다룬다.
 */
export function placeAiGatewayPriority(
  priority: readonly AiGatewayProviderId[],
  provider: AiGatewayProviderId,
  rank: number | null,
): AiGatewayProviderId[] {
  const rest = priority.filter((entry) => entry !== provider);
  if (rank === null) return rest;
  rest.splice(Math.max(0, Math.min(rank, rest.length)), 0, provider);
  return rest;
}

/**
 * Which endpoint xAI turns use. Every turn uses it — the two do not share a prompt cache, so
 * rerouting one mid-conversation would re-prefill the whole thing.
 *
 * It sits inside the provider row rather than in a card of its own because it is a property
 * of this provider's route, meaningless to a reader who has not enabled an xAI model.
 */
function AiGatewayXaiEndpointRow({ saving }: { readonly saving: boolean }) {
  const t = getT(useTerminalLocale());
  const state = useSystemPromptSettingsStore().state;
  if (!state) return null;
  const endpoint = state.xaiEndpoint;
  return (
    <span className="ai-gateway-endpoint">
      <span className="ai-gateway-field-label" id="xai-endpoint-label">{t("terminal.settings.xaiEndpoint")}</span>
      <div className="segmented" role="group" aria-labelledby="xai-endpoint-label" title={t("terminal.settings.xaiEndpointHelp")}>
        <SegmentedThumb />
        <button
          type="button"
          className={`segmented-option${endpoint === "cli-proxy" ? " is-active" : ""}`}
          disabled={saving}
          onClick={() => void setSystemPromptSettingsField("xaiEndpoint", "cli-proxy")}
        >
          {t("terminal.settings.xaiEndpointProxy")}
        </button>
        <button
          type="button"
          className={`segmented-option${endpoint === "direct" ? " is-active" : ""}`}
          disabled={saving}
          onClick={() => void setSystemPromptSettingsField("xaiEndpoint", "direct")}
        >
          {t("terminal.settings.xaiEndpointDirect")}
        </button>
      </div>
    </span>
  );
}

/**
 * 팔레트의 서비스 그룹. 머리글 문법은 다른 공급자와 같다 — 글리프·이름·칩·인증 셀 순서,
 * `API key` 글자가 곧 로그인 버튼이고 열리면 그 아래 키 줄이 접힌다. 다른 점은 항목에
 * `role="option"`을 주지 않는다는 것뿐이다: 고를 수 있는 모습을 하면 대화 모델로 오인된다.
 */
function AiGatewayPaletteServiceGroup({ service, busy, keyLineOpen, onToggleKeyLine, onKeyLineDone }: {
  readonly service: ModelAuthProviderState;
  readonly busy: boolean;
  readonly keyLineOpen: boolean;
  readonly onToggleKeyLine: () => void;
  readonly onKeyLineDone: () => void;
}) {
  const t = getT(useTerminalLocale());
  return (
    <>
      <div className="ai-gateway-palette-group ai-gateway-provider is-typesafe" role="presentation">
        <span className="ai-gateway-provider-glyph" aria-hidden="true">{serviceGlyph("typesafe")}</span>
        <span className="ai-gateway-palette-group-name">{service.displayName}</span>
        <span className="ai-gateway-service-wrap">
          <span className="ai-gateway-chip">{t("terminal.settings.aiGatewayServiceBadge")}</span>
          <span className="ai-gateway-service-tip" role="tooltip">{t("terminal.settings.aiGatewayServiceTip")}</span>
        </span>
        <span className="ai-gateway-palette-group-controls">
          {service.signedIn ? (
            <button
              type="button"
              className="ai-gateway-key-signout"
              disabled={busy}
              aria-label={`${service.displayName} · ${t("terminal.auth.signOut")}`}
              onClick={() => void signOutModel(service.provider)}
            >
              {busy ? t("terminal.auth.working") : t("terminal.auth.signOut")}
            </button>
          ) : (
            <button
              type="button"
              className="ai-gateway-palette-signin"
              aria-expanded={keyLineOpen}
              aria-label={t("terminal.auth.apiKeyAria", { name: service.displayName })}
              disabled={busy}
              onClick={onToggleKeyLine}
            >
              {busy ? t("terminal.auth.verifying") : t("terminal.settings.aiGatewayAuthApiKey")}
            </button>
          )}
        </span>
      </div>
      {(service.models ?? []).map((model) => (
        <div className="ai-gateway-palette-service-model" key={model.id} tabIndex={0}>
          <span className="ai-gateway-palette-hit-name">{model.name}</span>
          <code className="ai-gateway-service-id">{model.id}</code>
          <span className="ai-gateway-service-tip" role="tooltip">{t("terminal.settings.aiGatewayServiceModelTip")}</span>
        </div>
      ))}
      {!service.signedIn && keyLineOpen ? (
        <AiGatewayKeyForm provider={service} busy={busy} compact onSignedIn={onKeyLineDone} />
      ) : null}
    </>
  );
}

interface AiGatewayPaletteGroupHeadProps {
  readonly provider: AiGatewayCatalogProvider;
  readonly auth: ModelAuthProviderState | undefined;
  readonly busy: boolean;
  readonly keyLineOpen: boolean;
  readonly onToggleKeyLine: () => void;
  readonly onKeyLineDone: () => void;
}

/**
 * 팔레트의 프로바이더 머리글 — 목록의 묶음 라벨이자 그 프로바이더의 인증 줄이다. 오른쪽에
 * [구독 / API key] [로그인·로그아웃]이 서고, 키가 없는 프로바이더는 "API key"가 머리글 아래에
 * 키 입력 줄을 펼친다. 로그인은 켠 모델이 없는 프로바이더에도 필요하므로 여기 남고, 우선 소진
 * 순위와 xAI 엔드포인트는 켠 모델이 있어야 뜻이 있는 값이라 로스터의 묶음 머리글에 선다.
 */
function AiGatewayPaletteGroupHead({
  provider,
  auth,
  busy,
  keyLineOpen,
  onToggleKeyLine,
  onKeyLineDone,
}: AiGatewayPaletteGroupHeadProps) {
  const t = getT(useTerminalLocale());
  const id = provider.id as AiGatewayProviderId;
  const keyed = auth !== undefined || AI_GATEWAY_KEY_PROVIDER_IDS.has(provider.id);
  const locked = auth !== undefined && !auth.signedIn;
  return (
    <>
      <div className={`ai-gateway-palette-group ai-gateway-provider is-${provider.id}`} role="presentation">
        <span className="ai-gateway-provider-glyph" aria-hidden="true">{launchProviderGlyph(id)}</span>
        <span className="ai-gateway-palette-group-name">{t(AI_GATEWAY_PROVIDER_LABEL_KEYS[id])}</span>
        <span className="ai-gateway-chip">{t("terminal.settings.aiGatewayModelCount", { count: provider.models.length })}</span>
        <span className="ai-gateway-palette-group-controls">
          {/* 인증 셀: 구독은 글자, API key는 글자 자체가 로그인 버튼, 로그인된 뒤에는 로그아웃만. */}
          {!keyed ? (
            <span className="ai-gateway-provider-sub">{t("terminal.settings.aiGatewayAuthSubscription")}</span>
          ) : auth?.signedIn ? (
            <button
              type="button"
              className="ai-gateway-key-signout"
              disabled={busy}
              aria-label={`${auth.displayName} · ${t("terminal.auth.signOut")}`}
              onClick={() => void signOutModel(auth.provider)}
            >
              {busy ? t("terminal.auth.working") : t("terminal.auth.signOut")}
            </button>
          ) : (
            <button
              type="button"
              className="ai-gateway-palette-signin"
              aria-expanded={keyLineOpen}
              aria-label={auth ? t("terminal.auth.apiKeyAria", { name: auth.displayName }) : t("terminal.settings.aiGatewayAuthApiKey")}
              disabled={busy || auth === undefined}
              onClick={onToggleKeyLine}
            >
              {busy ? t("terminal.auth.verifying") : t("terminal.settings.aiGatewayAuthApiKey")}
            </button>
          )}
        </span>
      </div>
      {locked && keyLineOpen && auth ? (
        <AiGatewayKeyForm provider={auth} busy={busy} compact onSignedIn={onKeyLineDone} />
      ) : null}
    </>
  );
}

interface AiGatewayModelRowProps {
  readonly entry: AiGatewayRosterEntry;
  readonly saving: boolean;
  readonly onRemove: () => void;
  readonly onSetEfforts: (efforts: readonly string[]) => void;
  readonly onToggleHostOnly: () => void;
}

/**
 * 들여쓴 레코드: 등급 → 모델·속성 → 조작. 공급자는 묶음 머리글이 말하므로 줄에는 없다. 같은
 * 자리에 같은 것이 오므로 스무 줄이 되어도 스캔이 되고, 등급 열이 먼저라 이름 시작점이 맞는다.
 * 게이트웨이 id는 이름과 묶음이 이미 말하는 정보라 적지 않는다.
 */
export function AiGatewayModelRow({
  entry,
  saving,
  onRemove,
  onSetEfforts,
  onToggleHostOnly,
}: AiGatewayModelRowProps) {
  const t = getT(useTerminalLocale());
  const { model, efforts, hostOnly } = entry;
  const contextLabel = formatAiGatewayContextWindow(model.contextWindow);
  const ladder = model.effort?.levels ?? [];

  return (
    <div className="ai-gateway-model-row">
      <AiGatewayCapabilityBadge capabilityClass={model.capabilityClass} />
      <span className="ai-gateway-model-text">
        <span className="ai-gateway-model-name">{model.name}</span>
        {contextLabel ? <span className="ai-gateway-chip">{contextLabel}</span> : null}
        {model.fast ? <span className="ai-gateway-chip">{t("terminal.settings.aiGatewayFast")}</span> : null}
        {model.description ? <span className="ai-gateway-chip">{model.description}</span> : null}
      </span>
      <span className="ai-gateway-model-controls">
        {ladder.length > 0 ? (
          <AiGatewayEffortBadge
            model={model}
            exposed={resolveExposedEfforts(ladder, efforts)}
            hostOnly={hostOnly}
            saving={saving}
            onSetEfforts={onSetEfforts}
          />
        ) : null}
        <button
          type="button"
          className={`ai-gateway-host-only ${hostOnly ? "is-on" : ""}`}
          aria-pressed={hostOnly}
          aria-label={t("terminal.settings.aiGatewayHostOnlyAria", { name: model.name })}
          disabled={saving}
          onClick={onToggleHostOnly}
        >
          {t("terminal.settings.aiGatewayHostOnly")}
        </button>
        {/* 인접 형제여야 hover·focus 선택자가 닿는다 — 사이에 무엇도 끼우지 말 것. */}
        <span className="ai-gateway-host-only-tip" role="tooltip">
          {t("terminal.settings.aiGatewayHostOnlyTip")}
        </span>
        <button
          type="button"
          className="ai-gateway-remove"
          aria-label={t("terminal.settings.aiGatewayRemoveAria", { name: model.name })}
          disabled={saving}
          onClick={onRemove}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/**
 * 강도 배지를 펼친 형태. 배지 하나가 노출 사다리 전체를 보여주고 그 자리에서 고르게 한다 —
 * 접기 뒤에 두면 어떤 단계가 살아 있는지가 한 번 더 펼쳐야 보이는 사실이 되고, 요약 숫자는
 * 어느 단계를 껐는지 말하지 못한다. 켜진 세그먼트는 위치 채널(brass)로만 말한다.
 */
function AiGatewayEffortBadge({
  model,
  exposed,
  hostOnly,
  saving,
  onSetEfforts,
}: {
  readonly model: AiGatewayCatalogModel;
  readonly exposed: readonly string[];
  readonly hostOnly: boolean;
  readonly saving: boolean;
  readonly onSetEfforts: (efforts: readonly string[]) => void;
}) {
  const t = getT(useTerminalLocale());
  const ladder = model.effort?.levels ?? [];
  return (
    <span
      className="ai-gateway-effort"
      role="group"
      aria-label={t("terminal.settings.aiGatewayLevelsAria", { name: model.name })}
      // 호스트 전용 모델의 정체성 수는 0이라, 켜진 단계를 세어 보여 주면 그 문장이 거짓이 된다.
      title={hostOnly
        ? t("terminal.settings.aiGatewayHostOnlyNote")
        : t("terminal.settings.aiGatewayIdentityCount", { count: exposed.length })}
    >
      <span className="ai-gateway-effort-label" aria-hidden="true">effort</span>
      {ladder.map((level) => {
        const isOn = exposed.includes(level);
        return (
          <button
            key={level}
            type="button"
            className={`ai-gateway-effort-level ${isOn ? "is-on" : ""}`}
            aria-pressed={isOn}
            // 마지막 한 단계는 끌 수 없다 — 정체성이 0개인 모델은 켜 둔 채로
            // 쓸 수 없으므로, 그 상태는 아예 만들 수 없게 한다.
            disabled={saving || (isOn && exposed.length === 1)}
            onClick={() => onSetEfforts(isOn
              ? exposed.filter((current) => current !== level)
              : [...exposed, level])}
          >
            {level}
          </button>
        );
      })}
    </span>
  );
}

/** 저장된 선택을 사다리에 대조한다. 부재이거나 겹치는 게 없으면 사다리 전체. */
function resolveExposedEfforts(
  ladder: readonly string[],
  exposedEfforts: readonly string[] | undefined,
): readonly string[] {
  if (!exposedEfforts || exposedEfforts.length === 0) return ladder;
  const narrowed = ladder.filter((level) => exposedEfforts.includes(level));
  return narrowed.length > 0 ? narrowed : ladder;
}

/**
 * 등급마다 한 줄 설명. 라벨은 카탈로그 리터럴을 그대로 쓰고 이 문장만 번역한다 — 등급 이름을
 * 옮기면 배지와 호스트가 읽는 이름이 갈라져 같은 모델을 두 어휘로 말하게 된다.
 */
const AI_GATEWAY_CLASS_TOOLTIP_KEYS = {
  flagship: "terminal.settings.aiGatewayClassFlagshipTooltip",
  standard: "terminal.settings.aiGatewayClassStandardTooltip",
  light: "terminal.settings.aiGatewayClassLightTooltip",
  unclassed: "terminal.settings.aiGatewayClassUnclassedTooltip",
} as const;

/**
 * 등급은 로스터에서 유일한 품질 신호라서 속성 칩과 섞지 않고 모델 이름에 붙인다. 서열은
 * 신호색이 아니라 잉크 강도로만 말한다 — 등급은 상태가 아니라 프로바이더가 주장하는 속성이다.
 */
function AiGatewayCapabilityBadge({ capabilityClass }: { readonly capabilityClass: AiGatewayCapabilityClass | null }) {
  const t = getT(useTerminalLocale());
  // 카탈로그 검증이 라우팅 별칭에 등급을 금지하므로, 부재는 결측이 아니라 그 자체가 사실이다.
  const grade = capabilityClass ?? "unclassed";
  return (
    <span className={`ai-gateway-class-badge is-${grade}`} title={t(AI_GATEWAY_CLASS_TOOLTIP_KEYS[grade])}>
      {grade}
    </span>
  );
}

/**
 * API key 공급자의 로그인 폼. 팔레트의 프로바이더 머리글 아래에 접히는 줄로 선다. 키는 검증 뒤
 * 서버에만 남고 브라우저로 되돌아오지 않으므로, 로그인되면 줄은 접히고 머리글에 로그아웃만 남는다.
 */
function AiGatewayKeyForm({ provider, busy, compact = false, onSignedIn }: {
  readonly provider: ModelAuthProviderState;
  readonly busy: boolean;
  readonly compact?: boolean;
  readonly onSignedIn?: () => void;
}) {
  const t = getT(useTerminalLocale());
  const [apiKey, setApiKey] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (compact) inputRef.current?.focus();
  }, [compact]);

  const handleSignIn = async () => {
    const ok = await signInModel(provider.provider, apiKey);
    if (ok) {
      setApiKey("");
      onSignedIn?.();
    }
  };

  return (
    <form
      className={`ai-gateway-key-form${compact ? " is-compact" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSignIn();
      }}
    >
      {compact ? null : <span className="ai-gateway-key-status">{t("terminal.auth.notSignedIn")}</span>}
      <input
        ref={inputRef}
        type="password"
        className="ai-gateway-key-input"
        placeholder={t("terminal.auth.apiKey")}
        value={apiKey}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        aria-label={t("terminal.auth.apiKeyAria", { name: provider.displayName })}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <button type="submit" className="ai-gateway-add-button" disabled={busy || apiKey.trim().length === 0}>
        {busy ? t("terminal.auth.verifying") : t("terminal.auth.signIn")}
      </button>
    </form>
  );
}

function SettingsHelp({ title, id, children }: {
  readonly title: string;
  readonly id?: string;
  readonly children: React.ReactNode;
}) {
  const t = getT(useTerminalLocale());
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
function SettingToggleRow({ title, help, value, disabled, onToggle }: SettingToggleRowProps) {
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {title}
          <SettingsHelp title={title}>
            {help}
          </SettingsHelp>
        </p>
      </div>
      {/* 켬/끔은 콘솔 전체에서 SDK 스위치 한 모양이다 — 예전의 "Off" 글자 버튼은 스타일 없는 세 번째 문법이었다. */}
      <SettingsToggle
        checked={value}
        disabled={disabled}
        ariaLabel={title}
        onChange={onToggle}
      />
    </div>
  );
}

interface SettingToggleRowProps { readonly title: string; readonly help: string; readonly value: boolean; readonly disabled: boolean; readonly onToggle: () => void }
