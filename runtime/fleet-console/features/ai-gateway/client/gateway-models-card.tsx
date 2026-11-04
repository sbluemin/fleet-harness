import { aiGatewayModelFamilyKey, canonicalEffortSelection, defaultEffortSelection, isProviderCatalogVisible } from "@fleet-console/ai-gateway/model-family";
import { SegmentedThumb } from "@fleet-console/ui/react";
import * as React from "react";

import { OBJECTIVE_CATALOG_CHANGED_EVENT } from "../../execution/client/objective-records.js";
import { getT, useTerminalLocale } from "../../execution/client/agent/i18n/index.js";
import { requestQuotaPanelOpen } from "../../quota/client/toolbar-summary.js";
import { createPortal } from "react-dom";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { SettingsGroup, SettingsItem, SettingsSubScreenRow, SettingsToggle } from "../../settings/client/preferences-context.js";
import { Select, useMobileSettingsHost } from "../../settings/client/mobile-host.js";
import {
  getSystemPromptSettingsStoreState,
  loadSystemPromptSettings,
  setSystemPromptSettingsField,
  useSystemPromptSettingsStore,
  type AiGatewayCatalogModel,
  type AiGatewayCatalogProvider,
  type AiGatewayProviderId,
  type AiGatewaySettings,
} from "../../settings/client/execution-settings.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore, type ModelAuthProviderState } from "./model-auth.js";
import { launchProviderGlyph, serviceGlyph } from "./components/launch-provider-glyphs.js";

const PROVIDER_LABEL = {
  antigravity: "terminal.settings.aiGatewayProviderAntigravity",
  claude: "terminal.settings.aiGatewayProviderClaude",
  codex: "terminal.settings.aiGatewayProviderCodex",
  xai: "terminal.settings.aiGatewayProviderXai",
  "muse-code": "terminal.settings.aiGatewayProviderMuseCode",
} as const;

const OPT_IN = ["xhigh", "max"] as const;

interface FamilyVariant {
  readonly model: AiGatewayCatalogModel;
  readonly fast: boolean;
  readonly windowLabel: string;
}

interface ModelFamily {
  readonly key: string;
  readonly name: string;
  readonly variants: readonly FamilyVariant[];
}

function windowLabel(contextWindow: number | null): string {
  if (contextWindow === null) return "";
  return contextWindow >= 1_000_000 ? "1M" : `${Math.round(contextWindow / 1000)}K`;
}

function groupFamilies(models: readonly AiGatewayCatalogModel[]): ModelFamily[] {
  const groups = new Map<string, FamilyVariant[]>();
  for (const model of models) {
    const key = aiGatewayModelFamilyKey(model.id);
    const variant = { model, fast: model.fast, windowLabel: windowLabel(model.contextWindow) };
    const list = groups.get(key);
    if (list) list.push(variant);
    else groups.set(key, [variant]);
  }
  return [...groups.entries()].map(([key, variants]) => {
    const ordered = [...variants].sort((a, b) =>
      (a.model.contextWindow ?? 0) - (b.model.contextWindow ?? 0) || Number(a.fast) - Number(b.fast));
    const named = ordered.find((variant) => !variant.fast) ?? ordered[0];
    const name = ordered.length > 1 && named
      ? named.model.name.replace(/-fast$/i, "").replace(/-(\d+[km])$/i, "")
      : named?.model.name ?? key;
    return { key, name, variants: ordered };
  });
}

function windowsOf(family: ModelFamily): string[] {
  const labels: string[] = [];
  for (const variant of family.variants) {
    if (variant.windowLabel && !labels.includes(variant.windowLabel)) labels.push(variant.windowLabel);
  }
  return labels;
}

function hasFastPair(family: ModelFamily): boolean {
  return family.variants.some((variant) => variant.fast) && family.variants.some((variant) => !variant.fast);
}

/**
 * 알약만의 표시. 위임 후보 수는 이 값이 아니라 `isProviderCatalogVisible`로 센다.
 *
 * 동의만 꺼진 Claude는 자격이 로그아웃이 아니라서 후보로 남는다. 알약을 "확인 중"으로
 * 두면 조회가 곧 끝난다는 뜻이 되어, 동의를 켜기 전에는 영원히 그 문구가 남는다.
 */
