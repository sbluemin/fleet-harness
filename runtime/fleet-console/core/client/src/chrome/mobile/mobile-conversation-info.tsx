import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailPanelContext } from "@fleet-console/sdk/rail";

import { readAgentChatSessionCoordinates } from "../../../../../features/execution/client/agent/chat/session-coordinates.js";
import { useCommanderLedgerChosen } from "../../../../../features/execution/client/agent/chat/group/commander-ledger.js";
import { CONVERSATION_MEMBERS_TAB_ID } from "../../../../../features/execution/client/agent/chat/group/install.js";
import { formatAbsoluteDateTime } from "../../i18n/format.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import type { OperationNode } from "../../integration/types.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { PaneBody, usePaneContext } from "../pane/pane-body.js";
import { usePaneIndex, useRailEntries, type RailEntryBinding } from "../pane/pane-registry.js";
import { useRegisteredConversationOperationTabs } from "../rail/operation-tabs.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { ConversationAvatar, useMobileConversationOf } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { operationHarnessLabel } from "./mobile-operation-label.js";
import { mobileOperationMenuItems } from "./mobile-operation-menu.js";
import { conversationTabId, pushMobileSheet, setMobileDestination, useMobileDestination, useMobileOperationMenu } from "./mobile-store.js";

type InfoTab =
  | { readonly kind: "info"; readonly id: "info"; readonly title: string }
  /** 대화 중심 화면의 오른쪽 패널 앞 묶음이 등록한 탭(`registerConversationOperationTab`) — 데스크톱과 같은 원천이다. */
  | { readonly kind: "panel"; readonly id: string; readonly title: string; readonly render: (ctx: RailPanelContext) => React.ReactNode }
  /** 레일 엔트리가 `conversationTab`과 `mobile.conversationPane`으로 선언한 도구(목표) — 그 페인을 탭 본문에 그대로 세운다. */
  | { readonly kind: "pane"; readonly id: string; readonly routeId: string; readonly title: string; readonly paneId: string; readonly selected: boolean; readonly select?: () => void; readonly dot?: { readonly tone: "attention" | "unseen"; readonly label: string } };

/**
 * 대화 정보 화면 — Operation 화면 머리 pill이 연다. 큰 아바타 · 제목 카드 · 탭. 탭은 「정보」(모델·강도·하네스·Theater·이름 변경·보관과,
 * 본문이 ⋮에 끼운 항목 — 터미널로 보기 등)와, 데스크톱 오른쪽 패널과 같은 원천의 탭들이다: 대화 탭 등록부(구성원 등)의 탭은 그 본문을 그대로
 * 그리고, `conversationTab` 엔트리(목표)는 `mobile.conversationPane`이 말한 페인을 대화 주인 Operation으로 세운다(막대 창구 없이 — 동작은 본문이 그린다).
 * 구성원 탭에서 구성원을 고르면 그 대화로 돌아간다. 고른 탭은 목적지(`?dest=info:<탭>`)가 들어 새로고침·착지 요청이 그 탭을 세운다.
 */
