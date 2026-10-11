import { useEffect, useMemo, useRef, useState } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { RailPanelContext } from "@fleet-console/sdk/rail";

import { readAgentChatSessionCoordinates } from "../../../../../features/execution/client/agent/chat/session-coordinates.js";
import { useCommanderLedgerChosen } from "../../../../../features/execution/client/agent/chat/group/commander-ledger.js";
import { CONVERSATION_MEMBERS_TAB_ID } from "../../../../../features/execution/client/agent/chat/group/install.js";
import { formatAbsoluteDateTime } from "../../i18n/format.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import type { OperationNode } from "../../integration/types.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { useRegisteredConversationOperationTabs } from "../rail/operation-tabs.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { ConversationAvatar, useMobileConversationOf } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { operationHarnessLabel } from "./mobile-operation-label.js";
import { mobileOperationMenuItems } from "./mobile-operation-menu.js";
import { pushMobileSheet, setMobileDestination, useMobileOperationMenu } from "./mobile-store.js";

type InfoTab =
  | { readonly kind: "info"; readonly id: "info"; readonly title: string }
  /** 대화 중심 화면의 오른쪽 패널 앞 묶음이 등록한 탭(`registerConversationOperationTab`) — 데스크톱과 같은 원천이다. */
  | { readonly kind: "panel"; readonly id: string; readonly title: string; readonly render: (ctx: RailPanelContext) => React.ReactNode }
  /** 레일 엔트리가 `conversationTab`으로 선언한 도구(목표) — 폰에서는 그 엔트리의 목적지 화면으로 이어 준다. */
  | { readonly kind: "entry"; readonly id: string; readonly title: string; readonly entryId: string };

/**
 * 대화 정보 화면 — Operation 화면 머리 pill이 연다. 큰 아바타 · 제목 카드 · 탭. 탭은 「정보」(모델·강도·하네스·Theater·이름 변경·보관과,
 * 본문이 ⋮에 끼운 항목 — 터미널로 보기 등)와, 데스크톱 오른쪽 패널과 같은 원천의 탭들이다: 대화 탭 등록부(구성원 등)의 탭은 그 본문을 그대로
 * 그리고, `conversationTab` 엔트리(목표)는 그 목적지로 가는 줄을 낸다. 구성원 탭에서 구성원을 고르면 그 대화로 돌아간다.
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
  const [tabId, setTabId] = useState("info");

  const tabs = useMemo<readonly InfoTab[]>(() => {
    const list: InfoTab[] = [{ kind: "info", id: "info", title: t("mobile.info.tabInfo") }];
    // 「구성원」 탭은 데스크톱에서는 1:1 대화에도 「참여자 1」로 서지만, 폰의 정보 화면은 구성원이 있는 묶음에서만 세운다.
    const hasMembers = conversation.memberCount > 0 || state.nestedOperations.some((nested) => nested.parentOperationId === operation.id);
    for (const tab of registered) {
      if (tab.section !== undefined || (tab.id === CONVERSATION_MEMBERS_TAB_ID && !hasMembers)) continue;
      list.push({ kind: "panel", id: tab.id, title: resolveLocalizedText(tab.title, locale), render: tab.render });
    }
    for (const binding of bindings) {
      if (binding.entry.conversationTab !== true || binding.entry.mobile?.destination === undefined || binding.entry.visible?.() === false) continue;
      list.push({ kind: "entry", id: `entry:${binding.entry.id}`, title: resolveLocalizedText(binding.entry.mobile.destination.label ?? binding.entry.title, locale), entryId: binding.entry.id });
    }
    return list;
  }, [bindings, conversation.memberCount, locale, operation.id, registered, state.nestedOperations, t]);
  const tab = tabs.find((item) => item.id === tabId) ?? tabs[0]!;

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
        <div className="mobile-info-tabs" role="tablist" aria-label={t("mobile.info.tabsAria")}>
          {tabs.map((item) => (
            <button type="button" role="tab" key={item.id} aria-selected={item.id === tab.id} onClick={() => setTabId(item.id)}>{item.title}</button>
          ))}
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
          <div className="mobile-group">
            <button type="button" className="mobile-group-row" onClick={() => setMobileDestination({ kind: "plugin", entryId: tab.entryId })}>
              <span className="mobile-group-row-icon" aria-hidden="true"><MobileIcon name="target" /></span>
              <span className="mobile-group-row-copy">{t("mobile.info.openDestination", { name: tab.title })}</span>
              <MobileIcon name="right" size={18} className="mobile-group-row-caret" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
