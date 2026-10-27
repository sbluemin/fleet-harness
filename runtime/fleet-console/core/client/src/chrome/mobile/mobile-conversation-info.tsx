import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import { resolveLocalizedText } from "@fleet-console/i18n/translate";
import type { PaneDescriptor } from "../../../../../features/workspace/shared/pane.js";
import type { RailPanelContext } from "../../../../../features/workspace/shared/rail.js";

import { readAgentChatSessionCoordinates } from "../../../../../features/execution/client/agent/chat/session-coordinates.js";
import { useCommanderLedgerChosen } from "../../../../../features/execution/client/agent/chat/group/commander-ledger.js";
import { CONVERSATION_MEMBERS_TAB_ID } from "../../../../../features/execution/client/agent/chat/group/install.js";
import { formatAbsoluteDateTime } from "../../i18n/format.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import type { ObjectiveRecord } from "../../integration/types.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { PaneBody, usePaneContext } from "../pane/pane-body.js";
import { usePaneIndex, useRailEntries, type RailEntryBinding } from "../pane/pane-registry.js";
import { useRegisteredConversationObjectiveTabs } from "../rail/objective-tabs.js";
import { useObjectiveMobileRowValues } from "../../../../../features/objectives/client/mobile.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { pushBackLayer } from "./mobile-back.js";
import { ConversationAvatar, conversationStateWord, useMobileConversationOf } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { objectiveRecordHarnessLabel } from "./mobile-objective-label.js";
import { mobileObjectiveMenuItems } from "./mobile-objective-menu.js";
import { conversationTabId, pushMobileSheet, setMobileDestination, useMobileDestination, useMobileObjectiveMenu } from "./mobile-store.js";

type InfoTab =
  | { readonly kind: "info"; readonly id: "info"; readonly title: string }
  /** 대화 중심 화면의 오른쪽 패널 앞 묶음이 등록한 탭(`registerConversationObjectiveTab`) — 데스크톱과 같은 원천이다. */
  | { readonly kind: "panel"; readonly id: string; readonly title: string; readonly render: (ctx: RailPanelContext) => React.ReactNode }
  /** 레일 엔트리가 `conversationTab`과 `mobile.conversationPane`으로 선언한 도구(목표) — 그 페인을 탭 본문에 그대로 세운다. */
  | { readonly kind: "pane"; readonly id: string; readonly routeId: string; readonly title: string; readonly paneId: string; readonly selected: boolean; readonly replacesMembers?: boolean; readonly select?: () => void; readonly dot?: { readonly tone: "attention" | "unseen"; readonly label: string } };

/**
 * 대화 정보 화면 — Objective 화면 머리 pill이 연다. 구역이 둘 이상이면 사령관 세부와 같이 큰 아바타 · 이름 · 상태 · 「편집」과
 * 구역 행(정보·목표·구성원·결과물)이고, 행은 그 본문으로 들어갔다가 ‹ 로 프로필에 돌아온다. 구역이 정보 하나뿐이면 그 본문을 바로 그린다.
 * 「정보」는 모델·강도·하네스·Theater·이름 변경·보관(본문이 ⋮에 끼운 항목)이고, 대화 탭 등록부(구성원 등)는 그 본문을 그대로 그리며,
 * `conversationTab` 엔트리(목표)는 `mobile.conversationPane`이 말한 페인을 대화 주인 Objective으로 세운다(막대 창구 없이).
 * 구성원 구역에서 구성원을 고르면 그 대화로 돌아간다. 고른 구역은 목적지(`?dest=info:<탭>`)가 들어 새로고침·착지 요청이 그 구역을 세운다.
 * 주의(결정 요청·안 읽은 기록·구성원 활동)는 행의 요약 글이다 — 둥근 점을 두지 않는다.
 */