export function MobileConversationInfo({ operation, bodyOwner, onArchive }: {
  readonly operation: OperationNode;
  /** 지금 본문을 보이는 Operation — 지휘관이 구성원 본문을 고르고 있으면 그 구성원. */
  readonly bodyOwner: OperationNode;
  readonly onArchive: () => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const capabilities = useHostCapabilities();
  const conversation = useMobileConversationOf(state)(operation);
  const theater = state.theaters.find((item) => item.id === operation.theaterId) ?? null;
  const bodyItems = useMobileOperationMenu(bodyOwner.id);
  const registered = useRegisteredConversationOperationTabs();
  const bindings = useRailEntries();
  const destination = useMobileDestination();
  const tabId = destination.kind === "info" ? destination.tab ?? "info" : "info";
  const setTabId = useCallback((id: string) => setMobileDestination(id === "info" ? { kind: "info" } : { kind: "info", tab: id }), []);
  const paneShown = useConversationPaneShown(bindings, operation.id);
  const paneTabsKey = useSyncExternalStore(
    (listener) => {
      const offs = bindings.flatMap((binding) => {
        const source = binding.entry.mobile?.conversationPane?.tabs;
        return source ? [source.subscribe(listener)] : [];
      });
      return () => { for (const off of offs) off(); };
    },
    () => JSON.stringify(bindings.map((binding) => {
      const value = binding.entry.mobile?.conversationPane?.tabs?.read(operation.id);
      return [binding.entry.id, value?.selected, value?.tabs.map((item) => [item.id, resolveLocalizedText(item.title, locale), item.replacesMembers, item.dot?.tone, item.dot && resolveLocalizedText(item.dot.label, locale)])];
    })),
  );
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabFade, setTabFade] = useState(false);

  const tabs = useMemo<readonly InfoTab[]>(() => {
    const list: InfoTab[] = [{ kind: "info", id: "info", title: t("mobile.info.tabInfo") }];
    // 「구성원」 탭은 데스크톱에서는 1:1 대화에도 「참여자 1」로 서지만, 폰의 정보 화면은 구성원이 있는 묶음에서만 세운다.
    const hasMembers = conversation.memberCount > 0 || state.nestedOperations.some((nested) => nested.parentOperationId === operation.id);
    for (const tab of registered) {
      if (tab.section !== undefined || (tab.id === CONVERSATION_MEMBERS_TAB_ID && !hasMembers)) continue;
      list.push({ kind: "panel", id: tab.id, title: resolveLocalizedText(tab.title, locale), render: tab.render });
    }
    for (const binding of bindings) {
      const pane = binding.entry.mobile?.conversationPane;
      if (binding.entry.conversationTab !== true || pane === undefined || binding.entry.visible?.() === false || !paneShown.has(binding.entry.id)) continue;
      const routeId = conversationTabId(binding.entry.id);
      const source = pane.tabs;
      const views = source?.read(operation.id);
      if (source && views && views.tabs.length > 0) {
        if (views.tabs.some((view) => view.replacesMembers)) {
          const memberIndex = list.findIndex((item) => item.id === CONVERSATION_MEMBERS_TAB_ID);
          if (memberIndex >= 0) list.splice(memberIndex, 1);
        }
        for (const view of views.tabs) list.push({
          kind: "pane", id: `${routeId}:${view.id}`, routeId, paneId: pane.paneId,
          title: resolveLocalizedText(view.title, locale), selected: view.id === views.selected,
          select: () => source.select(view.id, operation.id),
          ...(view.dot ? { dot: { tone: view.dot.tone, label: resolveLocalizedText(view.dot.label, locale) } } : {}),
        });
      } else list.push({ kind: "pane", id: routeId, routeId, title: resolveLocalizedText(binding.entry.mobile?.destination?.label ?? binding.entry.title, locale), paneId: pane.paneId, selected: true });
    }
    return list;
  }, [bindings, conversation.memberCount, locale, operation.id, paneShown, paneTabsKey, registered, state.nestedOperations, t]);
  const tab = tabs.find((item) => item.id === tabId)
    ?? tabs.find((item) => item.kind === "pane" && item.routeId === tabId && item.selected)
    ?? tabs[0]!;
  // 주소로 들어온 보기는 플러그인에 적용한다. 반대로 본문 동작이 보기를 바꾸면 그 선택을 주소에 남긴다.
  const paneNavigation = useRef<{ readonly route: string; selected: string } | null>(null);
  useEffect(() => {
    if (tab.kind !== "pane") { paneNavigation.current = null; return; }
    const selected = tabs.find((item) => item.kind === "pane" && item.routeId === tab.routeId && item.selected);
    if (!selected) return;
    const navigationKey = `${operation.id}:${tabId}`;
    if (paneNavigation.current?.route !== navigationKey) {
      paneNavigation.current = { route: navigationKey, selected: selected.id };
      if (tab.id === tabId && !tab.selected) tab.select?.();
      return;
    }
    if (paneNavigation.current.selected !== selected.id) {
      paneNavigation.current.selected = selected.id;
      if (tabId !== selected.id) setTabId(selected.id);
    }
  }, [operation.id, setTabId, tab, tabId, tabs]);
  useEffect(() => {
    const strip = tabsRef.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !selected) return;
    if (selected.offsetLeft < strip.scrollLeft) strip.scrollLeft = selected.offsetLeft;
    else if (selected.offsetLeft + selected.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = selected.offsetLeft + selected.offsetWidth - strip.clientWidth;
  }, [tab.id]);
  useEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const update = () => setTabFade(strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1);
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    for (const child of strip.children) observer.observe(child);
    strip.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); strip.removeEventListener("scroll", update); };
  }, [tabs.length, paneTabsKey]);

  // 구성원 탭에서 구성원(또는 지휘관)을 고르면 그 본문이 대화 화면에 서므로 정보 화면을 닫고 돌아간다 — 선택이 바뀐 것을 본다.
  const selection = state.nestedBodySelection[operation.id] ?? null;
  const commanderLedger = useCommanderLedgerChosen(operation.id);
  const initialRef = useRef({ selection, commanderLedger });
  useEffect(() => {
    if (initialRef.current.selection === selection && initialRef.current.commanderLedger === commanderLedger) return;
    setMobileDestination({ kind: "home" });
  }, [commanderLedger, selection]);

  useClaimMobileBar({
    variant: "centered",
    title: "",
    leading: "back",
    onBack: () => setMobileDestination({ kind: "home" }),
    menu: {
      label: t("mobile.bar.operationMenu"),
      caption: operation.title,
      items: mobileOperationMenuItems({ operation, bodyItems, t, onArchive }),
    },
  });

  const harnessLabel = operationHarnessLabel(operation, t);
  const coordinates = readAgentChatSessionCoordinates(operation.payload);
  const hasCoordinates = harnessLabel !== undefined;
  const panelContext: RailPanelContext = {
    theaterId: operation.theaterId,
    pathContext: { kind: "root", relPath: null, label: theater?.label ?? "" },
    api: capabilities.api,
    rail: capabilities.rail,
    surfaces: capabilities.surfaces,
    language: locale,
    theme: state.activeTheme,
  };

  return (
    <section className="mobile-info-screen">
      <div className="mobile-info-hero">
        <ConversationAvatar conversation={conversation} size={110} />
        <button type="button" data-press="r1" className="mobile-info-title" onClick={() => pushMobileSheet({ kind: "rename", operationId: operation.id })}>
          <strong>{operation.title}</strong>
          <small>{[theater?.label, harnessLabel].filter(Boolean).join(" · ")}</small>
        </button>
      </div>
      {tabs.length > 1 ? (
        <div className={`mobile-info-tabs-edge${tabFade ? " is-overflowing" : ""}`}>
          <div ref={tabsRef} className="mobile-info-tabs" role="tablist" aria-label={t("mobile.info.tabsAria")}>
            {tabs.map((item) => (
              <button type="button" role="tab" key={item.id} aria-selected={item.id === tab.id} onClick={() => {
                if (item.kind === "pane") item.select?.();
                setTabId(item.id);
              }}>{item.title}{item.kind === "pane" && item.dot ? <span className={`mobile-info-tab-dot is-${item.dot.tone}`} role="img" aria-label={item.dot.label} /> : null}</button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mobile-info-body">
        {tab.kind === "info" ? (
          <>
            <div className="mobile-group">
              {hasCoordinates ? (
                <div className="mobile-group-row">
                  <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="harness" /></span>
                  <span className="mobile-group-row-copy">{t("mobile.info.model")}<small>{[coordinates.model ?? t("mobile.info.modelDefault"), coordinates.effort].filter(Boolean).join(" · ")}</small></span>
                </div>
              ) : null}
              {hasCoordinates ? (
                <div className="mobile-group-row">
                  <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="gate" /></span>
                  <span className="mobile-group-row-copy">{t("mobile.info.harness")}<small>{harnessLabel}</small></span>
                </div>
              ) : null}
              {bodyItems.map((item) => (
                <button type="button" key={item.id} className="mobile-group-row" disabled={item.disabled} onClick={item.run}>
                  <span className="mobile-group-row-icon" aria-hidden="true">{item.icon}</span>
                  <span className="mobile-group-row-copy">{item.label}</span>
                  <MobileIcon name="right" size={18} className="mobile-group-row-caret" />
                </button>
              ))}
              <div className="mobile-group-row">
                <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="folder" /></span>
                <span className="mobile-group-row-copy">{t("mobile.info.theater")}</span>
                <span className="mobile-group-row-value">{theater?.label ?? ""}</span>
              </div>
              <div className="mobile-group-row">
                <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="info" /></span>
                <span className="mobile-group-row-copy">{t("mobile.info.started")}</span>
                <span className="mobile-group-row-value">{formatAbsoluteDateTime(operation.ts.createdAt, locale)}</span>
              </div>
            </div>
            <div className="mobile-group">
              <button type="button" className="mobile-group-row" onClick={() => pushMobileSheet({ kind: "rename", operationId: operation.id })}>
                <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="pencil" /></span>
                <span className="mobile-group-row-copy">{t("mobile.menu.rename")}</span>
              </button>
              <button type="button" className="mobile-group-row" onClick={onArchive}>
                <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="archive" /></span>
                <span className="mobile-group-row-copy">{t("mobile.menu.archive")}</span>
              </button>
            </div>
          </>
        ) : tab.kind === "panel" ? (
          <div className="mobile-info-panel" key={tab.id}>
            <PluginErrorBoundary fallback={null}>{tab.render(panelContext)}</PluginErrorBoundary>
          </div>
        ) : (
          <div className="mobile-info-panel" key={tab.id}>
            <MobileConversationPane paneId={tab.paneId} operationId={operation.id} theaterId={operation.theaterId} panelContext={panelContext} />
          </div>
        )}
      </div>
    </section>
  );
}

/** 대화 탭을 선언한 엔트리 가운데 이 대화에 탭을 세우는 것(`conversationPane.shown`) — 엔트리마다 구독해 판정이 바뀌면 다시 그린다. */
function useConversationPaneShown(bindings: readonly RailEntryBinding[], operationId: string): ReadonlySet<string> {
  const key = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.mobile?.conversationPane?.shown ? [binding.entry.mobile.conversationPane.shown.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => shownPaneKey(bindings, operationId),
    () => shownPaneKey(bindings, operationId),
  );
  return useMemo(() => new Set(key === "" ? [] : key.split("|")), [key]);
}

function shownPaneKey(bindings: readonly RailEntryBinding[], operationId: string): string {
  return bindings.filter((binding) => {
    const pane = binding.entry.mobile?.conversationPane;
    return pane !== undefined && pane.shown?.get(operationId) !== false;
  }).map((binding) => binding.entry.id).join("|");
}

const NO_OP = () => undefined;

/**
 * 대화 탭의 본문 — 엔트리가 `mobile.conversationPane`으로 말한 페인을 그 대화 주인 Operation(`params.operationId`)으로 세운다. 막대 창구(`mobileBar`)는
 * 싣지 않는다 — 이 화면의 막대는 정보 화면의 것이다. 닫을 자리가 없으므로 닫기·주소 바꾸기는 아무 일도 하지 않는다.
 */
function MobileConversationPane({ paneId, operationId, theaterId, panelContext }: { readonly paneId: string; readonly operationId: string; readonly theaterId: string; readonly panelContext: RailPanelContext }) {
  const descriptor = usePaneIndex().get(paneId);
  if (!descriptor) return null;
  return (
    <PluginErrorBoundary fallback={null}>
      <MobileConversationPaneBody key={`${paneId}:${operationId}`} descriptor={descriptor} operationId={operationId} theaterId={theaterId} panelContext={panelContext} />
    </PluginErrorBoundary>
  );
}

function MobileConversationPaneBody({ descriptor, operationId, theaterId, panelContext }: { readonly descriptor: PaneDescriptor; readonly operationId: string; readonly theaterId: string; readonly panelContext: RailPanelContext }) {
  const capabilities = useHostCapabilities();
  const params = useMemo(() => ({ operationId }), [operationId]);
  const ctx = usePaneContext({
    descriptor,
    mount: "rail",
    instanceId: `mobile-conversation:${descriptor.id}:${operationId}`,
    params,
    visible: true,
    focused: true,
    width: 0,
    theaterId,
    api: panelContext.api,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language: panelContext.language,
    ...(panelContext.theme === undefined ? {} : { theme: panelContext.theme }),
    onClose: NO_OP,
    onReplaceParams: NO_OP,
  });
  return <PaneBody descriptor={descriptor} ctx={ctx} />;
}
