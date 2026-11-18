import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ProviderDto, QuotaWindow } from "@fleet-console/ai-gateway";
import { AI_GATEWAY_OPT_IN_EFFORTS as OPT_IN, aiGatewayModelFamilyKey, canonicalEffortSelection, defaultEffortSelection, type AiGatewayRoleThresholds } from "@fleet-console/ai-gateway/model-family";
import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import { useStoreSnapshot } from "@fleet-console/ui/store";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { launchProviderCaption, launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "../../ai-gateway/client/components/launch-provider-glyphs.js";
import { prettyModelId } from "../../ai-gateway/client/components/model-coordinate-picker.js";
import { canonicalModelId, findRosterRow, type ModelRoster } from "../../ai-gateway/shared/models.js";
import { formatResetInstant, meterSeverity } from "../../quota/client/quota-panel.js";
import { getQuotaSummarySnapshot, holdQuotaSummary, subscribeQuotaSummary } from "../../quota/client/summary-store.js";
import { requestQuotaPanelOpen } from "../../quota/client/toolbar-summary.js";
import {
  getSystemPromptSettingsStoreState,
  loadSystemPromptSettings,
  setSystemPromptSettingsField,
  useSystemPromptSettingsStore,
  type AiGatewayCatalogModel,
  type AiGatewayCatalogProvider,
  type AiGatewayModelSelection,
  type AiGatewayProviderId,
  type AiGatewaySettings,
} from "../../settings/client/execution-settings.js";
import type { CommodoreMessageKey } from "./i18n/index.js";
import { effortWord, hasAnyScore, qualifying, RankMark, type IntelligenceScores } from "./commodore-intelligence.js";

type T = Translate<CommodoreMessageKey>;

const LAUNCH_PROVIDER_ORDER: readonly AiGatewayProviderId[] = ["claude", "codex", "xai", "muse-code", "opencode", "gemini"];
const BASE_EFFORTS = new Set(["low", "medium"]);

const MODEL_SUBTITLE_KEYS: Readonly<Record<string, CommodoreMessageKey>> = {
  fable: "commodore.pool.sub.fable",
  opus: "commodore.pool.sub.opus",
  sonnet: "commodore.pool.sub.sonnet",
  haiku: "commodore.pool.sub.haiku",
  "gpt-6.2-astra": "commodore.pool.sub.gpt-6.2-astra",
  "gpt-6.2-sol": "commodore.pool.sub.gpt-6.2-sol",
  "gpt-6-astra": "commodore.pool.sub.gpt-6-astra",
  "gpt-6.1-sol": "commodore.pool.sub.gpt-6.1-sol",
  "gpt-6-luna": "commodore.pool.sub.gpt-6-luna",
  "gpt-6.1-terra": "commodore.pool.sub.gpt-6.1-terra",
  "grok-4.7": "commodore.pool.sub.grok-4.7",
  "grok-composer-2.5-fast": "commodore.pool.sub.grok-composer-2.5-fast",
  "gemini-4-argon": "commodore.pool.sub.gemini-4-argon",
  "gemini-4-carbon": "commodore.pool.sub.gemini-4-carbon",
  "gemini-4-hydrogen": "commodore.pool.sub.gemini-4-hydrogen",
  "muse-spark-1.3": "commodore.pool.sub.muse-spark-1.3",
  "muse-spark-1.3-contributor": "commodore.pool.sub.muse-spark-1.3-contributor",
};

function shortModelSubtitle(modelId: string, t: T, fallback: string | null): string | null {
  const canonical = canonicalModelId(modelId);
  const sep = canonical.indexOf("--");
  const slug = (sep >= 0 ? canonical.slice(sep + 2) : canonical).toLowerCase().replace(/(?:\[1m\]|-1m)$/u, "");
  const key = MODEL_SUBTITLE_KEYS[slug];
  return key ? t(key) : fallback;
}

export type PoolModelStatusKind = "ok" | "wait" | "rest";

export interface PoolModelStatus {
  readonly kind: PoolModelStatusKind;
  readonly resetAtText?: string | null;
  readonly headroom: number;
}

export interface PoolEntryView {
  readonly entry: AiGatewayModelSelection;
  readonly provider: AiGatewayProviderId;
  readonly name: string;
  readonly ladder: readonly string[];
  readonly fastSupported: boolean;
  readonly status: PoolModelStatus;
  /** 강도별 지능 점수(카탈로그). 점수가 없는 강도는 키가 없다. */
  readonly scores: IntelligenceScores;
  /** 위임에 켜 둔 강도(사다리 순). MAX도 켜 두었으면 들어간다. */
  readonly exposed: readonly string[];
  /** 켜 둔 강도로 지휘관 기준에 닿는 가장 낮은 강도. 기준값을 모르거나 닿지 않으면 null. */
  readonly lead: { readonly effort: string; readonly score: number } | null;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** 사령관·지휘관 칩과 동일한 박스 없는 순수 공급자 마크(`ProviderMark` 문법). */
export function ProviderMark({ provider }: { readonly provider: LaunchProviderGlyphId | null }) {
  if (!provider) return null;
  return (
    <span className={`objective-launch-provider-glyph fc-coord-trigger-provider is-${provider}`} aria-hidden="true">
      {launchProviderGlyph(provider)}
    </span>
  );
}

function bindingWindows(provider: ProviderDto | undefined, quotaScopes: readonly string[] | undefined): readonly QuotaWindow[] {
  if (!provider || (provider.status !== "ok" && provider.status !== "stale")) return [];
  return (provider.windows ?? []).filter((window) => window.isAggregate !== true
    && (window.scope === undefined || quotaScopes?.includes(window.scope) === true));
}

function windowResetTimestamp(window: QuotaWindow): number | undefined {
  if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) return window.resetsAt;
  const duration = window.period?.durationMs;
  const startsAt = window.period?.startsAt;
  if (typeof startsAt === "number" && typeof duration === "number" && Number.isFinite(startsAt) && Number.isFinite(duration)) {
    return startsAt + duration;
  }
  return undefined;
}

function modelQuotaStatus(
  providerVisible: boolean,
  providerQuota: ProviderDto | undefined,
  quotaScopes: readonly string[] | undefined,
  locale: ConsoleLocale,
): PoolModelStatus {
  if (!providerVisible) {
    return { kind: "wait", headroom: -1 };
  }
  const windows = bindingWindows(providerQuota, quotaScopes);
  if (windows.length === 0) return { kind: "ok", headroom: 50 };
  const critical = windows.filter((window) => meterSeverity(window) === "critical");
  const minRemaining = Math.min(...windows.map((window) => Math.max(0, 100 - window.usedPercent)));
  if (critical.length > 0) {
    const resets = critical.map(windowResetTimestamp).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
    const resetAtText = resets[0] !== undefined ? formatResetInstant(resets[0], Date.now(), locale) : null;
    return { kind: "rest", resetAtText, headroom: minRemaining };
  }
  return { kind: "ok", headroom: minRemaining };
}

function orderCatalogProviders(providers: readonly AiGatewayCatalogProvider[]): readonly AiGatewayCatalogProvider[] {
  const rank = (id: string) => {
    const index = LAUNCH_PROVIDER_ORDER.indexOf(id as AiGatewayProviderId);
    return index >= 0 ? index : LAUNCH_PROVIDER_ORDER.length;
  };
  return [...providers].sort((left, right) => rank(left.id) - rank(right.id));
}

export interface RoutingPoolData {
  readonly loading: boolean;
  readonly unavailable: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly providers: readonly AiGatewayCatalogProvider[];
  readonly entries: readonly PoolEntryView[];
  readonly poolProviders: readonly { readonly id: AiGatewayProviderId; readonly waiting: boolean; readonly count: number; readonly waitingCount: number; readonly restingCount: number }[];
  readonly usableCount: number;
  /** 역할별 추천 기준 점수. 옛 서버처럼 카탈로그가 싣지 않으면 null이고, 그때 점수 안내는 서지 않는다. */
  readonly thresholds: AiGatewayRoleThresholds | null;
  readonly intelligenceIndex: { readonly name: string; readonly observedAt: string } | null;
  readonly priority: readonly AiGatewayProviderId[];
  /** 공급자가 지금 선택기 로스터에 나오는지(로그인됨, 또는 상태를 아직 모름). */
  readonly providerVisible: (providerId: AiGatewayProviderId) => boolean;
  readonly signature: string;
  readonly chipAria: (t: T) => string;
  readonly addModel: (provider: AiGatewayCatalogProvider, model: AiGatewayCatalogModel) => void;
  readonly removeModel: (modelId: string, onUndo?: (undo: { readonly text: string; readonly restore: () => void }) => void, t?: T) => void;
  readonly toggleEffort: (entry: PoolEntryView, level: string) => void;
  readonly toggleFast: (entry: PoolEntryView) => void;
  readonly togglePriority: (providerId: AiGatewayProviderId) => void;
  readonly findCatalogModel: (modelId: string) => { readonly provider: AiGatewayCatalogProvider; readonly model: AiGatewayCatalogModel } | null;
}

export function useRoutingPoolData(launchRoster: ModelRoster | null, t: T): RoutingPoolData {
  const locale = useConsoleLocale();
  const settings = useSystemPromptSettingsStore();
  const quotaSnapshot = useStoreSnapshot(subscribeQuotaSummary, getQuotaSummarySnapshot);

  useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => holdQuotaSummary(), []);

  const state = settings.state;
  const selection = state?.aiGateway ?? {};
  const enabled = selection.models ?? [];
  const providers = useMemo(() => orderCatalogProviders(state?.aiGatewayCatalog.providers ?? []), [state?.aiGatewayCatalog.providers]);

  const catalogByModelId = useMemo(() => {
    const map = new Map<string, { readonly provider: AiGatewayCatalogProvider; readonly model: AiGatewayCatalogModel }>();
    for (const provider of providers) {
      for (const model of provider.models) {
        map.set(model.id, { provider, model });
      }
    }
    return map;
  }, [providers]);

  const thresholds = state?.aiGatewayCatalog.roleThresholds ?? null;
  // 공급자 노출은 사령관·지휘관 선택기와 같은 원천, 곧 로스터를 따른다. 호스트는 공급자 로그인 상태가 바뀔 때마다
  // 로스터를 다시 알리므로(models:roster-changed) Console을 다시 열지 않아도 담기 목록과 칩 상태가 따라온다.
  // 설정 스냅샷의 aiGatewayLogin은 이 훅이 처음 붙을 때 한 번만 받으므로 여기서 읽지 않는다.
  // 로스터를 아직 받지 못했으면 상태를 모르는 것으로 보고 보인다 — 호스트의 isProviderCatalogVisible과 같은 규칙이다.
  const rosterProviders = useMemo(() => {
    if (!launchRoster) return null;
    const ids = new Set<string>();
    for (const group of launchRoster) {
      const provider = launchProviderFromGroupId(group.id);
      if (provider) ids.add(provider);
    }
    return ids;
  }, [launchRoster]);
  const providerVisible = useCallback(
    (providerId: AiGatewayProviderId): boolean => rosterProviders === null || rosterProviders.has(providerId),
    [rosterProviders],
  );

  const entries = useMemo<readonly PoolEntryView[]>(() => {
    return enabled.map((entry) => {
      const found = catalogByModelId.get(entry.id);
      const provider = (found?.provider.id ?? launchProviderFromModelId(entry.id) ?? "claude") as AiGatewayProviderId;
      const rosterRow = findRosterRow(launchRoster, entry.id);
      const name = found?.model.name ?? rosterRow?.label ?? prettyModelId(entry.id);
      const ladder = found?.model.effort?.levels ?? [];
      const fastSupported = found?.model.fast === true || rosterRow?.fastSupported === true;
      const status = modelQuotaStatus(
        providerVisible(provider),
        quotaSnapshot.data?.providers[provider],
        rosterRow?.quotaScopes,
        locale,
      );
      const scores: IntelligenceScores = found?.model.intelligence ?? {};
      const chosen = entry.efforts ?? ladder;
      const exposed = ladder.filter((level) => chosen.includes(level));
      const lead = thresholds ? qualifying(scores, exposed, thresholds.lead) : null;
      return { entry, provider, name, ladder, fastSupported, status, scores, exposed, lead };
    });
  }, [enabled, catalogByModelId, launchRoster, providerVisible, quotaSnapshot.data, locale, thresholds]);

  const poolProviders = useMemo(() => {
    const result: Array<{ readonly id: AiGatewayProviderId; readonly waiting: boolean; readonly count: number; readonly waitingCount: number; readonly restingCount: number }> = [];
    for (const providerId of LAUNCH_PROVIDER_ORDER) {
      const matching = entries.filter((item) => item.provider === providerId);
      if (matching.length === 0) continue;
      const waitingCount = matching.filter((item) => item.status.kind === "wait").length;
      const restingCount = matching.filter((item) => item.status.kind === "rest").length;
      const waiting = matching.every((item) => item.status.kind !== "ok");
      result.push({ id: providerId, waiting, count: matching.length, waitingCount, restingCount });
    }
    return result;
  }, [entries]);

  const usableCount = useMemo(() => entries.filter((item) => item.status.kind === "ok").length, [entries]);

  const enabledProviderSet = useMemo(() => new Set(poolProviders.map((item) => item.id)), [poolProviders]);
  const priority = useMemo(
    () => (selection.providerPriority ?? []).filter((id): id is AiGatewayProviderId => enabledProviderSet.has(id)),
    [selection.providerPriority, enabledProviderSet],
  );

  const saveModels = useCallback((models: readonly AiGatewayModelSelection[], providerPriority?: readonly AiGatewayProviderId[]) => {
    void setSystemPromptSettingsField("aiGateway", providerPriority !== undefined ? { models, providerPriority } : { models });
  }, []);

  const addModel = useCallback((_provider: AiGatewayCatalogProvider, model: AiGatewayCatalogModel) => {
    const latest = getSystemPromptSettingsStoreState().state?.aiGateway?.models ?? enabled;
    if (latest.some((item) => item.id === model.id)) return;
    const efforts = defaultEffortSelection(model.effort?.levels ?? []);
    saveModels([...latest, { id: model.id, ...(efforts ? { efforts } : {}) }]);
  }, [enabled, saveModels]);

  const removeModel = useCallback((modelId: string, onUndo?: (undo: { readonly text: string; readonly restore: () => void }) => void, translate?: T) => {
    const latestState = getSystemPromptSettingsStoreState().state;
    const latestSelection = latestState?.aiGateway ?? {};
    const currentModels = latestSelection.models ?? enabled;
    const removedIndex = currentModels.findIndex((item) => item.id === modelId);
    if (removedIndex < 0) return;
    const removed = currentModels[removedIndex]!;
    const removedEntry: AiGatewayModelSelection = {
      id: removed.id,
      ...(removed.efforts ? { efforts: [...removed.efforts] } : {}),
      ...(removed.fast ? { fast: true } : {}),
    };
    const remaining = currentModels.filter((item) => item.id !== modelId);
    const found = catalogByModelId.get(modelId);
    const providerId = (found?.provider.id ?? launchProviderFromModelId(modelId) ?? "claude") as AiGatewayProviderId;
    const stillHasProvider = remaining.some((item) => {
      const p = catalogByModelId.get(item.id)?.provider.id ?? launchProviderFromModelId(item.id);
      return p === providerId;
    });
    const currentPriority = (latestSelection.providerPriority ?? []).filter((id): id is AiGatewayProviderId => true);
    const priorityIndex = currentPriority.indexOf(providerId);
    const dropPriority = !stillHasProvider && priorityIndex >= 0;
    const nextPriority = dropPriority ? currentPriority.filter((id) => id !== providerId) : undefined;
    saveModels(remaining, nextPriority);

    if (onUndo && translate) {
      const name = found?.model.name ?? findRosterRow(launchRoster, modelId)?.label ?? prettyModelId(modelId);
      const familyKey = aiGatewayModelFamilyKey(modelId);
      onUndo({
        text: translate("commodore.pool.removedToast", { name }),
        restore: () => {
          const latest = getSystemPromptSettingsStoreState().state?.aiGateway;
          const nextModels = [...(latest?.models ?? [])].filter((item) => aiGatewayModelFamilyKey(item.id) !== familyKey);
          nextModels.splice(Math.max(0, Math.min(removedIndex, nextModels.length)), 0, removedEntry);
          let nextOrder: readonly AiGatewayProviderId[] | undefined;
          if (dropPriority) {
            const order = [...(latest?.providerPriority ?? [])];
            if (!order.includes(providerId)) {
              order.splice(Math.max(0, Math.min(priorityIndex < 0 ? order.length : priorityIndex, order.length)), 0, providerId);
            }
            nextOrder = order;
          }
          saveModels(nextModels, nextOrder);
        },
      });
    }
  }, [enabled, catalogByModelId, launchRoster, saveModels]);

  const toggleEffort = useCallback((view: PoolEntryView, level: string) => {
    const latestModels = getSystemPromptSettingsStoreState().state?.aiGateway?.models ?? enabled;
    const current = latestModels.find((item) => item.id === view.entry.id);
    if (!current || view.ladder.length === 0) return;
    const exposed = current.efforts ?? view.ladder;
    const on = !exposed.includes(level);
    const opted = OPT_IN.filter((candidate) => (candidate === level ? on : exposed.includes(candidate)));
    const nextEfforts = canonicalEffortSelection(
      view.ladder,
      [...view.ladder.filter((candidate) => !OPT_IN.includes(candidate as typeof OPT_IN[number])), ...opted],
    );
    saveModels(
      latestModels.map((item) =>
        item.id === current.id
          ? { id: item.id, ...(item.fast ? { fast: true } : {}), ...(nextEfforts ? { efforts: nextEfforts } : {}) }
          : item,
      ),
    );
  }, [enabled, saveModels]);

  const toggleFast = useCallback((view: PoolEntryView) => {
    const latestModels = getSystemPromptSettingsStoreState().state?.aiGateway?.models ?? enabled;
    saveModels(
      latestModels.map((item) => {
        if (item.id !== view.entry.id) return item;
        const nextFast = item.fast !== true;
        return {
          id: item.id,
          ...(nextFast ? { fast: true } : {}),
          ...(item.efforts ? { efforts: item.efforts } : {}),
        };
      }),
    );
  }, [enabled, saveModels]);

  const togglePriority = useCallback((providerId: AiGatewayProviderId) => {
    const latest = getSystemPromptSettingsStoreState().state?.aiGateway;
    const latestModels = latest?.models ?? enabled;
    const currentPriority = (latest?.providerPriority ?? []).filter((id): id is AiGatewayProviderId => enabledProviderSet.has(id));
    const nextPriority = currentPriority.includes(providerId)
      ? currentPriority.filter((id) => id !== providerId)
      : [...currentPriority, providerId];
    saveModels(latestModels, nextPriority);
  }, [enabled, enabledProviderSet, saveModels]);

  const signature = useMemo(() => {
    const provSig = poolProviders.map((item) => `${item.id}:${item.waiting ? 1 : 0}`).join(",");
    return `${enabled.length}:${usableCount}:${provSig}`;
  }, [enabled.length, usableCount, poolProviders]);

  const chipAria = useCallback((translate: T) => {
    if (entries.length === 0) return translate("commodore.pool.chipEmptyAria");
    const summary = poolProviders.map((item) => {
      const bits: string[] = [];
      if (item.waitingCount > 0) bits.push(translate("commodore.pool.chipWaiting", { n: item.waitingCount }));
      if (item.restingCount > 0) bits.push(translate("commodore.pool.chipResting", { n: item.restingCount }));
      const base = `${launchProviderCaption(item.id)} ${item.count}`;
      return bits.length > 0 ? `${base} (${bits.join(", ")})` : base;
    }).join(", ");
    return translate("commodore.pool.chipAria", { summary, total: entries.length, usable: usableCount });
  }, [entries.length, poolProviders, usableCount]);

  return {
    loading: state === null && settings.loading,
    unavailable: state === null && !settings.loading,
    saving: settings.savingFields.has("aiGateway"),
    error: settings.error,
    providers,
    entries,
    poolProviders,
    usableCount,
    thresholds,
    intelligenceIndex: state?.aiGatewayCatalog.intelligenceIndex ?? null,
    priority,
    providerVisible,
    signature,
    chipAria,
    addModel,
    removeModel,
    toggleEffort,
    toggleFast,
    togglePriority,
    findCatalogModel: useCallback((modelId: string) => catalogByModelId.get(modelId) ?? null, [catalogByModelId]),
  };
}

