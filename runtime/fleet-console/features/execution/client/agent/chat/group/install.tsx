import type { ConversationParticipant, ConversationSpeaker } from "@fleet-console/sdk/conversation";
import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getState, selectNestedBody, subscribe as subscribeConsole } from "../../../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../../../core/client/src/hooks/use-store.js";
import type { OperationNode } from "../../../../../../core/client/src/integration/types.js";
import {
  getConversationStandIn,
  getConversationSubject,
  registerConversationOperationTab,
  setConversationBodyRenderer,
  setConversationCaptionRenderer,
  setConversationStandInComposer,
  subscribeConversationStandIn,
  subscribeConversationSubject,
  useConversationStandIn,
  useConversationSubject,
  type ConversationBodyContext,
  type ConversationCaptionContext,
} from "../../../../../workspace/client/conversation/conversation-slots.js";
import { useOpenBoardActionRecord } from "../../../../../workspace/client/conversation/board-action-record.js";
import { getConversationSurface, subscribeConversationSurface } from "../../../../../workspace/client/conversation/conversation-surface-store.js";
import { stopAgentChatTurn } from "../../api.js";
import { getT } from "../../i18n/index.js";
import { MarkdownLinkBoundary } from "../../markdown-link-boundary.js";
import { useOperationLinks } from "../../operation-links.js";
import { useGroupConversationActions, useGroupUseRequests } from "../group-write.js";
import { isGroupConversationRoot, subscribeGroupClusters, useGroupClusters, useGroupTimeline } from "../group-timeline-store.js";
import { frameCommanderLedger, isCommanderLedgerChosen, setCommanderLedger, subscribeCommanderLedger, useCommanderLedgerChosen } from "./commander-ledger.js";
import { DecisionCard, UseRequestGroupCard } from "./group-cards.js";
import { GroupComposer } from "./group-composer.js";
import { GroupConversation, GroupLedgerFrame } from "./group-conversation.js";
import { setFoldTurns, useFoldTurns } from "./fold-turns.js";
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
 * - 목표 대화의 뿌리(지휘관)이거나 구성원을 가진 채팅 루트를 보고 있으면 그룹 대화가 선다 — 구성원이 아직 없는 지휘관도
 *   같은 화면이다. 루트의 기존 본문은 칸에 붙지 않으므로 본문 풀에서 주차되고(bodyLive=false) 자기 소켓을 열지 않는다.
 * - 오른쪽 「구성원」 탭의 줄이나 대화 말풍선 머리의 표식·이름을 누르면 그 참여자의 기존 본문을 읽기 전용 틀에 넣어 세운다.
 *   구성원은 셸의 구성원 본문 선택이, 지휘관은 `commander-ledger` 가 고른다(셸의 선택은 루트 자신을 고를 수 없다). 원장에는
 *   사람 입력 틀이 없고, 틀 머리의 「대화로 돌아가기」가 대화로 데려온다.
 * - 목표가 아닌 1:1 채팅이거나 루트가 터미널(CLI)로 열려 있으면 기본 본문을 그대로 둔다.
 */