export function MobileConversationInfo({ objectiveRecord, bodyOwner, onArchive }: {
  readonly objectiveRecord: ObjectiveRecord;
  /** 지금 본문을 보이는 Objective — 지휘관이 구성원 본문을 고르고 있으면 그 구성원. */
  readonly bodyOwner: ObjectiveRecord;
  readonly onArchive: () => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const capabilities = useHostCapabilities();
  const conversation = useMobileConversationOf(state)(objectiveRecord);
  const theater = state.theaters.find((item) => item.id === objectiveRecord.theaterId) ?? null;
  const bodyItems = useMobileObjectiveMenu(bodyOwner.id);
  const registered = useRegisteredConversationObjectiveTabs();
  const bindings = useRailEntries();
  const destination = useMobileDestination();
  const tabId = destination.kind === "info" ? destination.tab ?? "info" : "info";
  const setTabId = useCallback((id: string) => setMobileDestination({ kind: "info", tab: id }), []);
  const closeSection = useCallback(() => setMobileDestination({ kind: "info" }), []);
  const paneShown = useConversationPaneShown(bindings, objectiveRecord.id);
  const paneTabsKey = useSyncExternalStore(
    (listener) => {
      const offs = bindings.flatMap((binding) => {
        const source = binding.entry.mobile?.conversationPane?.tabs;
        return source ? [source.subscribe(listener)] : [];
      });
      return () => { for (const off of offs) off(); };
    },
    () => JSON.stringify(bindings.map((binding) => {
      const value = binding.entry.mobile?.conversationPane?.tabs?.read(objectiveRecord.id);
      return [binding.entry.id, value?.selected, value?.tabs.map((item) => [item.id, resolveLocalizedText(item.title, locale), item.replacesMembers, item.dot?.tone, item.dot && resolveLocalizedText(item.dot.label, locale)])];
    })),
  );
  const tabs = useMemo<readonly InfoTab[]>(() => {
    const list: InfoTab[] = [{ kind: "info", id: "info", title: t("mobile.info.tabInfo") }];
    // 「구성원」 탭은 데스크톱에서는 1:1 대화에도 「참여자 1」로 서지만, 폰의 정보 화면은 구성원이 있는 묶음에서만 세운다.
    const hasMembers = conversation.memberCount > 0 || state.nestedObjectiveRecords.some((nested) => nested.parentObjectiveId === objectiveRecord.id);
    for (const tab of registered) {
      if (tab.section !== undefined || (tab.id === CONVERSATION_MEMBERS_TAB_ID && !hasMembers)) continue;
      list.push({ kind: "panel", id: tab.id, title: resolveLocalizedText(tab.title, locale), render: tab.render });
    }
    for (const binding of bindings) {
      const pane = binding.entry.mobile?.conversationPane;
      if (binding.entry.conversationTab !== true || pane === undefined || binding.entry.visible?.() === false || !paneShown.has(binding.entry.id)) continue;
      const routeId = conversationTabId(binding.entry.id);
      const source = pane.tabs;
      const views = source?.read(objectiveRecord.id);
      if (source && views && views.tabs.length > 0) {
        if (views.tabs.some((view) => view.replacesMembers)) {
          const memberIndex = list.findIndex((item) => item.id === CONVERSATION_MEMBERS_TAB_ID);
          if (memberIndex >= 0) list.splice(memberIndex, 1);
        }
        for (const view of views.tabs) list.push({
          kind: "pane", id: `${routeId}:${view.id}`, routeId, paneId: pane.paneId,
          title: resolveLocalizedText(view.title, locale), selected: view.id === views.selected,
          ...(view.replacesMembers ? { replacesMembers: true } : {}),
          select: () => source.select(view.id, objectiveRecord.id),
          ...(view.dot ? { dot: { tone: view.dot.tone, label: resolveLocalizedText(view.dot.label, locale) } } : {}),
        });
      } else list.push({ kind: "pane", id: routeId, routeId, title: resolveLocalizedText(binding.entry.mobile?.destination?.label ?? binding.entry.title, locale), paneId: pane.paneId, selected: true });
    }
    return list;
  }, [bindings, conversation.memberCount, locale, objectiveRecord.id, paneShown, paneTabsKey, registered, state.nestedObjectiveRecords, t]);
  const tab = tabs.find((item) => item.id === tabId)
    ?? (tabId === CONVERSATION_MEMBERS_TAB_ID ? tabs.find((item) => item.kind === "pane" && item.replacesMembers) : undefined)
    ?? tabs.find((item) => item.kind === "pane" && item.routeId === tabId && item.selected)
    ?? tabs[0]!;
  // 주소로 들어온 보기는 플러그인에 적용한다. 반대로 본문 동작이 보기를 바꾸면 그 선택을 주소에 남긴다.
  // 호스트 구성원 탭을 대신하는 플러그인 보기가 설 때는 옛 구성원 주소(또는 목표 로드 전 선택)를 그 대체 보기로 옮긴다.
  const paneNavigation = useRef<{ readonly route: string; selected: string } | null>(null);
  useEffect(() => {
    if (tab.kind !== "pane") { paneNavigation.current = null; return; }
    if (tabId === CONVERSATION_MEMBERS_TAB_ID && tab.replacesMembers) {
      if (!tab.selected) tab.select?.();
      setTabId(tab.id);
      return;
    }
    const selected = tabs.find((item) => item.kind === "pane" && item.routeId === tab.routeId && item.selected);
    if (!selected) return;
    const navigationKey = `${objectiveRecord.id}:${tabId}`;
    if (paneNavigation.current?.route !== navigationKey) {
      paneNavigation.current = { route: navigationKey, selected: selected.id };
      if (tab.id === tabId && !tab.selected) tab.select?.();
      return;
    }
    if (paneNavigation.current.selected !== selected.id) {
      paneNavigation.current.selected = selected.id;
      if (tabId !== selected.id) setTabId(selected.id);
    }
  }, [objectiveRecord.id, setTabId, tab, tabId, tabs]);
  // 구역이 여럿이면 탭 없는 주소는 프로필이다. 행을 연 뒤의 ‹·시스템 뒤로는 그 구역만 걷고 프로필에 남는다.
  const profile = tabs.length > 1 && destination.kind === "info" && destination.tab === undefined;
  useEffect(() => (profile || tabs.length < 2 ? undefined : pushBackLayer(closeSection)), [closeSection, profile, tabs.length]);
  // 프로필에 실린 지금 할 일이 결과물로 보내면(넘긴 후보) 그 구역을 연다. 프로필에 들어온 순간의 선택은 기준이라 따라가지 않는다.
  const profileSelection = useRef<string | null>(null);
  useEffect(() => {
    if (!profile) { profileSelection.current = null; return; }
    const selected = tabs.find((item) => item.kind === "pane" && item.selected);
    if (!selected) return;
    if (profileSelection.current === null) { profileSelection.current = selected.id; return; }
    if (profileSelection.current !== selected.id) { profileSelection.current = selected.id; setTabId(selected.id); }
  }, [profile, setTabId, tabs]);

  // 구성원 탭에서 구성원(또는 지휘관)을 고르면 그 본문이 대화 화면에 서므로 정보 화면을 닫고 돌아간다 — 선택이 바뀐 것을 본다.
  const selection = state.nestedBodySelection[objectiveRecord.id] ?? null;
  const commanderLedger = useCommanderLedgerChosen(objectiveRecord.id);
  const initialRef = useRef({ selection, commanderLedger });
  useEffect(() => {
    if (initialRef.current.selection === selection && initialRef.current.commanderLedger === commanderLedger) return;
    setMobileDestination({ kind: "home" });
  }, [commanderLedger, selection]);

  const inSection = tabs.length > 1 && !profile;
  useClaimMobileBar({
    variant: "centered",
    title: inSection ? tab.title : "",
    ...(inSection ? { subtitle: objectiveRecord.title } : {}),
    leading: "back",
    ...(tabs.length > 1 ? { round: true } : {}),
    onBack: inSection ? closeSection : () => setMobileDestination({ kind: "home" }),
    menu: {
      label: t("mobile.bar.objectiveRecordMenu"),
      caption: objectiveRecord.title,
      items: mobileObjectiveMenuItems({ objectiveRecord, bodyItems, t, onArchive }),
    },
  });

  const harnessLabel = objectiveRecordHarnessLabel(objectiveRecord, t);
  const coordinates = readAgentChatSessionCoordinates(objectiveRecord);
  const hasCoordinates = harnessLabel !== undefined;
  const rowValues = useObjectiveMobileRowValues(objectiveRecord.id, locale);
  const statusWord = conversationStateWord(conversation.face, t);
  const panelContext: RailPanelContext = {
    theaterId: objectiveRecord.theaterId,
    pathContext: { kind: "root", relPath: null, label: theater?.label ?? "" },
    api: capabilities.api,
    rail: capabilities.rail,
    surfaces: capabilities.surfaces,
    language: locale,
    theme: state.activeTheme,
  };

  const infoModel = hasCoordinates ? [coordinates.model ?? t("mobile.info.modelDefault"), coordinates.effort].filter(Boolean).join(" · ") : "";
  const stripPane = tabs.find((item): item is Extract<InfoTab, { kind: "pane" }> => item.kind === "pane");
  const infoBody = tab.kind === "info" ? (
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
                <span className="mobile-group-row-value">{formatAbsoluteDateTime(objectiveRecord.ts.createdAt, locale)}</span>
              </div>
            </div>
            <div className="mobile-group">
              <button type="button" className="mobile-group-row" onClick={() => pushMobileSheet({ kind: "rename", objectiveId: objectiveRecord.id })}>
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
      <FeatureErrorBoundary fallback={null}>{tab.render(panelContext)}</FeatureErrorBoundary>
    </div>
  ) : (
    <div className="mobile-info-panel" key={tab.id}>
      <MobileConversationPane paneId={tab.paneId} objectiveId={objectiveRecord.id} theaterId={objectiveRecord.theaterId} panelContext={panelContext} />
    </div>
  );
  return (
    <section className="mobile-info-screen">
      {profile ? (
        <div className="mobile-info-profile">
          <div className="mobile-info-hero is-profile">
            <ConversationAvatar conversation={conversation} size={104} />
            <h2 className="mobile-info-name">{objectiveRecord.title}</h2>
            {statusWord ? <p className="mobile-info-status">{statusWord}</p> : null}
            <button type="button" data-press="r3" className="mobile-pill-secondary mobile-info-edit" aria-label={t("mobile.info.editAria", { name: objectiveRecord.title })} onClick={() => pushMobileSheet({ kind: "rename", objectiveId: objectiveRecord.id })}>{t("mobile.info.edit")}</button>
          </div>
          {stripPane ? <MobileConversationPane paneId={stripPane.paneId} objectiveId={objectiveRecord.id} theaterId={objectiveRecord.theaterId} panelContext={panelContext} params={STRIP_PARAMS} /> : null}
          <nav className="mobile-info-rows" aria-label={t("mobile.info.tabsAria")}>
            {tabs.map((item) => {
              const value = sectionValue(item, infoModel, theater?.label ?? "", rowValues);
              return (
                <button type="button" data-press="r2" className="mobile-info-prow" key={item.id} onClick={() => { if (item.kind === "pane") item.select?.(); setTabId(item.id); }}>
                  <span className="mobile-info-prow-ic" aria-hidden="true"><MobileIcon name={sectionIcon(item)} /></span>
                  <span className="mobile-info-prow-lb">{item.title}</span>
                  {value ? <span className={`mobile-info-prow-val${value.tone ? ` is-${value.tone}` : ""}`}>{value.text}</span> : null}
                  <MobileIcon name="right" size={18} className="mobile-info-prow-caret" />
                </button>
              );
            })}
          </nav>
          {rowValues.foot ? <p className="mobile-info-foot">{rowValues.foot}</p> : null}
        </div>
      ) : (
        <>
          {tabs.length < 2 ? (
            <div className="mobile-info-hero">
              <ConversationAvatar conversation={conversation} size={110} />
              <button type="button" data-press="r1" className="mobile-info-title" onClick={() => pushMobileSheet({ kind: "rename", objectiveId: objectiveRecord.id })}>
                <strong>{objectiveRecord.title}</strong>
                <small>{[theater?.label, harnessLabel].filter(Boolean).join(" · ")}</small>
              </button>
            </div>
          ) : null}
          <div className="mobile-info-body">{infoBody}</div>
        </>
      )}
    </section>
  );
}

function sectionIcon(item: InfoTab): "info" | "target" | "commanders" | "file" | "grid" {
  if (item.kind === "info") return "info";
  if (item.kind === "panel") return "commanders";
  const viewId = item.id.startsWith(`${item.routeId}:`) ? item.id.slice(item.routeId.length + 1) : "";
  if (viewId === "goal") return "target";
  if (viewId === "crew") return "commanders";
  if (viewId === "results") return "file";
  return "grid";
}

function sectionValue(item: InfoTab, model: string, theater: string, rows: ReturnType<typeof useObjectiveMobileRowValues>): { readonly text: string; readonly tone?: "awaiting" | "danger" } | null {
  if (item.kind === "info") return model ? { text: model } : theater ? { text: theater } : null;
  if (item.kind !== "pane") return null;
  const viewId = item.id.startsWith(`${item.routeId}:`) ? item.id.slice(item.routeId.length + 1) : "";
  if (viewId === "goal") return rows.goal;
  if (viewId === "crew") return rows.crew;
  if (viewId === "results") return rows.results;
  return null;
}

/** 대화 탭을 선언한 엔트리 가운데 이 대화에 탭을 세우는 것(`conversationPane.shown`) — 엔트리마다 구독해 판정이 바뀌면 다시 그린다. */
function useConversationPaneShown(bindings: readonly RailEntryBinding[], objectiveId: string): ReadonlySet<string> {
  const key = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.mobile?.conversationPane?.shown ? [binding.entry.mobile.conversationPane.shown.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => shownPaneKey(bindings, objectiveId),
    () => shownPaneKey(bindings, objectiveId),
  );
  return useMemo(() => new Set(key === "" ? [] : key.split("|")), [key]);
}

function shownPaneKey(bindings: readonly RailEntryBinding[], objectiveId: string): string {
  return bindings.filter((binding) => {
    const pane = binding.entry.mobile?.conversationPane;
    return pane !== undefined && pane.shown?.get(objectiveId) !== false;
  }).map((binding) => binding.entry.id).join("|");
}

const NO_OP = () => undefined;
const STRIP_PARAMS = { mobileFace: "strip" } as const;

/**
 * 대화 탭의 본문 — 엔트리가 `mobile.conversationPane`으로 말한 페인을 그 대화 주인 Objective(`params.objectiveId`)으로 세운다. 막대 창구(`mobileBar`)는
 * 싣지 않는다 — 이 화면의 막대는 정보 화면의 것이다. 닫을 자리가 없으므로 닫기·주소 바꾸기는 아무 일도 하지 않는다.
 */
function MobileConversationPane({ paneId, objectiveId, theaterId, panelContext, params }: { readonly paneId: string; readonly objectiveId: string; readonly theaterId: string; readonly panelContext: RailPanelContext; readonly params?: Readonly<Record<string, string>> }) {
  const descriptor = usePaneIndex().get(paneId);
  if (!descriptor) return null;
  return (
    <FeatureErrorBoundary fallback={null}>
      <MobileConversationPaneBody key={`${paneId}:${objectiveId}:${params?.mobileFace ?? ""}`} descriptor={descriptor} objectiveId={objectiveId} theaterId={theaterId} panelContext={panelContext} params={params} />
    </FeatureErrorBoundary>
  );
}

function MobileConversationPaneBody({ descriptor, objectiveId, theaterId, panelContext, params: extra }: { readonly descriptor: PaneDescriptor; readonly objectiveId: string; readonly theaterId: string; readonly panelContext: RailPanelContext; readonly params?: Readonly<Record<string, string>> }) {
  const capabilities = useHostCapabilities();
  const params = useMemo(() => ({ objectiveId, ...extra }), [extra, objectiveId]);
  const ctx = usePaneContext({
    descriptor,
    mount: "rail",
    instanceId: `mobile-conversation:${descriptor.id}:${objectiveId}`,
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