/**
 * 사이드바 「플러그인」 알약 문법(2장 + "+N", 빈 풀 "＋", 호버/열림 시 벌어짐과 첫 장 -8도)으로
 * 사령관·지휘관 칩과 동일한 박스 없는 ProviderMark를 겹쳐 그린다.
 */
export function RoutingPoolGlyphStack({ providers, animatePop = false }: {
  readonly providers: readonly { readonly id: AiGatewayProviderId; readonly waiting?: boolean }[];
  readonly animatePop?: boolean;
}) {
  const shown = providers.slice(0, providers.length > 3 ? 2 : 3);
  return (
    <span className="commodore-pool-stack" aria-hidden="true">
      {shown.map((item) => (
        <span
          key={item.id}
          className={`commodore-pool-st is-${item.id}${item.waiting ? " is-waiting" : ""}${animatePop ? " is-pop" : ""}`}
        >
          {launchProviderGlyph(item.id)}
        </span>
      ))}
      {providers.length > 3 ? <span className="commodore-pool-st is-more">+{providers.length - 2}</span> : null}
      {providers.length === 0 ? <span className="commodore-pool-plus">＋</span> : null}
    </span>
  );
}

/* ── 라우팅 풀 본문 + '?' 5단계 모션 설명 ─────────────────────────────────── */

