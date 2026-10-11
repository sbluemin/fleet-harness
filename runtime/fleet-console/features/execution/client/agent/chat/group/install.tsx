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
import { useGroupTimeline } from "../group-timeline-store.js";
import { GroupConversation, GroupLedgerFrame } from "./group-conversation.js";
import { getGroupT } from "./group-chat-i18n.js";
import { GroupMembersPanel } from "./group-members-panel.js";

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
 * 「구성원」 탭은 페이지 수명 동안 한 번만 등록하고 걷지 않는다. 탭은 대화 중심 화면이 서 있을 때만 레일 목록에 실리므로
 * 실험이 꺼진 Console 에는 보이지 않는다.
 *
 * 설치 수명에 묶으면 안 되는 이유: 레일 목록이 바뀌면 앱이 provider 설치를 다시 돌린다(레일 바인딩이 그 effect 의 의존).
 * 설치마다 탭을 걷고 다시 등록하면 목록 스냅숏이 매번 새로 나고, 그것이 다시 설치를 부르는 무한 갱신이 된다.
 */
let membersTabRegistered = false;
function ensureMembersTab(): void {
  if (membersTabRegistered) return;
  membersTabRegistered = true;
  registerConversationOperationTab({
    id: "conversation.members",
    title: (locale) => getGroupT(locale)("group.members.tab"),
    icon: MembersGlyph,
    order: 10,
    defaultWidth: 320,
    render: (ctx) => <MembersTab ctx={ctx} />,
  });
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
  const snapshot = useGroupTimeline(root.id);
  const openLedger = React.useCallback((operationId: string) => selectNestedBody(root.id, operationId), [root.id]);
  // 사령관 기록 열기(onOpenCommodoreRecord)와 정지(onStopParticipant)는 아직 연결하지 않는다 — 단추도 서지 않는다.
  return <GroupConversation snapshot={snapshot} language={language} onOpenLedger={openLedger} />;
}

function MemberLedger({ root, member, language, children }: {
  readonly root: OperationNode;
  readonly member: OperationNode;
  readonly language: "en" | "ko";
  readonly children: React.ReactNode;
}) {
  const snapshot = useGroupTimeline(root.id);
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
  const snapshot = useGroupTimeline(root?.id ?? null);
  const hasMembers = root !== null && state.nestedOperations.some((operation) => operation.parentOperationId === root.id);
  if (!root || !hasMembers) return <p className="group-members-empty">{getGroupT(language)("group.members.none")}</p>;
  return (
    <GroupMembersPanel
      snapshot={snapshot}
      language={language}
      ledgerOperationId={state.nestedBodySelection[root.id] ?? null}
      onOpenLedger={(operationId) => selectNestedBody(root.id, operationId)}
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