export function gatewayLoginKind(provider: string | undefined, status: string | null | undefined): "in" | "out" | "unknown" | "unlinked" {
  if (provider === "claude" && status === "not_connected") return "unlinked";
  if (status == null) return "unknown";
  if (status === "signed_out" || status === "not_connected") return "out";
  return "in";
}

function orderProviders(providers: readonly AiGatewayCatalogProvider[]): AiGatewayCatalogProvider[] {
  return [...providers.filter((provider) => provider.id === "claude"), ...providers.filter((provider) => provider.id !== "claude")];
}

export function AiGatewayModelsEntry(): React.ReactElement {
  const t = getT(useTerminalLocale(), true);
  const state = useSystemPromptSettingsStore().state;
  const counts = delegationFamilyCounts(state);
  const summary = [
    t("terminal.settings.aiGatewayDelegationCount", { count: counts.candidates }),
    counts.waiting > 0 ? t("terminal.settings.aiGatewayWaitingLogin", { count: counts.waiting }) : null,
    counts.unknown > 0 ? t("terminal.settings.aiGatewayLoginChecking") : null,
  ].filter(Boolean).join(" · ");
  return (
    <SettingsGroup ariaLabel={t("terminal.settings.aiGatewayModels")}>
      <SettingsSubScreenRow
        label={t("terminal.settings.aiGatewayModels")}
        summary={summary}
        render={() => <AiGatewayModelsCard />}
      />
    </SettingsGroup>
  );
}

function delegationFamilyCounts(state: ReturnType<typeof useSystemPromptSettingsStore>["state"]): { readonly candidates: number; readonly waiting: number; readonly unknown: number } {
  if (!state) return { candidates: 0, waiting: 0, unknown: 0 };
  const ids = new Set((state.aiGateway?.models ?? []).map((entry) => entry.id));
  let candidates = 0;
  let waiting = 0;
  let unknown = 0;
  for (const provider of orderProviders(state.aiGatewayCatalog.providers)) {
    const on = groupFamilies(provider.models).filter((family) => family.variants.some((variant) => ids.has(variant.model.id))).length;
    const status = state.aiGatewayLogin[provider.id];
    if (isProviderCatalogVisible(status, provider.id)) candidates += on;
    else waiting += on;
    if (status == null) unknown += on;
  }
  return { candidates, waiting, unknown };
}

/** OS `prefers-reduced-motion`과 설정의 「움직임 줄이기」. 둘 중 하나면 순서 칩은 미끄러지지 않는다. */
function useMotionReduced(): boolean {
  const settingReduced = useGlobalSettingsStore().state?.reduceMotion === true;
  const [osReduced, setOsReduced] = React.useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  React.useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setOsReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return settingReduced || osReduced;
}

/** 칩이 줄 안에서 보이는 자리. transform이 남아 있으면 레이아웃이 아니라 화면 위치를 읽는다. */
function chipOffset(node: HTMLElement, row: HTMLElement): { x: number; y: number } {
  const chip = node.getBoundingClientRect();
  const host = row.getBoundingClientRect();
  return { x: chip.left - host.left, y: chip.top - host.top };
}

/**
 * 구독 순서 칩의 FLIP. 순서가 바뀌거나 추가·제거로 밀릴 때 이전 자리에서 새 자리로 220ms에 미끄러진다.
 * 저장이 돌아온 뒤의 재렌더도 같은 측정이라, 그 사이에 자리가 안 바뀌면 다시 움직이지 않는다.
 * 이동 중에 다시 누르면 레이아웃이 아니라 지금 보이는 자리에서 잇는다.
 */
