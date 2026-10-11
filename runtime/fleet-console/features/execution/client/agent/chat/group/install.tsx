import type { ConversationSpeaker } from "@fleet-console/sdk/conversation";
import { React } from "@fleet-console/sdk/plugin/browser";

import { selectNestedBody } from "../../../../../../core/client/src/integration/store.js";
import type { OperationNode } from "../../../../../../core/client/src/integration/types.js";
import { setConversationBodyRenderer, type ConversationBodyContext } from "../../../../../workspace/client/conversation/conversation-slots.js";
import { useOpenBoardActionRecord } from "../../../../../workspace/client/conversation/board-action-record.js";
import { stopAgentChatTurn } from "../../api.js";
import { useGroupConversationActions, useGroupUseRequests } from "../group-write.js";
import { useGroupClusters, useGroupTimeline } from "../group-timeline-store.js";
import { DecisionCard, SettledDecisionLine, UseRequestGroupCard, type SettledDecision } from "./group-cards.js";
import { GroupComposer } from "./group-composer.js";
import { GroupConversation, GroupLedgerFrame } from "./group-conversation.js";
import { useLocalizedSnapshot } from "./speaker-mark.js";

/**
 * 그룹 대화를 대화 중심 화면에 끼운다 — 가운데 칸 본문 렌더러.
 *
 * 실행 기능의 설치 수명이 등록하고 걷는다(호스트 번들 안의 슬롯이라 플러그인 번들에서 부르지 않는다).
 * 표면은 `useGroupTimeline` 의 구독자일 뿐이고, 연결은 같은 설치 수명의 전역 관측이 쥔다. 구성원 명부·활동·원장 보기·정지는
 * 목표 패널(Objectives 「목표」 탭)의 구성원 섹션이 맡는다 — 같은 명부를 두 곳에 두지 않는다.
 *
 * 가운데 칸 규칙:
 * - 구성원을 가진 채팅 루트를 보고 있으면 그룹 대화가 선다. 루트의 기존 본문은 칸에 붙지 않으므로 본문 풀에서
 *   주차되고(bodyLive=false) 자기 소켓을 열지 않는다.
 * - 노드 줄이나 「원장 보기」로 구성원을 고르면(셸의 구성원 본문 선택) 그 구성원의 기존 본문을 읽기 전용 틀에 넣어 세운다.
 *   구성원 본문에는 처음부터 사람 입력 틀이 없다.
 * - 구성원이 없거나 루트가 터미널(CLI)로 열려 있으면 기본 본문을 그대로 둔다.
 */
export function installGroupConversationSurface(): () => void {
  return setConversationBodyRenderer(renderConversationBody);
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

