import type { ConversationSpeaker } from "@fleet-console/sdk/conversation";
import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { React } from "@fleet-console/sdk/plugin/browser";

import { selectNestedBody } from "../../../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../../../core/client/src/hooks/use-store.js";
import type { OperationNode } from "../../../../../../core/client/src/integration/types.js";
import {
  registerConversationOperationTab,
  setConversationBodyRenderer,
  useConversationSubject,
  type ConversationBodyContext,
} from "../../../../../workspace/client/conversation/conversation-slots.js";
import { useOpenBoardActionRecord } from "../../../../../workspace/client/conversation/board-action-record.js";
import { getConversationSurface, subscribeConversationSurface } from "../../../../../workspace/client/conversation/conversation-surface-store.js";
import { stopAgentChatTurn } from "../../api.js";
import { useGroupConversationActions, useGroupUseRequests } from "../group-write.js";
import { useGroupClusters, useGroupTimeline } from "../group-timeline-store.js";
import { DecisionCard, SettledDecisionLine, UseRequestGroupCard, type SettledDecision } from "./group-cards.js";
import { GroupComposer } from "./group-composer.js";
import { GroupConversation, GroupLedgerFrame } from "./group-conversation.js";
import { getGroupT } from "./group-chat-i18n.js";
import { GroupMembersPanel } from "./group-members-panel.js";
import { useLocalizedSnapshot } from "./speaker-mark.js";

/**
 * 그룹 대화를 대화 중심 화면에 끼운다 — 가운데 칸 본문 렌더러와 오른쪽 「구성원」 탭.
 *
 * 실행 기능의 설치 수명이 등록하고 걷는다(호스트 번들 안의 슬롯이라 플러그인 번들에서 부르지 않는다).
 * 두 표면 모두 `useGroupTimeline` 의 구독자일 뿐이고, 연결은 같은 설치 수명의 전역 관측이 쥔다.
 *
 * 가운데 칸 규칙:
 * - 구성원을 가진 채팅 루트를 보고 있으면 그룹 대화가 선다. 루트의 기존 본문은 칸에 붙지 않으므로 본문 풀에서
 *   주차되고(bodyLive=false) 자기 소켓을 열지 않는다.
 * - 노드 줄이나 「원장 보기」로 구성원을 고르면(셸의 구성원 본문 선택) 그 구성원의 기존 본문을 읽기 전용 틀에 넣어 세운다.
 *   구성원 본문에는 처음부터 사람 입력 틀이 없다.
 * - 구성원이 없거나 루트가 터미널(CLI)로 열려 있으면 기본 본문을 그대로 둔다.
 */
export function installGroupConversationSurface(): () => void {
  ensureMembersTab();
  return setConversationBodyRenderer(renderConversationBody);
}

/**
 * 「구성원」 탭은 설치 수명에 묶지 않고 페이지 수명 동안 한 번 준비한다. 탭은 대화 중심 화면이 서 있을 때만 레일 목록에 실리므로
 * 실험이 꺼진 Console 에는 보이지 않는다.
 *
 * 설치 수명에 묶으면 안 되는 이유: 레일 목록이 바뀌면 앱이 provider 설치를 다시 돌린다(레일 바인딩이 그 effect 의 의존).
 * 설치마다 탭을 걷고 다시 등록하면 목록 스냅숏이 매번 새로 나고, 그것이 다시 설치를 부르는 무한 갱신이 된다.
 *
 * 가운데 칸에 플러그인 대화(사령관 기록 등)가 서 있는 동안에는 탭을 걷는다 — 그 화면의 구성원이 아니다. 걷고 다시 다는 일은
 * 대화 표면이 바뀔 때만 일어나고, 레일 목록 변화가 그 표면을 바꾸지 않으므로 위의 고리는 생기지 않는다.
 */
let membersTabPrepared = false;
let releaseMembersTab: (() => void) | null = null;
const MEMBERS_TAB = {
  id: "conversation.members",
  title: (locale: "en" | "ko") => getGroupT(locale)("group.members.tab"),
  icon: MembersGlyph,
  order: 10,
  defaultWidth: 320,
  render: (ctx: RailPanelContext) => <MembersTab ctx={ctx} />,
};
function syncMembersTab(): void {
  const hidden = getConversationSurface() !== null;
  if (hidden && releaseMembersTab) { releaseMembersTab(); releaseMembersTab = null; }
  if (!hidden && !releaseMembersTab) releaseMembersTab = registerConversationOperationTab(MEMBERS_TAB);
}
function ensureMembersTab(): void {
  if (membersTabPrepared) return;
  membersTabPrepared = true;
  syncMembersTab();
  subscribeConversationSurface(syncMembersTab);
}