export function installGroupConversationSurface(): () => void {
  ensureMembersTab();
  const disposeBody = setConversationBodyRenderer(renderConversationBody);
  const disposeCaption = setConversationCaptionRenderer(renderConversationCaption);
  const disposeComposer = setConversationStandInComposer((operationId, language) => <StandInComposer key={operationId} rootId={operationId} language={language} />);
  return () => { disposeComposer(); disposeCaption(); disposeBody(); };
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
/** 「구성원」 탭의 등록 id — 이 탭을 다른 표면(모바일 대화 정보)이 명부가 있는 대화에서만 세우려고 가려낼 때 쓴다. */
export const CONVERSATION_MEMBERS_TAB_ID = "conversation.members";
const MEMBERS_TAB = {
  id: CONVERSATION_MEMBERS_TAB_ID,
  title: (locale: "en" | "ko") => getGroupT(locale)("group.members.tab"),
  icon: MembersGlyph,
  order: 10,
  defaultWidth: 320,
  render: (ctx: RailPanelContext) => <MembersTab ctx={ctx} />,
};
function syncMembersTab(): void {
  // 목표가 아닌 1:1 채팅에는 명부가 없다 — 탭을 세우지 않는다. 지휘관은 구성원이 아직 없어도 자기 줄이 있다.
  // 플러그인 대화는 아직 서지 않은 Operation 을 대신할 때만(시작 전 목표) 그 명부로 탭을 세운다.
  const subject = getConversationSubject();
  const standIn = getConversationStandIn();
  const rootId = standIn ?? (subject ? subject.parentOperationId ?? subject.id : null);
  const hidden = (getConversationSurface() !== null && standIn === null) || rootId === null || !hasRoster(rootId);
  if (hidden && releaseMembersTab) { releaseMembersTab(); releaseMembersTab = null; }
  if (!hidden && !releaseMembersTab) releaseMembersTab = registerConversationOperationTab(MEMBERS_TAB);
}
function ensureMembersTab(): void {
  if (membersTabPrepared) return;
  membersTabPrepared = true;
  syncMembersTab();
  // 대화 표면·가운데 칸의 주인·명부가 바뀔 때만 다시 고른다. 레일 목록 변화는 이 셋을 바꾸지 않으므로 설치 재실행 고리가 없다.
  subscribeConversationSurface(syncMembersTab);
  subscribeConversationSubject(syncMembersTab);
  subscribeConversationStandIn(syncMembersTab);
  subscribeConsole(syncMembersTab);
  subscribeGroupClusters(syncMembersTab);
}

/** 명부가 서는 루트 — 구성원이 있거나 목표 대화의 뿌리(지휘관)다. */
function hasRoster(rootId: string): boolean {
  return isGroupConversationRoot(rootId) || getState().nestedOperations.some((operation) => operation.parentOperationId === rootId);
}

/** 원장을 연다 — 루트 id 면 지휘관 원장, 구성원 id 면 그 구성원 원장, null 이면 대화로 돌아간다. 둘은 동시에 서지 않는다. */
export function openLedger(rootId: string, operationId: string | null): void {
  const commander = operationId === rootId;
  setCommanderLedger(rootId, commander);
  selectNestedBody(rootId, commander ? null : operationId);
}

/** 지금 연 원장의 참여자 — 지휘관이면 루트 id, 구성원이면 그 id, 대화를 보고 있으면 null. 「구성원」 탭의 켜짐과 같은 판정이다. */
export function ledgerOperationId(rootId: string): string | null {
  return getState().nestedBodySelection[rootId] ?? (isCommanderLedgerChosen(rootId) ? rootId : null);
}

/** 원장 고름(구성원 본문 선택·지휘관 원장)이 바뀌면 깨운다. */
export function subscribeLedger(listener: () => void): () => void {
  const offConsole = subscribeConsole(listener);
  const offCommander = subscribeCommanderLedger(listener);
  return () => { offConsole(); offCommander(); };
}

/** 이 채팅 루트의 가운데 칸이 그룹 대화인가 — 목표 대화의 뿌리이거나 구성원을 가진 채팅. 모바일 본문도 같은 판정을 쓴다. */
export function isGroupConversationOperation(operation: OperationNode, hasNested: boolean): boolean {
  return operation.payload.chatMode === true && (hasNested || isGroupConversationRoot(operation.id));
}

function renderConversationBody(context: ConversationBodyContext): React.ReactNode | null {
  if (!isGroupConversationOperation(context.operation, context.nestedOperations.length > 0)) return null;
  if (context.bodyOperation.id !== context.operation.id) {
    return <MemberLedger root={context.operation} member={context.bodyOperation} language={context.language}>{context.defaultBody}</MemberLedger>;
  }
  // 데스크톱 가운데 칸의 그룹 대화는 루트(지휘관) Operation 본문 대신 선다 — 그 본문의 채팅 링크 경계를 잃지 않게 같은 길로 감싼다.
  // 구성원·지휘관 원장(MemberLedger)은 기본 본문을 그대로 세우므로 그 본문의 경계가 이미 있다.
  const links: GroupLinkPorts = { navigate: context.navigate, ...(context.openOperationBrowser ? { openOperationBrowser: context.openOperationBrowser } : {}) };
  return <RootBody root={context.operation} language={context.language} links={links}>{context.defaultBody}</RootBody>;
}

/** 대화 머리의 「턴 접기」 스위치 — 그룹 대화가 서는 대화에만, pill 옆에 따로 선다(원장을 보는 동안에도 그 대화의 보기 설정이다). */
function renderConversationCaption(context: ConversationCaptionContext): React.ReactNode | null {
  if (!isGroupConversationOperation(context.operation, context.nestedOperations.length > 0)) return null;
  return <GroupFoldToggle language={context.language} />;
}

function GroupFoldToggle({ language }: { readonly language: "en" | "ko" }) {
  const t = getGroupT(language);
  const folded = useFoldTurns();
  return (
    <button type="button" role="switch" aria-checked={folded} aria-label={t("group.fold.toggle")} className="group-chat-fold-toggle" title={t("group.fold.hint")} onClick={() => setFoldTurns(!folded)}>
      <span className="group-chat-fold-track" aria-hidden="true" />
      <span className="group-chat-fold-label" aria-hidden="true">{t("group.fold.toggle")}</span>
    </button>
  );
}

/**
 * 모바일 Operation 화면의 그룹 대화 — 「턴 접기」를 켠 그룹 루트에서 채팅 본문이 1:1 원장 대신 이 자리를 세운다. 데스크톱 가운데 칸의
 * 루트 자리와 같은 화면이다: 평소에는 그룹 대화, 「구성원」 탭에서 지휘관을 고르면 지휘관 원장(children = 기존 채팅 본문)을 틀에 넣는다.
 * 기존 본문은 원장일 때만 그려지므로 그 동안만 자기 소켓을 연다. 그룹 소켓은 호스트가 실은 대화 주인(`subjectOperationId`)으로
 * 실행 기능의 집계가 연다.
 */
export function MobileGroupConversation({ root, language, children }: { readonly root: OperationNode; readonly language: "en" | "ko"; readonly children: React.ReactNode }) {
  return <RootBody root={root} language={language} phone>{children}</RootBody>;
}

/** 가운데 칸이 기본 본문 대신 그룹 대화를 세울 때 넘겨받는 링크 창구 — 기본 본문(루트 Operation 본문)이 받는 것과 같은 자리다. */
interface GroupLinkPorts {
  readonly navigate: ConversationBodyContext["navigate"];
  readonly openOperationBrowser?: () => void;
}

/**
 * 루트 자리 — 평소에는 그룹 대화, 「구성원」 탭에서 지휘관을 고르면 지휘관의 원장(루트의 기존 본문).
 * `links` 는 데스크톱 가운데 칸만 준다. 폰은 루트 Operation 본문 안에 서므로 그 본문의 채팅 링크 경계가 이미 감싼다.
 */
function RootBody({ root, language, phone = false, links, children }: { readonly root: OperationNode; readonly language: "en" | "ko"; readonly phone?: boolean; readonly links?: GroupLinkPorts; readonly children: React.ReactNode }) {
  const commanderLedger = useCommanderLedgerChosen(root.id);
  if (commanderLedger) return <MemberLedger root={root} member={root} language={language}>{children}</MemberLedger>;
  return links
    ? <GroupLinkBoundary root={root} language={language} ports={links}>{(fileLinkError) => <RootConversation root={root} language={language} phone={phone} fileLinkError={fileLinkError} />}</GroupLinkBoundary>
    : <RootConversation root={root} language={language} phone={phone} />;
}

/**
 * 그룹 대화의 링크 경계 — 루트(지휘관) Operation 의 1:1 채팅과 같은 길(useOperationLinks)이다: 파일·좌표 링크 분류와 열기, 왼클릭의 3행 카드
 * (Operation 브라우저 행은 이 대화의 오른쪽 칸), 수정키·가운데 클릭의 직접 열기. 문서 링크 라우터는 이 영역을 건너뛴다(`self`).
 */
function GroupLinkBoundary({ root, language, ports, children }: {
  readonly root: OperationNode;
  readonly language: "en" | "ko";
  readonly ports: GroupLinkPorts;
  readonly children: (fileLinkError: string | null) => React.ReactNode;
}) {
  const { navigate, openOperationBrowser } = ports;
  const openCompanion = React.useCallback(() => openOperationBrowser?.(), [openOperationBrowser]);
  const links = useOperationLinks({ operationId: root.id, theaterId: root.theaterId, language, navigate, openCompanion });
  const t = getT(language);
  const fileLinkError = links.fileLinkFailure === null ? null : t(links.fileLinkFailure === "unsupported" ? "terminal.fileLink.unsupported" : "terminal.fileLink.failed");
  return (
    <MarkdownLinkBoundary className="group-chat-link-boundary" onClick={links.onLinkClick} onAuxClick={links.onLinkClick} fleetLink="self" {...links.fileLinks}>
      {children(fileLinkError)}
      {links.card}
    </MarkdownLinkBoundary>
  );
}

function RootConversation({ root, language, phone = false, fileLinkError = null }: { readonly root: OperationNode; readonly language: "en" | "ko"; readonly phone?: boolean; readonly fileLinkError?: string | null }) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root.id), language);
  const fold = useFoldTurns();
  const actions = useGroupConversationActions(root.id);
  const useRequests = useGroupUseRequests(root.id);
  const openMemberLedger = React.useCallback((operationId: string) => openLedger(root.id, operationId), [root.id]);
  // 사령관 행위 줄 → 읽기 전용 사령관 기록(그 턴 위치). 기록을 찾는 일은 묶음을 공급한 플러그인이 한다(임무 14 계약).
  const openRecord = useOpenBoardActionRecord(useGroupClusters());
  // 답이 받아들여진 요청은 보드가 요청을 걷기 전에도 카드를 내린다. 답은 보드가 결정으로 남긴 대화 줄로 그 시각 자리에 선다.
  const [answered, setAnswered] = React.useState<readonly string[]>([]);
  React.useEffect(() => setAnswered([]), [root.id]);
  const speakerOf = (operationId: string) => snapshot.participants.find((participant) => participant.speaker.operationId === operationId)?.speaker ?? null;
  const commander = snapshot.participants.find((participant) => participant.speaker.kind === "commander")?.speaker ?? null;
  const decision = snapshot.decision && !answered.includes(snapshot.decision.id) ? snapshot.decision : null;
  const cards = (
    <>
      {decision ? (
        <DecisionCard
          decision={decision}
          actions={actions}
          asker={commander}
          language={language}
          phone={phone}
          onAnswered={(id) => setAnswered((current) => (current.includes(id) ? current : [...current, id]))}
        />
      ) : null}
      {useRequests.map((request) => <UseRequestGroupCard key={request.id} request={request} speaker={speakerOf(request.operationId)} language={language} />)}
      {fileLinkError !== null ? <div className="agent-chat-sys agent-chat-sys--error" role="alert">{fileLinkError}</div> : null}
    </>
  );
  return (
    <GroupConversation
      snapshot={snapshot}
      language={language}
      onOpenLedger={openMemberLedger}
      onOpenCommodoreRecord={openRecord}
      cards={cards}
      fold={fold}
      composer={<GroupComposer key={root.id} rootOperationId={root.id} snapshot={snapshot} actions={actions} language={language} onStopOne={stopOne} />}
    />
  );
}

