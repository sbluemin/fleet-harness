/**
 * 그룹 대화 표면 — 대화 중심 화면의 가운데 칸 본문과 오른쪽 「구성원」 탭 본문.
 * 스냅숏은 `../group-timeline-store.js` 의 `useGroupTimeline` 이 준다. 이 표면은 연결을 소유하지 않는다.
 */
export { GroupConversation, GroupWorkingLine, type GroupConversationProps } from "./group-conversation.js";
export { GroupMembersPanel, type GroupMembersPanelProps } from "./group-members-panel.js";
export { setGroupLedgerFocus, useGroupLedgerFocus } from "./group-ledger-focus.js";
