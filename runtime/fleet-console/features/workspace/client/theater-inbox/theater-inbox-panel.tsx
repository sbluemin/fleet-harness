import { useEffect, useMemo, useRef } from "react";
import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import type { ConsoleLocale } from "@fleet-console/i18n";
import type { ConsoleTheaterSummary } from "../../shared/console-state.js";
import type { ClientTheaterInboxCapability, TheaterInboxAddress } from "../../shared/theater-inbox.js";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { conversationSurfaceInboxSectionId, useFeatureRegistry, type ResolvedConversationSurface } from "../../../../core/client/src/integration/feature-registry.js";
import { registerConversationOperationTab, useConversationOperationTabPanels } from "../../../../core/client/src/chrome/rail/operation-tabs.js";
import { useDesktopRailEntries, type RailEntryBinding } from "../../../../core/client/src/chrome/pane/pane-registry.js";
import { closeRailPanel, getRailStoreSnapshot, openRailPanel, presentRailPanel, useRailActivePanelId } from "../../../../core/client/src/chrome/rail/rail-store.js";
import { mayAutoOpenConversationRail } from "../conversation/conversation-rail-memory.js";
import { closeConversationSurface, getConversationSurface, useConversationSurface, type ConversationSurfaceSelection } from "../conversation/conversation-surface-store.js";
import { useConversationSubject } from "../conversation/conversation-slots.js";
import { ConversationPanelFrame } from "../conversation/conversation-panel-frame.js";
import { useSectionStates, type ResolvedTheaterInboxSection } from "./section-states.js";
import { useTheaterInboxState, type TheaterInboxOpenState } from "./store.js";
import "./theater-inbox-panel.css";

/** 오른쪽 패널에 선 Inbox 칸 탭의 id — 레일 전체에서 고유해야 한다. */
export function theaterInboxPanelTabId(address: TheaterInboxAddress): string {
  return `theater-inbox:${address.sectionId}:${address.pageId}`;
}

function addressOfTab(id: string | null): TheaterInboxAddress | null {
  if (id === null || !id.startsWith("theater-inbox:")) return null;
  const rest = id.slice("theater-inbox:".length);
  const cut = rest.lastIndexOf(":");
  return cut > 0 ? { sectionId: rest.slice(0, cut), pageId: rest.slice(cut + 1) } : null;
}

/** 활성 패널이 대화를 세워도 남길 도구인가 — 레일에 본문이 서는 도구 엔트리이고, 대화 탭·Inbox 칸·섹션이 뺀 도구가 아니다. */
function keptToolPanel(
  active: string | null,
  rail: { readonly bindings: readonly RailEntryBinding[]; readonly operationTabs: readonly { readonly id: string }[] },
  omitted: readonly string[] | undefined,
): boolean {
  if (active === null || addressOfTab(active) !== null || rail.operationTabs.some((tab) => tab.id === active)) return false;
  const binding = rail.bindings.find((candidate) => candidate.entry.id === active && candidate.panes.length > 0);
  return binding !== undefined && binding.entry.conversationTab !== true && !(omitted ?? []).includes(active);
}

export interface TheaterInboxPanelProps {
  readonly open: TheaterInboxOpenState;
  readonly theater: ConsoleTheaterSummary;
  readonly sections: readonly ResolvedTheaterInboxSection[];
  readonly language: ConsoleLocale;
  readonly navigation: ClientTheaterInboxCapability;
  readonly select: (address: TheaterInboxAddress) => void;
  /** 다른 칸을 열 수 없을 때 — 호스트의 시스템 프롬프트 칸. */
  readonly fallback: TheaterInboxAddress;
}

/** 가운데 칸에 선 플러그인 대화가 이 Theater 의 Inbox 섹션을 대신하면 그 대화와 섹션의 정준 id. */
function useCenterSection(theaterId: string, language: ConsoleLocale): { readonly surface: ResolvedConversationSurface; readonly selection: ConversationSurfaceSelection; readonly sectionId: string } | null {
  const selection = useConversationSurface();
  const { conversationSurfaces } = useFeatureRegistry();
  const theme = useConsoleState().activeTheme;
  return useMemo(() => {
    if (selection === null) return null;
    const surface = conversationSurfaces.find((candidate) => candidate.id === selection.surfaceId);
    if (!surface?.theater) return null;
    let info: { readonly theaterId: string; readonly inboxSection: string } | null = null;
    try {
      info = surface.theater({ params: selection.params, language: language === "ko" ? "ko" : "en", theme, close: () => closeConversationSurface(surface.id) });
    } catch {
      info = null;
    }
    if (!info || info.theaterId !== theaterId) return null;
    return { surface, selection, sectionId: conversationSurfaceInboxSectionId(surface, info.inboxSection) };
  }, [conversationSurfaces, language, selection, theaterId, theme]);
}

