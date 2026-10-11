import { useEffect, useMemo, useRef } from "react";
import type { TheaterInboxAddress } from "@fleet-console/sdk/theater-inbox";

import { useConsoleLocale } from "../i18n/index.js";
import { useTheaterLabel } from "../hooks/use-store.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { getViewModeSnapshot, useViewMode } from "./view-mode-store.js";
import { createTheaterSettingsInboxSection, THEATER_SETTINGS_SECTION_ID, THEATER_SYSTEM_PROMPT_PAGE_ID } from "../../../../features/settings/client/theater-settings-inbox.js";
import { openTheaterSystemPrompt, subscribeTheaterSystemPromptOpen } from "../../../../features/settings/client/theater-prompt-editor.js";
import { closeTheaterInbox, openTheaterInbox, readTheaterInboxState, selectTheaterInboxPage, theaterInboxCapability, theaterInboxReturnTarget, useTheaterInboxState } from "../../../../features/workspace/client/theater-inbox/store.js";
import { theaterInitials } from "../../../../features/workspace/client/sidebar/theater-initials.js";
import { TheaterMonogram } from "../../../../features/workspace/client/sidebar/theater-monogram.js";
import { TheaterInboxSheet, type ResolvedTheaterInboxSection } from "../../../../features/workspace/client/theater-inbox/theater-inbox-sheet.js";

/** 호스트의 「Theater 설정」 — 정준 id 는 `console:settings`. 플러그인 섹션은 그 뒤에 등록 순서로 선다. */
// 「Theater 설정」의 표식은 사이드바 Theater 머리와 같은 모노그램이다 — settings feature 가 workspace 를 가져오지 않게 여기서 넘긴다.
const SETTINGS_SECTION: ResolvedTheaterInboxSection = {
  id: `console:${THEATER_SETTINGS_SECTION_ID}`,
  descriptor: createTheaterSettingsInboxSection({ icon: ({ theater }) => <TheaterMonogram compact>{theaterInitials(theater.label)}</TheaterMonogram> }),
};
const SYSTEM_PROMPT_ADDRESS: TheaterInboxAddress = { sectionId: SETTINGS_SECTION.id, pageId: THEATER_SYSTEM_PROMPT_PAGE_ID };

/**
 * Theater Inbox 의 합성 — 시트 틀(workspace feature), 호스트의 「Theater 설정」(settings feature), 플러그인 섹션(registry)을
 * 한 자리에서 잇는다. 사이드바 Theater 메뉴의 「시스템 프롬프트…」는 데스크톱에서 여기로 와서 Theater 설정 칸을 연다.
 * 시트는 데스크톱 전용이다 — 폰 배치로 바뀌면 보던 섹션을 폰 화면에 넘기고 닫는다.
 */
export function TheaterInboxHost() {
  const { theaterInboxSections } = usePluginRegistry();
  const language = useConsoleLocale();
  const mobile = useViewMode().effective === "mobile";
  const open = useTheaterInboxState();
  const sections = useMemo<readonly ResolvedTheaterInboxSection[]>(() => [
    SETTINGS_SECTION,
    ...theaterInboxSections.map((descriptor) => ({ id: descriptor.id, descriptor })),
  ], [theaterInboxSections]);
  const label = useTheaterLabel(open?.theaterId);
  // 연 채로 Theater 가 잊혀도 시트는 남는다(프롬프트 칸이 남은 글을 보여 준다) — 마지막 이름을 붙들어 둔다.
  const lastLabel = useRef<{ readonly id: string; readonly label: string } | null>(null);
  if (open && label !== null) lastLabel.current = { id: open.theaterId, label };
  const theaterLabel = open ? (label ?? (lastLabel.current?.id === open.theaterId ? lastLabel.current.label : "")) : "";
  const theater = useMemo(() => open ? { id: open.theaterId, label: theaterLabel } : null, [open?.theaterId, theaterLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => subscribeTheaterSystemPromptOpen((request) => {
    // 폰의 입구는 프롬프트 시트가 받는다.
    if (getViewModeSnapshot().effective === "mobile") return;
    openTheaterInbox({ theaterId: request.theater.id, ...SYSTEM_PROMPT_ADDRESS, returnFocus: request.returnFocus });
  }), []);

  // 데스크톱에서 연 채 폰 배치로 바뀌면 — 보던 섹션의 폰 화면으로 넘기고 시트를 닫는다(언마운트가 대기 저장을 확정한다).
  useEffect(() => {
    if (!mobile) return;
    const current = readTheaterInboxState();
    if (!current) return;
    const summary = { id: current.theaterId, label: lastLabel.current?.id === current.theaterId ? lastLabel.current.label : "" };
    closeTheaterInbox();
    if (current.address.sectionId === SETTINGS_SECTION.id) {
      openTheaterSystemPrompt(summary, null);
      return;
    }
    const section = sections.find((candidate) => candidate.id === current.address.sectionId);
    section?.descriptor.onLeaveDesktop?.({ theater: summary, pageId: current.address.pageId });
  }, [mobile, sections]);

  if (!open || !theater || mobile) return null;
  return (
    <TheaterInboxSheet
      open={open}
      theater={theater}
      sections={sections}
      language={language}
      navigation={theaterInboxCapability}
      select={selectTheaterInboxPage}
      fallback={SYSTEM_PROMPT_ADDRESS}
      returnTarget={theaterInboxReturnTarget}
    />
  );
}