/**
 * 아직 서지 않은(시작 전) 또는 보관된(완료한) 지휘관 자리의 입력창 — 플러그인 대화가 자리를 고르고, 입력창은 그 id 의 묶음 대화 계약으로
 * 같은 그룹 입력창이 선다. 일하는 참여자가 없으므로 정지는 서지 않는다.
 */
function StandInComposer({ rootId, language }: { readonly rootId: string; readonly language: "en" | "ko" }) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(rootId), language);
  const actions = useGroupConversationActions(rootId);
  return <GroupComposer rootOperationId={rootId} snapshot={snapshot} actions={actions} language={language} onStopOne={stopOne} />;
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
  const commander = member.id === root.id;
  const speaker: ConversationSpeaker = snapshot.participants.find((participant) => participant.speaker.operationId === member.id)?.speaker
    ?? { kind: commander ? "commander" : "member", name: member.title, operationId: member.id };
  // 지휘관 본문은 평소 입력 틀을 가진 채팅이다 — 이 틀 안에 선 동안만 구성원 원장처럼 입력 틀을 뺀다(commander-ledger).
  React.useLayoutEffect(() => (commander ? frameCommanderLedger(root.id) : undefined), [commander, root.id]);
  return (
    <GroupLedgerFrame speaker={speaker} language={language} onBack={() => openLedger(root.id, null)}>
      {children}
    </GroupLedgerFrame>
  );
}