/**
 * 대화 중심 화면의 Theater Inbox — 시트 대신 오른쪽 패널. Inbox 의 섹션(Theater 설정·사령관 등)은 패널 앞 묶음의 탭으로 서고,
 * 패널 머리가 섹션 줄과 그 섹션의 칸 탭을 세운다. 가운데 칸에 그 섹션의 대화(사령관)가 선 동안에는 그 자리를 대화의 탭이 맡는다.
 *
 * 열림 상태는 시트와 같은 Inbox 스토어다 — 어느 입구(머리·우클릭 메뉴·지시 탭의 링크)든 같은 주소로 온다. 패널을 닫거나 가운데 칸에
 * 다른 Operation 을 고르면 닫힌다.
 */
export function TheaterInboxPanel({ open, theater, sections, language, navigation, select, fallback }: TheaterInboxPanelProps) {
  const states = useSectionStates(sections, theater, language);
  const { conversationSurfaces } = useFeatureRegistry();
  const center = useCenterSection(theater.id, language);
  const centerSectionId = center?.sectionId ?? null;
  const activePanelId = useRailActivePanelId();
  const subject = useConversationSubject();
  const available = (index: number) => states[index]?.availability === "available";

  // 칸 탭을 레일 패널로 세운다 — 섹션 순서는 Inbox 와 같고, 가운데 대화가 대신하는 섹션은 대화의 탭이 그 자리를 맡는다.
  const availability = states.map((state) => state.availability).join("|");
  useEffect(() => {
    const disposers: (() => void)[] = [];
    sections.forEach((section, sectionIndex) => {
      if (!available(sectionIndex) || section.id === centerSectionId) return;
      const sectionTag = { id: section.id, title: section.descriptor.title(language), theaterId: theater.id };
      section.descriptor.pages.forEach((page, pageIndex) => {
        const address = { sectionId: section.id, pageId: page.id };
        disposers.push(registerConversationOperationTab({
          id: theaterInboxPanelTabId(address),
          title: (locale) => page.title(locale),
          icon: null,
          order: 100 + sectionIndex * 20 + pageIndex,
          section: sectionTag,
          render: () => <TheaterInboxPanelPage theater={theater} language={language} section={section} pageId={page.id} navigation={navigation} fallback={fallback} sections={sections} />,
        }));
      });
    });
    return () => {
      for (const dispose of disposers) dispose();
    };
    // availability 는 상태 배열의 값 비교다 — 섹션의 scope 줄이 바뀌어도 탭을 다시 세우지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, centerSectionId, fallback, language, navigation, sections, theater]);

  // 여는 요청(입구가 열 때마다 오르는 포커스 요청)마다 그 주소의 탭을 연다. 가운데 대화를 가진 섹션이면 대화를 세우고 그 대화의
  // 탭(같은 칸을 대신하는 것, 없으면 기본 탭)을 연다.
  const opened = useRef(false);
  const request = open.focusRequest;
  const bindings = useDesktopRailEntries();
  const operationTabs = useConversationOperationTabPanels();
  const railRef = useRef({ bindings, operationTabs });
  railRef.current = { bindings, operationTabs };
  useEffect(() => {
    if (request === null) return;
    const index = sections.findIndex((section) => section.id === open.address.sectionId);
    const section = index >= 0 ? sections[index] : undefined;
    const page = section?.descriptor.pages.find((candidate) => candidate.id === open.address.pageId);
    if (!section || !page) {
      navigation.open({ theaterId: theater.id, ...fallback });
      return;
    }
    if (states[index]?.availability === "loading") return;
    if (!available(index)) {
      navigation.open({ theaterId: theater.id, ...fallback });
      return;
    }
    let tabId = theaterInboxPanelTabId(open.address);
    // 대화를 세우기 전에 보던 패널이 도구(파일 등)이고 이 섹션에서도 서는 도구면 대화를 세운 뒤에도 그 도구를 둔다. 닫혀 있었거나 앞
    // 대화의 탭(목표·구성원)·Inbox 칸이었으면 대화의 탭을 연다.
    const kept = keptToolPanel(getRailStoreSnapshot().activePanelId, railRef.current, section.descriptor.omitsRailEntries);
    let inCenter = section.id === centerSectionId;
    // 대화의 기본 탭으로 가는 진입(사이드바 Theater 머리·팔레트 Theater 전환이 착지하는 사령관 기록)은 대화를 세우는 자동 열림이다 —
    // 사람이 그 대화에서 사이드바를 닫아 두었으면 열지 않는다. 그 밖의 칸(지시·기억·Theater 설정 등)을 고른 진입은 사람이 그 칸을
    // 보려는 것이라 연다.
    if (!inCenter && section.descriptor.openConversation) {
      try { inCenter = section.descriptor.openConversation({ theater, pageId: page.id }); } catch { inCenter = false; }
    }
    if (inCenter) {
      // 대화가 막 섰으면 이 렌더의 center 는 아직 비어 있다 — 지금 선 대화를 스토어에서 바로 읽어 그 대화의 탭을 고른다.
      const selection = getConversationSurface();
      const surface = center?.surface ?? conversationSurfaces.find((candidate) => candidate.id === selection?.surfaceId) ?? null;
      const tab = surface?.tabs?.find((candidate) => candidate.inboxPage === page.id) ?? null;
      const surfaceTabId = tab?.id ?? surface?.defaultTab ?? null;
      if (surfaceTabId === null) {
        opened.current = true;
        return;
      }
      tabId = surfaceTabId;
      if (surfaceTabId === surface?.defaultTab) {
        opened.current = true;
        if (!kept && surface !== null && mayAutoOpenConversationRail(surface.id)) openRailPanel(tabId);
        return;
      }
    }
    opened.current = true;
    if (inCenter && kept) return;
    presentRailPanel(tabId);
    // 요청 하나에 한 번 — 섹션 상태가 바뀌어도 다시 열지 않는다(로딩이 풀릴 때만 다시 돈다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, states[sections.findIndex((section) => section.id === open.address.sectionId)]?.availability]);

  // 패널에서 칸 탭을 고르면 Inbox 주소가 따라간다 — 다음 입구·읽기가 지금 보는 칸을 안다. 패널이 닫히면(열려 있다가 비면)
  // Theater 도 닫는다.
  const previousActive = useRef(activePanelId);
  useEffect(() => {
    const previous = previousActive.current;
    previousActive.current = activePanelId;
    const address = addressOfTab(activePanelId);
    if (address) {
      select(address);
      return;
    }
    if (activePanelId === null && previous !== null && opened.current) navigation.close();
  }, [activePanelId, navigation, select]);

  // 가운데 칸에 Operation 을 새로 고르면 Theater 를 걷는다 — 패널은 그 Operation 의 것이 된다. 사령관 대화가 서며 대상이 비는 것은
  // 고른 것이 아니다.
  const subjectId = subject?.id ?? null;
  const previousSubject = useRef(subjectId);
  useEffect(() => {
    const previous = previousSubject.current;
    previousSubject.current = subjectId;
    if (subjectId !== null && subjectId !== previous) navigation.close();
  }, [navigation, subjectId]);

  // 가운데 칸에 이 Theater 섹션을 대신하지 않는 플러그인 대화(시작 전 목표 등)가 새로 서도 Theater 를 걷는다 — 그 대화는 Operation 이
  // 아니라 대상이 비므로 위의 길로는 걷히지 않는다. 사령관처럼 이 Theater 의 섹션을 대신하는 대화는 Theater 를 연 채 둔다.
  const selection = useConversationSurface();
  const previousSelection = useRef(selection);
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selection;
    if (selection !== null && selection !== previous && center === null) navigation.close();
  }, [center, navigation, selection]);

  // 걷힐 때 이 Theater 의 칸 탭이 연 패널을 닫는다(대화의 탭은 대화가 걷는다).
  useEffect(() => () => {
    const active = getRailStoreSnapshot().activePanelId;
    if (active !== null && addressOfTab(active) !== null) closeRailPanel(active);
  }, []);

  return null;
}

/** 오른쪽 패널의 Inbox 칸 하나 — 섹션 본문과 「적용」 한 줄. 본문은 시트와 같은 섹션 계약으로 그리고, 배치는 칸의 `layout` 을 따르는 공통 틀이 진다. */
function TheaterInboxPanelPage({ theater, language, section, pageId, navigation, fallback, sections }: {
  readonly theater: ConsoleTheaterSummary;
  readonly language: ConsoleLocale;
  readonly section: ResolvedTheaterInboxSection;
  readonly pageId: string;
  readonly navigation: ClientTheaterInboxCapability;
  readonly fallback: TheaterInboxAddress;
  readonly sections: readonly ResolvedTheaterInboxSection[];
}) {
  const t = useT();
  const open = useTheaterInboxState();
  const states = useSectionStates(sections, theater, language);
  const focusRequest = open && open.theaterId === theater.id && open.address.sectionId === section.id && open.address.pageId === pageId ? open.focusRequest : null;
  const links = useMemo(() => {
    const operatorIndex = sections.findIndex((candidate, index) => candidate.descriptor.operatorDirectivePageId && states[index]?.availability === "available");
    const operator = operatorIndex >= 0 ? sections[operatorIndex] : undefined;
    return {
      systemPrompt: fallback,
      operatorDirective: operator?.descriptor.operatorDirectivePageId ? { sectionId: operator.id, pageId: operator.descriptor.operatorDirectivePageId } : null,
    };
  }, [sections, states, fallback]);
  const page = section.descriptor.pages.find((candidate) => candidate.id === pageId);
  const applies = page?.applies?.(language);
  return (
    <ConversationPanelFrame
      layout={page?.layout}
      footer={applies ? <p className="theater-inbox-applies"><span>{t("theaterInbox.applies")}</span>{applies}</p> : null}
    >
      <FeatureErrorBoundary>
        {section.descriptor.render({ theater, language, pageId, visible: true, focusRequest, links, navigation })}
      </FeatureErrorBoundary>
    </ConversationPanelFrame>
  );
}