function useOrderChipFlip(rowRef: React.RefObject<HTMLElement | null>, signature: string, reduced: boolean): void {
  const positions = React.useRef(new Map<string, { x: number; y: number }>());
  const order = React.useRef<readonly string[]>([]);
  const layerTimers = React.useRef<number[]>([]);
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    for (const timer of layerTimers.current) window.clearTimeout(timer);
    layerTimers.current = [];
    const nodes = [...row.querySelectorAll<HTMLElement>("[data-order-id]")];
    const previous = positions.current;
    const previousOrder = order.current;
    const seen = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      const id = node.dataset.orderId;
      if (!id) continue;
      seen.set(id, node.style.transform ? chipOffset(node, row) : previous.get(id) ?? chipOffset(node, row));
    }
    for (const node of nodes) {
      node.style.transition = "none";
      node.style.transform = "";
    }
    const next = new Map<string, { x: number; y: number }>();
    const moves: { node: HTMLElement; dx: number; dy: number }[] = [];
    for (const node of nodes) {
      const id = node.dataset.orderId;
      if (!id) continue;
      const point = chipOffset(node, row);
      next.set(id, point);
      const from = seen.get(id);
      if (!from || reduced || !previous.has(id)) continue;
      const dx = from.x - point.x;
      const dy = from.y - point.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moves.push({ node, dx, dy });
    }
    positions.current = next;
    order.current = nodes.flatMap((node) => node.dataset.orderId ? [node.dataset.orderId] : []);
    const previousIndex = new Map(previousOrder.map((id, index) => [id, index]));
    for (const node of nodes) node.style.zIndex = "";
    if (reduced) {
      for (const node of nodes) node.style.transition = "none";
      return;
    }
    if (moves.length === 0) {
      for (const node of nodes) node.style.transition = "";
      return;
    }
    for (const { node, dx, dy } of moves) {
      const id = node.dataset.orderId;
      const before = id ? previousIndex.get(id) : undefined;
      const after = id ? order.current.indexOf(id) : -1;
      node.style.zIndex = before !== undefined && after >= 0 && after < before ? "1" : "";
      node.style.transition = "none";
      node.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    let played = false;
    const frame = requestAnimationFrame(() => {
      played = true;
      for (const { node } of moves) {
        node.style.transition = "transform 220ms ease-out";
        node.style.transform = "";
        layerTimers.current.push(window.setTimeout(() => { node.style.zIndex = ""; }, 220));
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (played) return;
      positions.current = previous;
      order.current = previousOrder;
      for (const { node } of moves) {
        node.style.transform = "";
        node.style.transition = "";
        node.style.zIndex = "";
      }
    };
  }, [rowRef, signature, reduced]);
  React.useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const remember = (): void => {
      const nodes = [...row.querySelectorAll<HTMLElement>("[data-order-id]")];
      if (nodes.some((node) => getComputedStyle(node).transform !== "none")) return;
      const next = new Map<string, { x: number; y: number }>();
      for (const node of nodes) {
        const id = node.dataset.orderId;
        if (id) next.set(id, chipOffset(node, row));
      }
      positions.current = next;
    };
    window.addEventListener("resize", remember);
    row.addEventListener("transitionend", remember);
    return () => {
      window.removeEventListener("resize", remember);
      row.removeEventListener("transitionend", remember);
    };
  }, [rowRef, signature]);
}