function renderConversationBody(context: ConversationBodyContext): React.ReactNode | null {
  if (context.nestedOperations.length === 0) return null;
  if (context.operation.payload.chatMode !== true) return null;
  if (context.bodyOperation.id !== context.operation.id) {
    return <MemberLedger root={context.operation} member={context.bodyOperation} language={context.language}>{context.defaultBody}</MemberLedger>;
  }
  return <RootConversation root={context.operation} language={context.language} />;
}

function RootConversation({ root, language }: { readonly root: OperationNode; readonly language: "en" | "ko" }) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root.id), language);
  const actions = useGroupConversationActions(root.id);
  const useRequests = useGroupUseRequests(root.id);
  const openLedger = React.useCallback((operationId: string) => selectNestedBody(root.id, operationId), [root.id]);
  // 사령관 행위 줄 → 읽기 전용 사령관 기록(그 턴 위치). 기록을 찾는 일은 묶음을 공급한 플러그인이 한다(임무 14 계약).
  const openRecord = useOpenBoardActionRecord(useGroupClusters());
  // 답한 결정은 보드에서 요청이 걷혀도 이 화면을 보는 동안 한 줄로 남는다.
  const [settled, setSettled] = React.useState<readonly SettledDecision[]>([]);
  React.useEffect(() => setSettled([]), [root.id]);
  const speakerOf = (operationId: string) => snapshot.participants.find((participant) => participant.speaker.operationId === operationId)?.speaker ?? null;
  const commander = snapshot.participants.find((participant) => participant.speaker.kind === "commander")?.speaker ?? null;
  const decision = snapshot.decision && !settled.some((entry) => entry.id === snapshot.decision!.id) ? snapshot.decision : null;
  const cards = (
    <>
      {settled.map((entry) => <SettledDecisionLine key={entry.id} settled={entry} language={language} />)}
      {decision ? (
        <DecisionCard
          decision={decision}
          actions={actions}
          asker={commander}
          language={language}
          onSettled={(entry) => setSettled((current) => [...current.filter((item) => item.id !== entry.id), entry])}
        />
      ) : null}
      {useRequests.map((request) => <UseRequestGroupCard key={request.id} request={request} speaker={speakerOf(request.operationId)} language={language} />)}
    </>
  );
  return (
    <GroupConversation
      snapshot={snapshot}
      language={language}
      onOpenLedger={openLedger}
      onOpenCommodoreRecord={openRecord}
      onStopParticipant={(speaker) => { void stopOne(speaker).catch(() => undefined); }}
      cards={cards}
      composer={<GroupComposer snapshot={snapshot} actions={actions} language={language} onStopOne={stopOne} />}
    />
  );
}

/** 한 명 정지 — 기존 실행 중 중지 경로(채팅 턴만 닫는다. 백그라운드 작업은 그대로). */
function stopOne(speaker: ConversationSpeaker): Promise<void> {
  return speaker.operationId ? stopAgentChatTurn(speaker.operationId) : Promise.resolve();
}

function MemberLedger({ root, member, language, children }: {
  readonly root: OperationNode;
  readonly member: OperationNode;
  readonly language: "en" | "ko";
  readonly children: React.ReactNode;
}) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root.id), language);
  const speaker: ConversationSpeaker = snapshot.participants.find((participant) => participant.speaker.operationId === member.id)?.speaker
    ?? { kind: "member", name: member.title, operationId: member.id };
  return (
    <GroupLedgerFrame speaker={speaker} language={language} onBack={() => selectNestedBody(root.id, null)}>
      {children}
    </GroupLedgerFrame>
  );
}

function MembersTab({ ctx }: { readonly ctx: RailPanelContext }) {
  const subject = useConversationSubject();
  const state = useConsoleState();
  const language = ctx.language ?? "en";
  // 구성원의 본문을 보고 있어도 탭은 그 루트의 명부를 보인다.
  const root = subject ? (subject.parentOperationId ? state.operations.find((operation) => operation.id === subject.parentOperationId) ?? subject : subject) : null;
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root?.id ?? null), language);
  const hasMembers = root !== null && state.nestedOperations.some((operation) => operation.parentOperationId === root.id);
  if (!root || !hasMembers) return <p className="group-members-empty">{getGroupT(language)("group.members.none")}</p>;
  return (
    <GroupMembersPanel
      snapshot={snapshot}
      language={language}
      ledgerOperationId={state.nestedBodySelection[root.id] ?? null}
      onOpenLedger={(operationId) => selectNestedBody(root.id, operationId)}
      onStop={(speaker) => { void stopOne(speaker).catch(() => undefined); }}
    />
  );
}

function MembersGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5.5" r="2.2" />
      <path d="M2 13c.5-2.3 2.1-3.5 4-3.5s3.5 1.2 4 3.5" />
      <path d="M10.5 3.6a2.1 2.1 0 0 1 0 3.9M12 9.9c1 .5 1.7 1.5 2 3.1" />
    </svg>
  );
}