export function RoutingPoolHelpButton({ pressed, label, title, onClick }: {
  readonly pressed: boolean;
  readonly label: string;
  readonly title: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="commodore-pool-help-btn"
      aria-pressed={pressed}
      aria-label={label}
      title={title}
      onClick={onClick}
    >
      ?
    </button>
  );
}

export function RoutingPoolPanel({ t, pool, showHelp, onCloseHelp, onOpenQuota, mobile = false }: {
  readonly t: T;
  readonly pool: RoutingPoolData;
  readonly showHelp: boolean;
  readonly onCloseHelp: () => void;
  readonly onOpenQuota: () => void;
  readonly mobile?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [undo, setUndo] = useState<{ readonly text: string; readonly restore: () => void } | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (expandedId && !pool.entries.some((item) => item.entry.id === expandedId)) {
      setExpandedId(null);
    }
  }, [expandedId, pool.entries]);

  useEffect(() => () => {
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
  }, []);

  const triggerUndo = useCallback((next: { readonly text: string; readonly restore: () => void }) => {
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    setUndo(next);
    undoTimerRef.current = window.setTimeout(() => {
      setUndo(null);
      undoTimerRef.current = null;
    }, 5000);
  }, []);

  const handleAdd = (provider: AiGatewayCatalogProvider, model: AiGatewayCatalogModel, sourceEl: HTMLElement | null) => {
    const fromRect = !reducedMotion() && sourceEl ? sourceEl.getBoundingClientRect() : null;
    pool.addModel(provider, model);
    if (!fromRect) return;
    requestAnimationFrame(() => {
      const chip = stripRef.current?.querySelector<HTMLElement>(`[data-pool-id="${CSS.escape(model.id)}"]`);
      if (!chip || typeof chip.animate !== "function") return;
      const toRect = chip.getBoundingClientRect();
      chip.animate(
        [
          { transform: `translate(${fromRect.left - toRect.left}px, ${fromRect.top - toRect.top}px) scale(0.82)`, opacity: 0.45 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 480, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    });
  };

  const handleRemove = (modelId: string) => {
    const chip = stripRef.current?.querySelector<HTMLElement>(`[data-pool-id="${CSS.escape(modelId)}"]`);
    if (chip && !reducedMotion() && typeof chip.animate === "function") {
      const anim = chip.animate(
        [{ transform: "none", opacity: 1 }, { transform: "scale(0.6)", opacity: 0 }],
        { duration: 180, easing: "cubic-bezier(0.4, 0.14, 0.2, 1)", fill: "forwards" },
      );
      anim.onfinish = () => {
        anim.cancel();
        pool.removeModel(modelId, triggerUndo, t);
      };
      return;
    }
    pool.removeModel(modelId, triggerUndo, t);
  };

  if (showHelp) {
    return (
      <div className={`commodore-pool-view${mobile ? " is-mobile" : ""}`}>
        <button type="button" className="commodore-pool-ex-back" onClick={onCloseHelp}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>
          {t("commodore.pool.helpBack")}
        </button>
        <RoutingPoolExplainer t={t} entries={pool.entries} />
        {pool.intelligenceIndex ? (
          <p className="commodore-pool-ex-source">{t("commodore.intel.source", { name: pool.intelligenceIndex.name, date: pool.intelligenceIndex.observedAt })}</p>
        ) : null}
      </div>
    );
  }

  if (pool.loading) {
    return (
      <div className={`commodore-pool-view${mobile ? " is-mobile" : ""}`}>
        <p className="commodore-composer-panel-note">{t("commodore.pool.loading")}</p>
      </div>
    );
  }

  if (pool.unavailable) {
    return (
      <div className={`commodore-pool-view${mobile ? " is-mobile" : ""}`}>
        <p className="commodore-composer-panel-note">{t("commodore.pool.unavailable")}</p>
      </div>
    );
  }

  const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  const matchesModel = (providerId: AiGatewayProviderId, model: AiGatewayCatalogModel) => {
    if (tokens.length === 0) return true;
    const haystack = `${providerId} ${launchProviderCaption(providerId)} ${model.name} ${model.id}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  };

  const expandedView = expandedId ? pool.entries.find((item) => item.entry.id === expandedId) ?? null : null;
  const enabledSet = new Set(pool.entries.map((item) => item.entry.id));
  // 담기 목록은 선택기 로스터에 나오는 공급자만 보인다(로스터가 signed_out·not_connected를 거르고, Claude의 not_connected와
  // 아직 모르는 상태는 남긴다). 이미 담긴 칩은 이 거름과 무관하게 「로그인 대기」로 남는다.
  const catalogGroups = pool.providers.filter((group) => pool.providerVisible(group.id));
  const anyVisibleGroups = catalogGroups.some((group) => group.models.some((model) => matchesModel(group.id, model)));

  return (
    <div className={`commodore-pool-view${mobile ? " is-mobile" : ""}`}>
      {pool.error ? <p className="commodore-composer-panel-note" role="alert">{pool.error}</p> : null}

      <div className="commodore-pool-sum">
        <b>{t("commodore.pool.count", { n: pool.entries.length })}</b>
        {pool.entries.length > 0 ? <span>{t("commodore.pool.usableCount", { n: pool.usableCount })}</span> : null}
      </div>

      <div ref={stripRef} className="commodore-pool-strip">
        {pool.entries.length === 0 ? (
          <div className="commodore-pool-empty">
            <b>{t("commodore.pool.emptyTitle")}</b>
            <span>{t("commodore.pool.emptyBody")}</span>
          </div>
        ) : null}
        {pool.entries.map((item) => {
          const isExpanded = expandedId === item.entry.id;
          const stText = item.status.kind === "wait"
            ? t("commodore.pool.stateWaiting")
            : item.status.kind === "rest"
              ? t("commodore.pool.stateResting")
              : "";
          const leadText = item.lead ? t("commodore.intel.chipLead", { effort: effortWord(item.lead.effort), n: item.lead.score }) : "";
          const title = [`${item.name} · ${stText || t("commodore.pool.ready")}`, leadText].filter(Boolean).join("\n");
          const chipClass = `commodore-pool-pchip${item.status.kind === "wait" ? " is-waiting" : item.status.kind === "rest" ? " is-resting" : ""}${isExpanded ? " is-expanded" : ""}`;
          return (
            <span key={item.entry.id} data-pool-id={item.entry.id} className={chipClass}>
              <button
                type="button"
                className="commodore-pool-pchip-main"
                aria-expanded={isExpanded}
                title={title}
                onClick={() => setExpandedId((current) => (current === item.entry.id ? null : item.entry.id))}
              >
                <ProviderMark provider={item.provider} />
                <span className="commodore-pool-pchip-nm">{item.name}</span>
                {stText ? <span className="commodore-pool-pchip-st">{stText}</span> : null}
                {item.lead ? <RankMark role="lead" className="commodore-pool-pchip-rank" /> : null}
                <span className={`commodore-pool-sdot is-${item.status.kind}`} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="commodore-pool-pchip-x"
                disabled={pool.saving}
                aria-label={t("commodore.pool.removeAria", { name: item.name })}
                onClick={() => handleRemove(item.entry.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
              </button>
            </span>
          );
        })}
      </div>

      {expandedView ? (
        <PoolDetailBox
          t={t}
          view={expandedView}
          leadThreshold={pool.thresholds?.lead ?? null}
          saving={pool.saving}
          onToggleEffort={(level) => pool.toggleEffort(expandedView, level)}
          onToggleFast={() => pool.toggleFast(expandedView)}
          onOpenQuota={onOpenQuota}
        />
      ) : null}

      {pool.thresholds ? (
        <PoolIntelligence
          t={t}
          entries={pool.entries}
          leadThreshold={pool.thresholds.lead}
          showSpread={!mobile}
        />
      ) : null}

      <div className="commodore-pool-add-head">
        <b>{t("commodore.pool.addHead")}</b>
        <input
          type="search"
          className="commodore-pool-find"
          value={query}
          placeholder={t("commodore.pool.findPlaceholder")}
          aria-label={t("commodore.pool.findAria")}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {!anyVisibleGroups && tokens.length > 0 ? (
        <p className="commodore-composer-panel-note">{t("commodore.pool.findEmpty", { query: query.trim() })}</p>
      ) : null}

      <div className="commodore-pool-groups">
        {catalogGroups.map((group) => {
          const rows = group.models.filter((model) => matchesModel(group.id, model));
          if (rows.length === 0) return null;
          const inPool = pool.entries.some((item) => item.provider === group.id);
          const priorityIndex = pool.priority.indexOf(group.id);
          return (
            <div key={group.id} className="commodore-pool-pgroup">
              <div className="commodore-pool-pgroup-head">
                <span className="commodore-composer-group-caption">{launchProviderCaption(group.id)}</span>
                {inPool ? (
                  <button
                    type="button"
                    className="commodore-pool-pin"
                    aria-pressed={priorityIndex >= 0}
                    disabled={pool.saving}
                    title={t("commodore.pool.pinHint")}
                    onClick={() => pool.togglePriority(group.id)}
                  >
                    {priorityIndex >= 0 ? <span className="commodore-pool-pin-n">{priorityIndex + 1}</span> : null}
                    {t("commodore.pool.pin")}
                  </button>
                ) : null}
              </div>
              {rows.map((model) => {
                const isIn = enabledSet.has(model.id);
                const subtitle = shortModelSubtitle(model.id, t, model.description);
                const addScores: IntelligenceScores = model.intelligence ?? {};
                const addPick = pool.thresholds ? qualifying(addScores, model.effort?.levels ?? [], pool.thresholds.lead) : null;
                const addBest = Object.values(addScores).filter((score): score is number => typeof score === "number");
                return (
                  <div key={model.id} className="commodore-pool-mrow">
                    <ProviderMark provider={group.id} />
                    <span className="commodore-pool-mrow-nm">
                      {model.name}
                      {subtitle ? <small>{subtitle}</small> : null}
                    </span>
                    {pool.thresholds ? (
                      addPick ? (
                        <span className="commodore-intel-from commodore-pool-mrow-intel"><RankMark role="lead" />{t("commodore.intel.addLead", { effort: effortWord(addPick.effort) })}</span>
                      ) : (
                        <span className="commodore-intel-none commodore-pool-mrow-intel">{addBest.length > 0 ? t("commodore.intel.addBest", { n: Math.max(...addBest) }) : t("commodore.intel.noScore")}</span>
                      )
                    ) : null}
                    <button
                      type="button"
                      className={`commodore-pool-add-btn${isIn ? " is-in" : ""}`}
                      disabled={pool.saving}
                      aria-label={isIn ? t("commodore.pool.removeRowAria", { name: model.name }) : t("commodore.pool.addAria", { name: model.name })}
                      onClick={(event) => (isIn ? handleRemove(model.id) : handleAdd(group, model, event.currentTarget))}
                    >
                      {isIn ? t("commodore.pool.addedBtn") : t("commodore.pool.addBtn")}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {undo ? (
        <div className="commodore-pool-toast" role="status">
          <span>{undo.text}</span>
          <button type="button" onClick={() => { undo.restore(); setUndo(null); }}>{t("commodore.pool.undo")}</button>
        </div>
      ) : null}
    </div>
  );
}

function PoolDetailBox({ t, view, leadThreshold, saving, onToggleEffort, onToggleFast, onOpenQuota }: {
  readonly t: T;
  readonly view: PoolEntryView;
  readonly leadThreshold: number | null;
  readonly saving: boolean;
  readonly onToggleEffort: (level: string) => void;
  readonly onToggleFast: () => void;
  readonly onOpenQuota: () => void;
}) {
  const exposed = view.entry.efforts ?? view.ladder;
  return (
    <div className="commodore-pool-detail">
      {view.status.kind === "wait" ? (
        <div className="commodore-pool-state-line">
          <span className="commodore-pool-sdot is-wait" aria-hidden="true" />
          <span>{t("commodore.pool.detailWait", { provider: launchProviderCaption(view.provider) })}</span>
          <button type="button" className="commodore-pool-link-btn" onClick={onOpenQuota}>{t("commodore.pool.detailWaitAction")}</button>
        </div>
      ) : null}
      {view.status.kind === "rest" ? (
        <div className="commodore-pool-state-line">
          <span className="commodore-pool-sdot is-rest" aria-hidden="true" />
          <span>{view.status.resetAtText ? t("commodore.pool.detailRest", { time: view.status.resetAtText }) : t("commodore.pool.detailRestNoTime")}</span>
        </div>
      ) : null}
      <div className="commodore-pool-detail-row">
        <span>{t("commodore.pool.detailEffort")}</span>
        {view.ladder.length === 0 ? (
          <span className="commodore-pool-detail-muted">{t("commodore.pool.detailNoEffort")}</span>
        ) : (
          view.ladder.map((level) => {
            const score = view.scores[level];
            const met = leadThreshold !== null && typeof score === "number" && score >= leadThreshold;
            const scoreTag = leadThreshold !== null ? <em className={`commodore-pool-opt-score${typeof score === "number" ? "" : " is-none"}`}>{typeof score === "number" ? score : "–"}</em> : null;
            if (BASE_EFFORTS.has(level)) {
              return <span key={level} className={`commodore-pool-opt is-fixed${met ? " is-met" : ""}`}>{level.toUpperCase()}{scoreTag}</span>;
            }
            const on = exposed.includes(level);
            return (
              <button
                key={level}
                type="button"
                className={`commodore-pool-opt${met ? " is-met" : ""}`}
                aria-pressed={on}
                disabled={saving}
                onClick={() => onToggleEffort(level)}
              >
                {on ? "✓ " : "+ "}{level.toUpperCase()}{scoreTag}
              </button>
            );
          })
        )}
      </div>
      {view.fastSupported ? (
        <div className="commodore-pool-detail-row">
          <span>{t("commodore.pool.detailSpeed")}</span>
          <button
            type="button"
            className="commodore-pool-opt"
            aria-pressed={view.entry.fast === true}
            disabled={saving}
            onClick={onToggleFast}
          >
            {view.entry.fast === true ? "✓ Fast" : "Fast"}
          </button>
        </div>
      ) : null}
      {leadThreshold !== null ? <p className="commodore-pool-detail-intel">{detailIntelligenceNote(t, view, leadThreshold)}</p> : null}
      <p className="commodore-pool-detail-hint">{t("commodore.pool.detailEffortHint")}</p>
    </div>
  );
}

function detailIntelligenceNote(t: T, view: PoolEntryView, leadThreshold: number): string {
  if (!hasAnyScore(view.scores)) return t("commodore.intel.readNone");
  if (view.lead) {
    return view.lead.effort === "max"
      ? t("commodore.intel.detailLeadMax", { n: view.lead.score })
      : t("commodore.intel.detailLead", { effort: effortWord(view.lead.effort), n: view.lead.score });
  }
  const reach = qualifying(view.scores, view.ladder, leadThreshold);
  return reach
    ? t("commodore.intel.insEnable", { effort: effortWord(reach.effort), n: reach.score })
    : t("commodore.intel.detailNever");
}

/* ── 풀 지능 분포 ─────────────────────────────────────────────────────────── */

const SPREAD_FLOOR = 10;
const SPREAD_CEIL = 70;
const spreadAt = (score: number) => ((Math.min(SPREAD_CEIL, Math.max(SPREAD_FLOOR, score)) - SPREAD_FLOOR) / (SPREAD_CEIL - SPREAD_FLOOR)) * 100;

/**
 * 풀 모델마다 강도별 지능 점수를 한 축에 찍는다(채운 점: 켜 둔 강도, 빈 점: 꺼 둔 강도). 표시 전용이다.
 */
function PoolIntelligence({ t, entries, leadThreshold, showSpread }: {
  readonly t: T;
  readonly entries: readonly PoolEntryView[];
  readonly leadThreshold: number;
  readonly showSpread: boolean;
}) {
  if (!showSpread || entries.length === 0) return null;
  const ticks = [...new Set([10, 20, 30, 40, 50, 60, 70, leadThreshold])].sort((a, b) => a - b);
  return (
    <section className="commodore-pool-intel" aria-label={t("commodore.intel.specTitle")}>
      <div className="commodore-pool-intel-head">
        <b>{t("commodore.intel.specTitle")}</b>
        <span>
          <span><i className="commodore-pool-intel-key" aria-hidden="true" />{t("commodore.intel.specOn")}</span>
          <span><i className="commodore-pool-intel-key is-off" aria-hidden="true" />{t("commodore.intel.specOff")}</span>
        </span>
      </div>
      <div className="commodore-pool-intel-grid">
        <div className="commodore-pool-intel-row is-axis" aria-hidden="true">
          <span className="commodore-pool-intel-zone-lbl">{t("commodore.intel.specZone", { t: leadThreshold })}</span>
          <span className="commodore-pool-intel-axis">
            {ticks.map((tick) => <span key={tick} className={tick === leadThreshold ? "is-th" : undefined} style={{ left: `${spreadAt(tick)}%` }}>{tick}</span>)}
          </span>
          <span />
        </div>
        {entries.map((item) => {
          const known = item.ladder.filter((level) => typeof item.scores[level] === "number");
          const values = known.map((level) => item.scores[level] as number);
          const exposedScores = item.exposed.map((level) => item.scores[level]).filter((score): score is number => typeof score === "number");
          const best = exposedScores.length > 0 ? Math.max(...exposedScores) : null;
          const dim = item.status.kind !== "ok";
          return (
            <div key={item.entry.id} className={`commodore-pool-intel-row${dim ? " is-dim" : ""}`} role="img" aria-label={`${t("commodore.intel.specAria", { name: item.name })}: ${known.map((level) => `${effortWord(level)} ${item.scores[level]}`).join(", ") || t("commodore.intel.noScore")}`}>
              <span className="commodore-pool-intel-nm"><ProviderMark provider={item.provider} /><span>{item.name}</span></span>
              <span className="commodore-pool-intel-track">
                {known.length === 0 ? <span className="commodore-pool-intel-na">{t("commodore.intel.noScore")}</span> : (
                  <>
                    <span className="commodore-pool-intel-zone" style={{ left: `${spreadAt(leadThreshold)}%` }} />
                    <span className="commodore-pool-intel-range" style={{ left: `${spreadAt(Math.min(...values))}%`, width: `${spreadAt(Math.max(...values)) - spreadAt(Math.min(...values))}%` }} />
                    {known.map((level) => (
                      <span
                        key={level}
                        className={`commodore-pool-intel-dot${item.exposed.includes(level) ? "" : " is-off"}`}
                        style={{ left: `${spreadAt(item.scores[level] as number)}%` }}
                        title={t("commodore.intel.effortTitle", { effort: effortWord(level), n: item.scores[level] as number })}
                      />
                    ))}
                  </>
                )}
              </span>
              <span className={`commodore-pool-intel-val${best !== null && best >= leadThreshold ? " is-met" : ""}`}>{best ?? "–"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── '?' 5단계 모션 그래픽 ────────────────────────────────────────────────── */

interface SampleExplainerItem {
  readonly id: string;
  readonly provider: AiGatewayProviderId;
  readonly name: string;
  readonly ladder: readonly string[];
  readonly statusKind: PoolModelStatusKind;
  readonly headroom: number;
}

const SAMPLE_EXPLAINER_ITEMS: readonly SampleExplainerItem[] = [
  { id: "opus", provider: "claude", name: "Opus", ladder: ["low", "medium", "high", "xhigh", "max"], statusKind: "ok", headroom: 64 },
  { id: "sonnet", provider: "claude", name: "Sonnet", ladder: ["low", "medium", "high"], statusKind: "ok", headroom: 58 },
  { id: "codex--gpt-5.4", provider: "codex", name: "GPT", ladder: ["low", "medium", "high", "xhigh"], statusKind: "rest", headroom: 0 },
];

function RoutingPoolExplainer({ t, entries }: {
  readonly t: T;
  readonly entries: readonly PoolEntryView[];
}) {
  const isSample = entries.length === 0;
  const items = useMemo<readonly SampleExplainerItem[]>(() => {
    if (isSample) return SAMPLE_EXPLAINER_ITEMS;
    return entries.slice(0, 6).map((item) => ({
      id: item.entry.id,
      provider: item.provider,
      name: item.name,
      ladder: item.ladder,
      statusKind: item.status.kind,
      headroom: item.status.headroom,
    }));
  }, [entries, isSample]);
  const overflow = isSample ? 0 : Math.max(0, entries.length - 6);

  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 460, height: 276 });

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setStageSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    const dur = step === 4 ? 4200 : 3000;
    const timer = window.setTimeout(() => setStep((current) => (current + 1) % 5), dur);
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  const waiting = items.filter((item) => item.statusKind === "wait");
  const resting = items.filter((item) => item.statusKind === "rest");
  const usable = items.filter((item) => item.statusKind === "ok");

  const pickJudge = usable.find((item) => item.ladder.includes("high")) ?? usable[0] ?? null;
  const fallbackList = (usable.length > 0 ? usable : items).slice().sort((left, right) => right.headroom - left.headroom);
  const pickFallback = fallbackList.find((item) => item.id !== pickJudge?.id) ?? fallbackList[0] ?? null;

  const { width: w, height: h } = stageSize;
  const pad = 10;
  const narrow = w < 380;
  const cardW = narrow ? Math.min(126, Math.round(w * 0.36)) : Math.min(184, Math.max(132, Math.round(w * 0.37)));
  const cardX = w - cardW - pad;
  const gateW = 46;
  const gx = Math.round(cardX - gateW - (narrow ? 12 : 24));
  const availPoolW = Math.max(120, gx - pad - 8);
  const cols = !narrow && availPoolW >= 220 && items.length > 4 ? 3 : 2;
  const cell = narrow ? Math.max(62, Math.floor(availPoolW / cols)) : Math.min(72, Math.max(64, Math.floor(availPoolW / cols)));
  const maxGridBottom = h - 62;
  const rowsNeeded = Math.max(1, Math.ceil(items.length / cols));
  const rowStep = Math.min(60, Math.floor((maxGridBottom - 32) / rowsNeeded));

  const positions = new Map<string, { readonly x: number; readonly y: number; readonly tray: boolean }>();
  const trayQueue: SampleExplainerItem[] = [];
  let rowIndex = 0;
  for (const item of items) {
    const dropped = (step >= 1 && item.statusKind === "wait") || (step >= 2 && item.statusKind === "rest");
    if (dropped) {
      trayQueue.push(item);
      continue;
    }
    const col = rowIndex % cols;
    const row = Math.floor(rowIndex / cols);
    rowIndex += 1;
    const x = Math.round(pad + col * cell);
    const y = Math.round(32 + row * rowStep);
    positions.set(item.id, { x, y, tray: false });
  }
  trayQueue.forEach((item, index) => {
    positions.set(item.id, { x: Math.round(pad + 8 + index * 46), y: h - 42, tray: true });
  });

  const cardH = 62;
  const cardY0 = 32;
  const cardY1 = cardY0 + cardH + 10;

  const linePath = (item: SampleExplainerItem | null, cardTop: number): string | null => {
    if (!item) return null;
    const pos = positions.get(item.id);
    if (!pos) return null;
    const sx = pos.x + (narrow ? 24 : 28) + 14;
    const sy = pos.y + 15;
    const ex = cardX - 2;
    const ey = cardTop + cardH / 2;
    const mx = (sx + ex) / 2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`;
  };

  const line0 = step === 3 ? linePath(pickJudge, cardY0) : null;
  const line1 = step >= 4 ? linePath(pickFallback, cardY1) : null;

  const stepsMeta = [
    { short: t("commodore.pool.ex.step1Short"), head: t("commodore.pool.ex.step1Head"), body: t("commodore.pool.ex.step1Body") },
    { short: t("commodore.pool.ex.step2Short"), head: t("commodore.pool.ex.step2Head"), body: t("commodore.pool.ex.step2Body") },
    { short: t("commodore.pool.ex.step3Short"), head: t("commodore.pool.ex.step3Head"), body: t("commodore.pool.ex.step3Body") },
    { short: t("commodore.pool.ex.step4Short"), head: t("commodore.pool.ex.step4Head"), body: t("commodore.pool.ex.step4Body") },
    { short: t("commodore.pool.ex.step5Short"), head: t("commodore.pool.ex.step5Head"), body: t("commodore.pool.ex.step5Body") },
  ] as const;
  const currentMeta = stepsMeta[step]!;
  let captionBody = currentMeta.body;
  if (step === 1 && waiting.length === 0) captionBody += t("commodore.pool.ex.step2Extra");
  if (step === 2 && resting.length === 0) captionBody += t("commodore.pool.ex.step3Extra");
  if (step >= 3 && usable.length === 0) captionBody = t("commodore.pool.ex.noneReadyBody");
  if (isSample && step === 0) captionBody += t("commodore.pool.ex.sampleExtra");

  return (
    <div className="commodore-pool-ex">
      <div ref={stageRef} className="commodore-pool-ex-stage">
        <span className="commodore-pool-ex-zone" style={{ left: pad }}>
          {t("commodore.pool.ex.zonePool")}{overflow > 0 ? ` · +${overflow}` : ""}
        </span>
        <span className="commodore-pool-ex-zone" style={{ left: cardX }}>
          {t("commodore.pool.ex.zoneWork")}
        </span>
        {isSample ? <span className="commodore-pool-ex-sample">{t("commodore.pool.ex.sampleTag")}</span> : null}
        <div className="commodore-pool-ex-tray"><span>{t("commodore.pool.ex.tray")}</span></div>

        <div className={`commodore-pool-ex-gate${step === 1 ? " is-on" : ""}`} style={{ left: gx, top: 36 }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></svg>
          {t("commodore.pool.ex.gateLogin")}
        </div>
        <div className={`commodore-pool-ex-gate${step === 2 ? " is-on" : ""}`} style={{ left: gx, top: 102 }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 11a5.5 5.5 0 0 1 11 0" /><path d="M8 11l2.5-3.5" /></svg>
          {t("commodore.pool.ex.gateQuota")}
        </div>
        <div
          className={`commodore-pool-ex-judge${step >= 3 ? " is-on" : ""}${step >= 4 ? " is-fail" : ""}`}
          style={{ left: Math.max(pad, Math.round((cardX - 120) * 0.55)), top: 10 }}
        >
          <svg className="spark" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.6 4.2L14 7.3l-4.4 1.6L8 13.2 6.4 8.9 2 7.3l4.4-1.6z" /></svg>
          <span>{t("commodore.pool.ex.judge")}</span>
        </div>

        <div className={`commodore-pool-ex-card${step >= 3 ? " is-on" : ""}${step >= 3 && pickJudge ? " is-done" : ""}`} style={{ left: cardX, top: cardY0, width: cardW }}>
          <span className="who">{t("commodore.pool.ex.taskCommander")}</span>
          <span className="task">{t("commodore.pool.ex.taskCommanderWork")}</span>
          <span className="seat">
            {step >= 3 ? (
              pickJudge ? (
                <>
                  <ProviderMark provider={pickJudge.provider} />
                  <b>{pickJudge.name}</b>
                  {pickJudge.ladder.includes("high") ? <span className="eff">HIGH</span> : null}
                  <span>{t("commodore.pool.ex.viaJudge")}</span>
                </>
              ) : t("commodore.pool.ex.seatNone")
            ) : t("commodore.pool.ex.seatPending")}
          </span>
        </div>

        <div className={`commodore-pool-ex-card${step >= 4 ? " is-on" : ""}${step >= 4 && pickFallback ? " is-done" : ""}`} style={{ left: cardX, top: cardY1, width: cardW }}>
          <span className="who">{t("commodore.pool.ex.taskMember")}</span>
          <span className="task">{t("commodore.pool.ex.taskMemberWork")}</span>
          <span className="seat">
            {step >= 4 ? (
              pickFallback ? (
                <>
                  <ProviderMark provider={pickFallback.provider} />
                  <b>{pickFallback.name}</b>
                  {pickFallback.ladder.includes("medium") ? <span className="eff">MEDIUM</span> : null}
                  <span>{t("commodore.pool.ex.viaFallback")}</span>
                </>
              ) : t("commodore.pool.ex.seatNone")
            ) : t("commodore.pool.ex.seatPending")}
          </span>
        </div>

        <svg className="commodore-pool-ex-lines" aria-hidden="true">
          {line0 ? <path d={line0} className="is-on" /> : null}
          {line1 ? <path d={line1} className="is-on" /> : null}
        </svg>

        {items.map((item) => {
          const pos = positions.get(item.id) ?? { x: pad, y: 32, tray: false };
          const isWait = pos.tray && item.statusKind === "wait";
          const isRest = pos.tray && item.statusKind === "rest";
          const isPick = (step === 3 && pickJudge?.id === item.id) || (step === 4 && pickFallback?.id === item.id);
          const cls = `commodore-pool-ex-tile is-${item.provider}${pos.tray ? " is-tray" : ""}${isWait ? " is-wait" : ""}${isRest ? " is-rest" : ""}${isPick ? " is-pick" : ""}`;
          return (
            <div key={item.id} className={cls} style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
              <span className="face">
                {launchProviderGlyph(item.provider)}
                <span className="badge" aria-hidden="true">
                  {isWait ? (
                    <svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></svg>
                  ) : isRest ? (
                    <svg viewBox="0 0 16 16"><path d="M12.5 9.5A5 5 0 0 1 6.5 3.5a5 5 0 1 0 6 6z" /></svg>
                  ) : null}
                </span>
              </span>
              <span className="lbl">{item.name}</span>
            </div>
          );
        })}
      </div>

      <div key={step} className="commodore-pool-ex-caption">
        <b>{currentMeta.head}</b>
        <p>{captionBody}</p>
      </div>

      <div className="commodore-pool-ex-nav">
        <div className="commodore-pool-ex-steps" role="group" aria-label={t("commodore.pool.ex.stepsAria")}>
          {stepsMeta.map((item, index) => (
            <button
              key={item.short}
              type="button"
              aria-current={index === step ? "step" : undefined}
              onClick={() => { setPlaying(false); setStep(index); }}
            >
              {index + 1} {item.short}
              <span className={`bar${index === step && playing ? " run" : ""}`} style={{ ["--dur" as string]: `${index === 4 ? 4200 : 3000}ms` }} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="commodore-pool-ex-play"
          aria-label={playing ? t("commodore.pool.ex.pause") : t("commodore.pool.ex.play")}
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? (
            <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2" width="2.6" height="8" rx=".6" /><rect x="6.9" y="2" width="2.6" height="8" rx=".6" /></svg>
          ) : (
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6z" /></svg>
          )}
        </button>
      </div>
    </div>
  );
}