export function AiGatewayModelsCard(): React.ReactElement {
  const mobile = useMobileSettingsHost() !== null;
  const t = getT(useTerminalLocale(), mobile);
  const settings = useSystemPromptSettingsStore();
  const orderRowRef = React.useRef<HTMLDivElement>(null);
  const motionReduced = useMotionReduced();
  const gateway = settings.state?.aiGateway;
  const orderSignature = gateway
    ? `${(gateway.providerPriority ?? []).join("\0")}\n${(gateway.models ?? []).map((entry) => entry.id).join("\0")}`
    : "";
  useOrderChipFlip(orderRowRef, orderSignature, motionReduced);
  const auth = useModelAuthStore();
  const state = settings.state;
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
  const [undo, setUndo] = React.useState<{ readonly text: string; readonly restore: () => void } | null>(null);
  const saving = settings.savingFields.has("aiGateway");

  React.useEffect(() => {
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);
  React.useEffect(() => {
    const reload = () => { void loadSystemPromptSettings(); };
    window.addEventListener(OBJECTIVE_CATALOG_CHANGED_EVENT, reload);
    return () => window.removeEventListener(OBJECTIVE_CATALOG_CHANGED_EVENT, reload);
  }, []);
  React.useEffect(() => {
    if (!undo) return undefined;
    const timer = window.setTimeout(() => setUndo(null), 5000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  if (!state) {
    return <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayModels")}><p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p></section>;
  }

  const selection = state.aiGateway ?? {};
  const enabled = selection.models ?? [];
  const providers = orderProviders(state.aiGatewayCatalog.providers);
  const families = providers.map((provider) => ({ provider, families: groupFamilies(provider.models) }));
  const enabledIds = new Set(enabled.map((entry) => entry.id));
  const providerHasEnabled = (provider: AiGatewayCatalogProvider) => groupFamilies(provider.models).some((family) => family.variants.some((variant) => enabledIds.has(variant.model.id)));
  const enabledProviders = providers.filter(providerHasEnabled);
  const priority = (selection.providerPriority ?? []).filter((id): id is AiGatewayProviderId => enabledProviders.some((provider) => provider.id === id));
  const loginOf = (id: string) => state.aiGatewayLogin[id as AiGatewayProviderId] ?? null;
  const counts = delegationFamilyCounts(state);
  const services = auth.state?.providers.filter((entry) => entry.kind === "service") ?? [];

  const saveModels = (models: AiGatewaySettings["models"], providerPriority?: readonly AiGatewayProviderId[]): void => {
    void setSystemPromptSettingsField("aiGateway", providerPriority !== undefined ? { models: models ?? [], providerPriority } : { models: models ?? [] });
  };
  const replaceVariant = (family: ModelFamily, nextId: string): void => {
    const current = family.variants.find((variant) => enabledIds.has(variant.model.id));
    if (!current || current.model.id === nextId) return;
    saveModels(enabled.map((entry) => entry.id === current.model.id ? { ...entry, id: nextId } : entry));
  };
  const turnOn = (family: ModelFamily): void => {
    if (family.variants.some((variant) => enabledIds.has(variant.model.id))) return;
    const chosen = family.variants.find((variant) => !variant.fast) ?? family.variants[0];
    if (!chosen) return;
    const efforts = defaultEffortSelection(chosen.model.effort?.levels ?? []);
    saveModels([...enabled, { id: chosen.model.id, ...(efforts ? { efforts } : {}) }]);
  };
  const turnOff = (provider: AiGatewayCatalogProvider, family: ModelFamily): void => {
    const current = family.variants.find((variant) => enabledIds.has(variant.model.id));
    if (!current) return;
    const removed = enabled.find((entry) => entry.id === current.model.id);
    if (!removed) return;
    const removedIndex = enabled.findIndex((entry) => entry.id === removed.id);
    const removedEntry = { id: removed.id, ...(removed.efforts ? { efforts: [...removed.efforts] } : {}) };
    const remaining = enabled.filter((entry) => entry.id !== removed.id);
    const providerId = provider.id as AiGatewayProviderId;
    const still = groupFamilies(provider.models).some((other) => other.variants.some((variant) => remaining.some((entry) => entry.id === variant.model.id)));
    const dropPriority = !still && priority.includes(providerId);
    const priorityIndex = priority.indexOf(providerId);
    const nextPriority = dropPriority ? priority.filter((id) => id !== providerId) : undefined;
    saveModels(remaining, nextPriority);
    setUndo({
      text: t("terminal.settings.aiGatewayRemoved", { name: family.name }),
      // 끄기 전 목록 전체를 다시 쓰지 않는다. 그 사이 켠 모델·바꾼 순서는 남기고, 뺀 항목만 원래 자리에 넣는다.
      restore: () => {
        const latest = getSystemPromptSettingsStoreState().state?.aiGateway;
        const models = [...(latest?.models ?? [])].filter((entry) => aiGatewayModelFamilyKey(entry.id) !== family.key);
        models.splice(Math.max(0, Math.min(removedIndex, models.length)), 0, removedEntry);
        let providerPriority: readonly AiGatewayProviderId[] | undefined;
        if (dropPriority) {
          const order = [...(latest?.providerPriority ?? [])];
          if (!order.includes(providerId)) {
            order.splice(Math.max(0, Math.min(priorityIndex < 0 ? order.length : priorityIndex, order.length)), 0, providerId);
          }
          providerPriority = order;
        }
        saveModels(models, providerPriority);
      },
    });
  };
  const setOptIn = (family: ModelFamily, level: string, on: boolean): void => {
    const current = enabled.find((entry) => family.variants.some((variant) => variant.model.id === entry.id));
    const ladder = current ? family.variants.find((variant) => variant.model.id === current.id)?.model.effort?.levels ?? [] : [];
    if (!current) return;
    const opted = OPT_IN.filter((entry) => entry === level ? on : (current.efforts ?? ladder).includes(entry));
    const efforts = canonicalEffortSelection(ladder, [...ladder.filter((entry) => !OPT_IN.includes(entry as typeof OPT_IN[number])), ...opted]);
    saveModels(enabled.map((entry) => entry.id === current.id ? { id: entry.id, ...(efforts ? { efforts } : {}) } : entry));
  };

  const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  const visible = (provider: AiGatewayCatalogProvider, family: ModelFamily) => {
    if (tokens.length === 0) return true;
    const haystack = `${provider.id} ${t(PROVIDER_LABEL[provider.id as AiGatewayProviderId])} ${family.name} ${family.variants.map((variant) => `${variant.model.name} ${variant.model.id} ${variant.windowLabel}`).join(" ")}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  };

  return (
    <section className="global-settings-card ai-gateway-models" aria-label={t("terminal.settings.aiGatewayModels")}>
      {mobile ? null : (
        <div className="ai-gateway-roster-head">
          <h3 className="global-settings-card-title ai-gateway-roster-title">{t("terminal.settings.aiGatewayModels")}</h3>
        </div>
      )}
      <p className="ai-gateway-models-lead">{t("terminal.settings.aiGatewayModelsHelp")}</p>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {auth.error ? <p className="global-settings-error" role="alert">{auth.error}</p> : null}
      <div className="ai-gateway-order">
        <p className="ai-gateway-order-title">{t("terminal.settings.aiGatewaySpendFirst")}</p>
        <div className="ai-gateway-order-row" ref={orderRowRef}>
          {priority.map((id, index) => (
            <span key={id} className="ai-gateway-order-chip" data-order-id={id}>
              <span className="ai-gateway-order-index">{index + 1}</span>
              <span className="ai-gateway-provider-glyph" aria-hidden="true">{launchProviderGlyph(id)}</span>
              <span>{t(PROVIDER_LABEL[id])}</span>
              <button type="button" disabled={saving || index === 0} aria-label={t("terminal.settings.aiGatewayMoveEarlier", { name: t(PROVIDER_LABEL[id]) })} onClick={() => saveModels(enabled, move(priority, index, -1))}>◀</button>
              <button type="button" disabled={saving || index === priority.length - 1} aria-label={t("terminal.settings.aiGatewayMoveLater", { name: t(PROVIDER_LABEL[id]) })} onClick={() => saveModels(enabled, move(priority, index, 1))}>▶</button>
              <button type="button" disabled={saving} aria-label={t("terminal.settings.aiGatewayRemoveFromOrder", { name: t(PROVIDER_LABEL[id]) })} onClick={() => saveModels(enabled, priority.filter((entry) => entry !== id))}>✕</button>
            </span>
          ))}
          {enabledProviders.filter((provider) => !priority.includes(provider.id as AiGatewayProviderId)).map((provider) => (
            <button key={provider.id} type="button" className="ai-gateway-order-add" disabled={saving} onClick={() => saveModels(enabled, [...priority, provider.id as AiGatewayProviderId])}>
              {t("terminal.settings.aiGatewayAddToOrder", { name: t(PROVIDER_LABEL[provider.id as AiGatewayProviderId]) })}
            </button>
          ))}
        </div>
        <p className="ai-gateway-inline-hint">{t("terminal.settings.aiGatewaySpendHint")}</p>
      </div>
      <div className="ai-gateway-find">
        <input className="ai-gateway-find-input" value={query} placeholder={t("terminal.settings.aiGatewayFindModel")} aria-label={t("terminal.settings.aiGatewayFindModel")} onChange={(event) => setQuery(event.target.value)} />
        <span className="ai-gateway-roster-count">
          {t("terminal.settings.aiGatewayDelegationCount", { count: counts.candidates })}
          {counts.waiting > 0 ? ` · ${t("terminal.settings.aiGatewayWaitingLogin", { count: counts.waiting })}` : ""}
          {counts.unknown > 0 ? ` · ${t("terminal.settings.aiGatewayLoginChecking")}` : ""}
        </span>
      </div>
      <div className="ai-gateway-groups">
        {families.map(({ provider, families: rows }) => {
          const shown = rows.filter((family) => visible(provider, family));
          if (shown.length === 0) return null;
          const id = provider.id as AiGatewayProviderId;
          const name = t(PROVIDER_LABEL[id]);
          const open = query.trim().length > 0 || !collapsed.has(provider.id);
          const onCount = rows.filter((family) => family.variants.some((variant) => enabledIds.has(variant.model.id))).length;
          const kind = gatewayLoginKind(provider.id, loginOf(provider.id));
          const signedOut = kind === "out";
          return (
            <section key={provider.id} className={`settings-group-surface ai-gateway-provider-group ai-gateway-provider is-${provider.id}`} aria-label={name}>
              <div className="ai-gateway-group-head">
              <button type="button" className="ai-gateway-provider-toggle" aria-expanded={open} onClick={() => setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(provider.id)) next.delete(provider.id);
                else next.add(provider.id);
                return next;
              })}>
                <span className="ai-gateway-provider-glyph" aria-hidden="true">{launchProviderGlyph(id)}</span>
                <span className="ai-gateway-provider-name">{name}</span>
              </button>
              {kind === "unlinked" ? (
                <button type="button" className="ai-gateway-login is-unlinked" onClick={() => requestQuotaPanelOpen()}>{t("terminal.settings.aiGatewayUsageUnlinked")}</button>
              ) : (
                <span className={`ai-gateway-login${signedOut ? " is-needed" : kind === "unknown" ? " is-unknown" : ""}`}>{kind === "unknown" ? t("terminal.settings.aiGatewayLoginChecking") : signedOut ? t("terminal.settings.aiGatewayNeedsLogin") : t("terminal.settings.aiGatewaySignedIn")}</span>
              )}
              <span className="ai-gateway-provider-sub">{t("terminal.settings.aiGatewayEnabledCount", { on: onCount, all: rows.length })}</span>
              <span className="ai-gateway-model-chevron" aria-hidden="true" onClick={() => setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(provider.id)) next.delete(provider.id);
                else next.add(provider.id);
                return next;
              })}>{open ? "▾" : "▸"}</span>
              </div>
              {provider.id === "xai" ? <XaiEndpointRow /> : null}
              {open ? (
                <div className="ai-gateway-rows">
                  {signedOut ? (
                    <p className="ai-gateway-signin-note">
                      {t("terminal.settings.aiGatewaySignInNote")}{" "}
                      <button type="button" className="ai-gateway-text-button" onClick={requestQuotaPanelOpen}>{t("terminal.settings.aiGatewayOpenQuota")}</button>
                    </p>
                  ) : null}
                  {shown.map((family) => {
                    const current = family.variants.find((variant) => enabledIds.has(variant.model.id));
                    const on = current !== undefined;
                    const ladder = current?.model.effort?.levels ?? family.variants[0]?.model.effort?.levels ?? [];
                    const storedEfforts = current ? enabled.find((entry) => entry.id === current.model.id)?.efforts : undefined;
                    const exposed = storedEfforts ?? ladder;
                    const wins = windowsOf(family);
                    return (
                      <div key={family.key} className={on ? "ai-gateway-family" : "ai-gateway-family is-off"}>
                        <SettingsToggle checked={on} disabled={saving} ariaLabel={family.name} onChange={() => (on ? turnOff(provider, family) : turnOn(family))} />
                        <div className="ai-gateway-family-name">
                          <span>{family.name}</span>
                          {on ? null : <span className="ai-gateway-model-meta">{[wins.length > 1 ? `${wins[0]}–${wins[wins.length - 1]}` : wins[0], hasFastPair(family) ? t("terminal.settings.aiGatewayFastAvailable") : null].filter(Boolean).join(" · ")}</span>}
                        </div>
                        {on ? (
                          <div className="ai-gateway-family-controls">
                            {wins.length > 1 ? (
                              <Select
                                compact
                                className="ai-gateway-window"
                                popupClassName="ai-gateway-window-menu"
                                label={`${family.name} ${t("terminal.settings.aiGatewayWindow")}`}
                                disabled={saving}
                                value={current.windowLabel}
                                options={wins.map((label) => ({ value: label, label }))}
                                onChange={(value) => {
                                  const next = family.variants.find((variant) => variant.windowLabel === value && variant.fast === current.fast)
                                    ?? family.variants.find((variant) => variant.windowLabel === value);
                                  if (next) replaceVariant(family, next.model.id);
                                }}
                              />
                            ) : <span className="ai-gateway-window-fixed">{wins[0]}</span>}
                            {hasFastPair(family) ? (
                              <button type="button" className={current.fast ? "ai-gateway-fast is-on" : "ai-gateway-fast"} aria-pressed={current.fast} disabled={saving} onClick={() => {
                                const next = family.variants.find((variant) => variant.windowLabel === current.windowLabel && variant.fast !== current.fast);
                                if (next) replaceVariant(family, next.model.id);
                              }}>{current.fast ? "✓ Fast" : "Fast"}</button>
                            ) : null}
                            {ladder.length === 0 ? <span className="ai-gateway-inline-hint">{t("terminal.settings.aiGatewayNoEffort")}</span> : OPT_IN.some((level) => ladder.includes(level)) ? (
                              <span className="ai-gateway-efforts">
                                {OPT_IN.filter((level) => ladder.includes(level)).map((level) => {
                                  const pressed = exposed.includes(level);
                                  return (
                                    <button key={level} type="button" className={pressed ? "ai-gateway-opt is-on" : "ai-gateway-opt"} aria-pressed={pressed} disabled={saving} aria-label={t("terminal.settings.aiGatewayOptIn", { level })} onClick={() => setOptIn(family, level, !pressed)}>
                                      {pressed ? "✓ " : "+ "}{level}
                                    </button>
                                  );
                                })}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {services.length > 0 ? (
        <section className="settings-group-surface ai-gateway-provider-group ai-gateway-provider is-typesafe" aria-label={services[0]?.displayName}>
          <div className="ai-gateway-group-head">
            <span className="ai-gateway-provider-glyph" aria-hidden="true">{serviceGlyph("typesafe")}</span>
            <span className="ai-gateway-provider-name">{services[0]?.displayName}</span>
            <span className="ai-gateway-provider-sub is-strong">{t("terminal.settings.aiGatewayServiceBadge")}</span>
          </div>
          {services.map((service) => <ServiceLogin key={service.provider} service={service} busy={auth.busyProvider === service.provider} />)}
        </section>
      ) : null}
      {undo ? createPortal(
        <p className="ai-gateway-undo" role="status">
          {undo.text}{" "}
          <button type="button" className="ai-gateway-text-button" onClick={() => { undo.restore(); setUndo(null); }}>{t("terminal.settings.aiGatewayUndo")}</button>
        </p>,
        document.body,
      ) : null}
    </section>
  );
}

function move(priority: readonly AiGatewayProviderId[], index: number, delta: number): AiGatewayProviderId[] {
  const next = [...priority];
  const target = index + delta;
  const swapped = next[index];
  const other = next[target];
  if (swapped === undefined || other === undefined) return next;
  next[index] = other;
  next[target] = swapped;
  return next;
}

function XaiEndpointRow(): React.ReactElement | null {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const settings = useSystemPromptSettingsStore();
  const endpoint = settings.state?.xaiEndpoint;
  if (!endpoint) return null;
  const saving = settings.savingFields.has("xaiEndpoint");
  return (
    <div className="ai-gateway-endpoint">
      <span className="ai-gateway-field-label">{t("terminal.settings.xaiEndpoint")}</span>
      <div className="segmented" role="group" aria-label={t("terminal.settings.xaiEndpoint")}>
        <SegmentedThumb />
        {(["cli-proxy", "direct"] as const).map((value) => (
          <button key={value} type="button" className={`segmented-option${endpoint === value ? " is-active" : ""}`} disabled={saving} onClick={() => void setSystemPromptSettingsField("xaiEndpoint", value)}>
            {value === "cli-proxy" ? t("terminal.settings.xaiEndpointProxy") : t("terminal.settings.xaiEndpointDirect")}
          </button>
        ))}
      </div>
    </div>
  );
}

function ServiceLogin({ service, busy }: { readonly service: ModelAuthProviderState; readonly busy: boolean }): React.ReactElement {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const [apiKey, setApiKey] = React.useState("");
  if (service.signedIn) {
    return (
      <SettingsItem label={service.displayName}>
        <button type="button" className="ai-gateway-signout" disabled={busy} onClick={() => void signOutModel(service.provider)}>
          {busy ? t("terminal.auth.working") : t("terminal.auth.signOut")}
        </button>
      </SettingsItem>
    );
  }
  return (
    <form className="ai-gateway-key-form" onSubmit={(event) => {
      event.preventDefault();
      void signInModel(service.provider, apiKey).then((ok) => { if (ok) setApiKey(""); });
    }}>
      <input type="password" className="ai-gateway-key-input" placeholder={t("terminal.auth.apiKey")} value={apiKey} autoComplete="off" spellCheck={false} disabled={busy} aria-label={t("terminal.auth.apiKeyAria", { name: service.displayName })} onChange={(event) => setApiKey(event.target.value)} />
      <button type="submit" className="ai-gateway-add-button" disabled={busy || apiKey.trim().length === 0}>{busy ? t("terminal.auth.verifying") : t("terminal.auth.signIn")}</button>
    </form>
  );
}