function MembersTab({ ctx }: { readonly ctx: RailPanelContext }) {
  const standIn = useConversationStandIn();
  const language = ctx.language ?? "en";
  return standIn !== null ? <StandInMembersTab rootId={standIn} language={language} /> : <OperationMembersTab language={language} />;
}

/**
 * 아직 서지 않은 Operation(시작 전 목표의 지휘관 자리)을 대신하는 대화의 명부 — 같은 구성원 패널에 지휘관과 명부의 구성원이 시작 전으로
 * 선다. 원장이 없으므로 줄은 단추가 아니다. 지휘관은 개시하면 이 id 로 서므로 그 자리의 얼굴(아바타 키)이 그대로 이어진다.
 */
function StandInMembersTab({ rootId, language }: { readonly rootId: string; readonly language: "en" | "ko" }) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(rootId), language);
  const clusters = useGroupClusters();
  const t = getGroupT(language);
  // 지휘관 줄은 Operation 이 없어 여기서 세운다 — 보드 사실(지휘관 모델 줄)은 명부의 commander profile 에서 그대로 붙인다.
  const commander = clusters.find((cluster) => cluster.conversation?.operationId === rootId)?.conversation?.commander;
  const participants = React.useMemo<readonly ConversationParticipant[]>(() => (
    snapshot.participants.some((participant) => participant.speaker.kind === "commander")
      ? snapshot.participants
      : [{ speaker: { kind: "commander", name: t("group.commander"), operationId: rootId }, activity: "unknown", ...(commander ? { profile: commander } : {}) }, ...snapshot.participants]
  ), [rootId, snapshot.participants, t, commander]);
  if (!clusters.some((cluster) => cluster.conversation?.operationId === rootId)) return <p className="group-members-empty">{t("group.members.none")}</p>;
  return <GroupMembersPanel snapshot={{ ...snapshot, participants }} language={language} ledgerOperationId={null} notStarted />;
}

function OperationMembersTab({ language }: { readonly language: "en" | "ko" }) {
  const subject = useConversationSubject();
  const state = useConsoleState();
  // 구성원의 본문을 보고 있어도 탭은 그 루트의 명부를 보인다.
  const root = subject ? (subject.parentOperationId ? state.operations.find((operation) => operation.id === subject.parentOperationId) ?? subject : subject) : null;
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root?.id ?? null), language);
  const clusters = useGroupClusters();
  const commanderLedger = useCommanderLedgerChosen(root?.id ?? null);
  const hasRoster = root !== null && (clusters.some((cluster) => cluster.conversation?.operationId === root.id)
    || state.nestedOperations.some((operation) => operation.parentOperationId === root.id));
  if (!root || !hasRoster) return <p className="group-members-empty">{getGroupT(language)("group.members.none")}</p>;
  return (
    <GroupMembersPanel
      snapshot={snapshot}
      language={language}
      ledgerOperationId={state.nestedBodySelection[root.id] ?? (commanderLedger ? root.id : null)}
      onOpenLedger={(operationId) => openLedger(root.id, operationId)}
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
