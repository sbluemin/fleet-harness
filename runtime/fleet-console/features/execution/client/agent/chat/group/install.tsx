import { useConversationDockHeight } from "../../../../../workspace/client/conversation/conversation-dock-height.js";
import { OpenUINavigationContext } from "../../openui-boundary.js";
import type { ConversationSpeaker, GroupConversationActions } from "../../../../shared/conversation/types.js";
import * as React from "react";

import { getState, selectNestedBody, subscribe as subscribeConsole } from "../../../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../../../core/client/src/hooks/use-store.js";
import type { ObjectiveRecord } from "../../../../../../core/client/src/integration/types.js";
import {
  setConversationBodyRenderer,
  setConversationStandInComposer,
  setConversationToolbarTail,
  type ConversationBodyContext,
  type ConversationToolbarTailContext,
} from "../../../../../workspace/client/conversation/conversation-slots.js";
import { stopAgentChatTurn } from "../../api.js";
import { CliFailureCard } from "../../../../../commodore/client/commodore-cli-status.js";
import { getT as getCommodoreT } from "../../../../../commodore/client/i18n/index.js";
import { ComputerScreenShare, useAllObjectiveUseRequests, useComputerActor, type ObjectiveUseRequest } from "../../../../../computer-use/client/computer-screen-share.js";
import { BrowserActivityLines } from "../../../../../browser/client/browser-activity.js";
import { getT } from "../../i18n/index.js";
import { MarkdownLinkBoundary } from "../../markdown-link-boundary.js";
import { useObjectiveLinks } from "../../objective-links.js";
import { isGroupConversationRoot, useGroupClusters, useGroupTimeline } from "../group-timeline-store.js";
import { frameCommanderLedger, isCommanderLedgerChosen, setCommanderLedger, subscribeCommanderLedger, useCommanderLedgerChosen } from "./commander-ledger.js";
import { DecisionCard, UseRequestGroupCard } from "./group-cards.js";
import { fillGroupComposerDraft, GroupComposer } from "./group-composer.js";
import { ComposerTopEntries } from "../composer-top-entries.js";
import { CommanderFlowConversation } from "./commander-flow.js";
import { GroupLedgerFrame } from "./group-conversation.js";
import { getGroupT } from "./group-chat-i18n.js";
import { SpeakerMark, useLocalizedSnapshot } from "./speaker-mark.js";
import { registerObjectiveContextRail } from "./context-rail.js";
import { ConversationViewToggle, setGroupConversationView, useGroupConversationView } from "./conversation-view.js";
import { GroupLedgerSplit, type GroupLedgerSplitPane } from "./ledger-split.js";

/**
 * 그룹 대화를 대화 중심 화면에 끼운다 — 가운데 칸 본문 렌더러·컨텍스트 레일·원장 전환 단추.
 *
 * 실행 기능의 설치 수명이 등록하고 걷는다(호스트 번들 안의 슬롯이라 플러그인 번들에서 부르지 않는다).
 * 본문은 `useGroupTimeline` 의 구독자일 뿐이고, 연결은 같은 설치 수명의 전역 관측이 쥔다.
 *
 * 가운데 칸 규칙:
 * - 목표 대화의 뿌리(지휘관)이거나 구성원을 가진 채팅 루트를 보고 있으면 그룹 대화가 선다 — 구성원이 아직 없는 지휘관도
 *   같은 화면이다. 루트의 기존 본문은 칸에 붙지 않으므로 본문 풀에서 주차되고(bodyLive=false) 자기 소켓을 열지 않는다.
 * - 데스크톱 그룹채팅의 말풍선 머리 표식·이름(네임플레이트)만 참여자와 무관하게 화면 전환 설정을 원장으로 바꾼다(`conversation-view`).
 *   알림 종 오른쪽의 전환 단추도 같은 설정을 고친다.
 * - 작업 줄·진행 메모 링크·전언 화면·목표 팝업(폰은 네임플레이트도)을 누르면 그 참여자의 기존 본문을 읽기 전용 틀에 넣어 세운다.
 *   구성원은 셸의 구성원 본문 선택이, 지휘관은 `commander-ledger` 가 고른다(셸의 선택은 루트 자신을 고를 수 없다). 원장에는
 *   사람 입력 틀이 없고, 틀 머리의 「대화로 돌아가기」가 대화로 데려온다.
 * - 목표가 아닌 1:1 채팅이거나 루트가 터미널(CLI)로 열려 있으면 기본 본문을 그대로 둔다.
 */
export function installGroupConversationSurface(): () => void {
  const disposeBody = setConversationBodyRenderer(renderConversationBody);
  const disposeComposer = setConversationStandInComposer((objectiveId, language) => <StandInComposer key={objectiveId} rootId={objectiveId} language={language} />);
  const disposeRail = registerObjectiveContextRail();
  const disposeTail = setConversationToolbarTail(renderToolbarTail);
  return () => { disposeTail(); disposeRail(); disposeComposer(); disposeBody(); };
}

/** 머리 줄 알림 종 오른쪽의 그룹채팅/원장 전환 — 가운데 칸이 그룹 대화일 때만 선다(본문 렌더러와 같은 판정). */
function renderToolbarTail(context: ConversationToolbarTailContext): React.ReactNode | null {
  if (!isGroupConversationObjective(context.objectiveRecord, context.nestedObjectiveRecords.length > 0)) return null;
  return <ConversationViewToggle root={context.objectiveRecord} language={context.language} onLeaveLedger={leaveLedger} />;
}

/** 개별 원장(작업 줄·목표 팝업에서 고른 참여자)을 내린다 — 화면 전환 단추가 고른 화면이 바로 서게. */
function leaveLedger(rootId: string): void {
  if (ledgerObjectiveId(rootId) !== null) openLedger(rootId, null);
}

/** 원장을 연다 — 루트 id 면 지휘관 원장, 구성원 id 면 그 구성원 원장, null 이면 대화로 돌아간다. 둘은 동시에 서지 않는다. */
export function openLedger(rootId: string, objectiveId: string | null): void {
  const commander = objectiveId === rootId;
  setCommanderLedger(rootId, commander);
  selectNestedBody(rootId, commander ? null : objectiveId);
}

/** 지금 연 원장의 참여자 — 지휘관이면 루트 id, 구성원이면 그 id, 대화를 보고 있으면 null. */
export function ledgerObjectiveId(rootId: string): string | null {
  return getState().nestedBodySelection[rootId] ?? (isCommanderLedgerChosen(rootId) ? rootId : null);
}

/** 원장 고름(구성원 본문 선택·지휘관 원장)이 바뀌면 깨운다. */
export function subscribeLedger(listener: () => void): () => void {
  const offConsole = subscribeConsole(listener);
  const offCommander = subscribeCommanderLedger(listener);
  return () => { offConsole(); offCommander(); };
}

/** 이 채팅 루트의 가운데 칸이 그룹 대화인가 — 목표 대화의 뿌리이거나 구성원을 가진 채팅. 모바일 본문도 같은 판정을 쓴다. */
export function isGroupConversationObjective(objectiveRecord: ObjectiveRecord, hasNested: boolean): boolean {
  return hasNested || isGroupConversationRoot(objectiveRecord.id);
}

function renderConversationBody(context: ConversationBodyContext): React.ReactNode | null {
  if (!isGroupConversationObjective(context.objectiveRecord, context.nestedObjectiveRecords.length > 0)) return null;
  if (context.bodyObjective.id !== context.objectiveRecord.id) {
    return <MemberLedger root={context.objectiveRecord} member={context.bodyObjective} language={context.language}>{context.defaultBody}</MemberLedger>;
  }
  // 데스크톱 가운데 칸의 그룹 대화는 루트(지휘관) Objective 본문 대신 선다 — 그 본문의 채팅 링크 경계를 잃지 않게 같은 길로 감싼다.
  // 구성원·지휘관 원장(MemberLedger)은 기본 본문을 그대로 세우므로 그 본문의 경계가 이미 있다.
  const links: GroupLinkPorts = { navigate: context.navigate, ...(context.openObjectiveBrowser ? { openObjectiveBrowser: context.openObjectiveBrowser } : {}) };
  const split: LedgerSplitPorts = { nestedObjectiveRecords: context.nestedObjectiveRecords, renderParticipantBody: context.renderParticipantBody };
  return <RootBody root={context.objectiveRecord} language={context.language} links={links} split={split}>{context.defaultBody}</RootBody>;
}

/**
 * 모바일 Objective 화면의 그룹 대화 — 살아 있는 그룹 채팅 루트에서 본문이 1:1 원장 대신 이 자리를 세운다. 데스크톱 가운데 칸의
 * 루트 자리와 같은 화면이다: 평소에는 그룹 대화, 「구성원」 탭에서 지휘관을 고르면 지휘관 원장(children = 기존 채팅 본문)을 틀에 넣는다.
 * 기존 본문은 원장일 때만 그려지므로 그 동안만 자기 소켓을 연다. 그룹 소켓은 호스트가 실은 대화 주인(`subjectObjectiveId`)으로
 * 실행 기능의 집계가 연다.
 */
export function MobileGroupConversation({ root, language, children }: { readonly root: ObjectiveRecord; readonly language: "en" | "ko"; readonly children: React.ReactNode }) {
  return <RootBody root={root} language={language} phone>{children}</RootBody>;
}

/** 가운데 칸이 기본 본문 대신 그룹 대화를 세울 때 넘겨받는 링크 창구 — 기본 본문(루트 Objective 본문)이 받는 것과 같은 자리다. */
interface GroupLinkPorts {
  readonly navigate: ConversationBodyContext["navigate"];
  readonly openObjectiveBrowser?: () => void;
}

/** 데스크톱 가운데 칸이 원장 분할 화면에 넘기는 창구 — 구성원 레코드와 참여자 본문 슬롯. 폰은 주지 않는다. */
interface LedgerSplitPorts {
  readonly nestedObjectiveRecords: readonly ObjectiveRecord[];
  readonly renderParticipantBody: ConversationBodyContext["renderParticipantBody"];
}

/**
 * 루트 자리 — 「구성원」 탭에서 지휘관을 고르면 지휘관의 원장(루트의 기존 본문)이 먼저다. 아니면 데스크톱은 화면 전환 설정이 원장일 때
 * 원장 분할 화면, 그룹채팅일 때 그룹 대화다. 폰은 늘 그룹 대화다.
 * `links`·`split` 은 데스크톱 가운데 칸만 준다. 폰은 루트 Objective 본문 안에 서므로 그 본문의 채팅 링크 경계가 이미 감싼다.
 */
function RootBody({ root, language, phone = false, links, split, children }: { readonly root: ObjectiveRecord; readonly language: "en" | "ko"; readonly phone?: boolean; readonly links?: GroupLinkPorts; readonly split?: LedgerSplitPorts; readonly children: React.ReactNode }) {
  const commanderLedger = useCommanderLedgerChosen(root.id);
  const view = useGroupConversationView();
  if (commanderLedger) return <MemberLedger root={root} member={root} language={language}>{children}</MemberLedger>;
  // 분할 화면은 루트 본문을 칸으로 직접 세우므로 children(같은 id 의 기본 본문)은 그리지 않는다 — 본문 풀은 id 당 슬롯 하나다.
  if (!phone && split && view === "ledger") return <RootLedgerSplit root={root} language={language} ports={split} />;
  return links
    ? <GroupLinkBoundary root={root} language={language} ports={links}>{(fileLinkError) => <RootConversation root={root} language={language} phone={phone} fileLinkError={fileLinkError} />}</GroupLinkBoundary>
    : <RootConversation root={root} language={language} phone={phone} />;
}

/**
 * 원장 분할 화면 — 지휘관 1칸(첫 칸)과 Objective 레코드가 선 구성원 전원. 칸 머리의 표식·이름은 그룹 타임라인의 참여자를 쓰고,
 * 명부에 아직 없으면 레코드 제목으로 세운다. 레코드가 없는 명부 구성원(시작 전)은 칸이 없다.
 */
function RootLedgerSplit({ root, language, ports }: { readonly root: ObjectiveRecord; readonly language: "en" | "ko"; readonly ports: LedgerSplitPorts }) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root.id), language);
  const { nestedObjectiveRecords, renderParticipantBody } = ports;
  const panes = React.useMemo<readonly GroupLedgerSplitPane[]>(() => {
    const speakerOf = (id: string) => snapshot.participants.find((participant) => participant.speaker.objectiveId === id)?.speaker ?? null;
    const commander: GroupLedgerSplitPane = { objectiveRecord: root, speaker: speakerOf(root.id) ?? { kind: "commander", name: root.title, objectiveId: root.id } };
    const members = nestedObjectiveRecords.filter((record) => record.parentObjectiveId === root.id);
    // 구성원 칸은 참여자 순서(명부)를 따르고, 명부에 아직 없는 레코드는 뒤에 붙인다.
    const order = new Map(snapshot.participants.flatMap((participant, index) => (participant.speaker.objectiveId ? [[participant.speaker.objectiveId, index] as const] : [])));
    const sorted = [...members].sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    return [commander, ...sorted.map((record) => ({ objectiveRecord: record, speaker: speakerOf(record.id) ?? { kind: "member" as const, name: record.title, objectiveId: record.id } }))];
  }, [root, nestedObjectiveRecords, snapshot.participants]);
  return <GroupLedgerSplit panes={panes} language={language} renderParticipantBody={renderParticipantBody} />;
}

/**
 * 그룹 대화의 링크 경계 — 루트(지휘관) Objective 의 1:1 채팅과 같은 길(useObjectiveLinks)이다: 파일·좌표 링크 분류와 열기, 왼클릭의 3행 카드
 * (Objective 브라우저 행은 이 대화의 오른쪽 칸), 수정키·가운데 클릭의 직접 열기. 문서 링크 라우터는 이 영역을 건너뛴다(`self`).
 */
function GroupLinkBoundary({ root, language, ports, children }: {
  readonly root: ObjectiveRecord;
  readonly language: "en" | "ko";
  readonly ports: GroupLinkPorts;
  readonly children: (fileLinkError: string | null) => React.ReactNode;
}) {
  const { navigate, openObjectiveBrowser } = ports;
  const openCompanion = React.useCallback(() => openObjectiveBrowser?.(), [openObjectiveBrowser]);
  const links = useObjectiveLinks({ objectiveId: root.id, theaterId: root.theaterId, language, navigate, openCompanion });
  const t = getT(language);
  const fileLinkError = links.fileLinkFailure === null ? null : t(links.fileLinkFailure === "unsupported" ? "terminal.fileLink.unsupported" : "terminal.fileLink.failed");
  return (
    <MarkdownLinkBoundary className="group-chat-link-boundary" onClick={links.onLinkClick} onAuxClick={links.onLinkClick} fleetLink="self" openUIChoose={links.choose} {...links.fileLinks}>
      {children(fileLinkError)}
      {links.card}
    </MarkdownLinkBoundary>
  );
}

/** 플러그인이 소유한 검증·저장·전달 경로만 노출한다. */
function useGroupConversationActions(rootObjectiveId: string | null): GroupConversationActions | null {
  return useGroupClusters().find((cluster) => cluster.conversation?.objectiveId === rootObjectiveId)?.conversation?.actions ?? null;
}

/** 답변 좌표는 원 요청의 objectiveId다. 그룹 뿌리로 바꾸지 않는다. */
function useGroupUseRequests(rootObjectiveId: string | null): readonly ObjectiveUseRequest[] {
  const state = useConsoleState();
  const requests = useAllObjectiveUseRequests();
  return React.useMemo(() => {
    if (!rootObjectiveId) return [];
    const ids = new Set([rootObjectiveId, ...state.nestedObjectiveRecords.filter((objectiveRecord) => objectiveRecord.parentObjectiveId === rootObjectiveId).map((objectiveRecord) => objectiveRecord.id)]);
    return requests.filter((request) => ids.has(request.objectiveId));
  }, [rootObjectiveId, state.nestedObjectiveRecords, requests]);
}

function RootConversation({ root, language, phone = false, fileLinkError = null }: { readonly root: ObjectiveRecord; readonly language: "en" | "ko"; readonly phone?: boolean; readonly fileLinkError?: string | null }) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root.id), language);
  const actions = useGroupConversationActions(root.id);
  const useRequests = useGroupUseRequests(root.id);
  const openMemberLedger = React.useCallback((objectiveId: string) => openLedger(root.id, objectiveId), [root.id]);
  const openLedgerView = React.useCallback(() => setGroupConversationView("ledger"), []);
  const clusters = useGroupClusters();
  const openUIOpen = clusters.find((cluster) => cluster.conversation?.objectiveId === root.id)?.conversation?.openUIOpen;
  // 보드 동작이 있는 일반 Objective도 있다. 목표 플러그인이 명시한 기록 여부만 요약 슬롯의 근거다.
  const recordedObjective = clusters.some((cluster) => cluster.conversation?.objectiveId === root.id && cluster.conversation.recordedObjective === true);
  // 답이 받아들여진 요청은 보드가 요청을 걷기 전에도 카드를 내린다. 답은 보드가 결정으로 남긴 대화 줄로 그 시각 자리에 선다.
  const [answered, setAnswered] = React.useState<readonly string[]>([]);
  React.useEffect(() => setAnswered([]), [root.id]);
  const speakerOf = (objectiveId: string) => snapshot.participants.find((participant) => participant.speaker.objectiveId === objectiveId)?.speaker ?? null;
  // 지휘관과 구성원은 컴퓨터 하나를 함께 쓴다(호스트의 공유 컨텍스트) — 화면공유는 원장이 아니라 이 대화에 선다.
  const shared = useConsoleState().nestedObjectiveRecords.some((objectiveRecord) => objectiveRecord.parentObjectiveId === root.id);
  const t = getGroupT(language);
  const cliT = getCommodoreT(language);
  const commander = snapshot.participants.find((participant) => participant.speaker.kind === "commander")?.speaker ?? null;
  const decision = snapshot.decision && !answered.includes(snapshot.decision.id) ? snapshot.decision : null;
  const resendCliFailure = React.useCallback(() => {
    if (!actions || !snapshot.cliFailurePrompt) return;
    void actions.send({ kind: "commander" }, snapshot.cliFailurePrompt).catch(() => {});
  }, [actions, snapshot.cliFailurePrompt]);
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
      {useRequests.map((request) => <UseRequestGroupCard key={request.id} request={request} />)}
      <BrowserActivityLines objectiveId={root.id} />
      {snapshot.cliFailure ? (
        <CliFailureCard
          t={cliT}
          cause={snapshot.cliFailure}
          canResend={Boolean(actions && snapshot.cliFailurePrompt)}
          onResend={resendCliFailure}
        />
      ) : null}
      {fileLinkError !== null ? <div className="agent-chat-sys agent-chat-sys--error" role="alert">{fileLinkError}</div> : null}
    </>
  );
  // 답 단추(OpenUI)는 이 말의 화자에게 기존 대화 전송 계약으로 보낸다. 초안 단추는 보내지 않고 입력창에 채운다.
  const sendOpenUI = React.useCallback((text: string, speaker: ConversationSpeaker) => {
    void actions?.send({ kind: speaker.kind === "commodore" ? "commodore" : "commander" }, text).catch(() => {});
  }, [actions]);
  const draftOpenUI = React.useCallback((text: string) => {
    fillGroupComposerDraft(root.id, text);
  }, [root.id]);
  const composer = (
    <GroupComposer
      key={root.id}
      rootObjectiveId={root.id}
      snapshot={snapshot}
      actions={actions}
      language={language}
      topEntries={recordedObjective ? <ComposerTopEntries /> : null}
      renderControls={!phone ? clusters.find((cluster) => cluster.conversation?.objectiveId === root.id)?.conversation?.renderComposerControls : undefined}
      cliFailure={snapshot.cliFailure ?? null}
      onStopOne={stopOne}
    />
  );
  return (
    <OpenUINavigationContext.Provider value={openUIOpen ?? null}>
      <CommanderFlowConversation
        snapshot={snapshot}
        language={language}
        variant={phone ? "thread" : "canvas"}
        awaitingCheckpoint={Boolean(decision) || useRequests.length > 0}
        onOpenLedger={openMemberLedger}
        {...(phone ? {} : { onOpenSplitLedger: openLedgerView })}
        cards={cards}
        composer={composer}
        {...(actions ? { onOpenUISend: sendOpenUI, onOpenUIDraft: draftOpenUI } : {})}
        overlay={phone || !shared ? null : (
          <ComputerScreenShare
            objectiveId={root.id}
            className="is-group"
            actor={(id) => {
              const speaker = speakerOf(id);
              return speaker ? <span className="group-share-actor"><span className="group-share-actor-dot" aria-hidden="true" /><SpeakerMark speaker={speaker} size="sm" />{t("group.share.actor", { name: speaker.name })}</span> : null;
            }}
          />
        )}
      />
    </OpenUINavigationContext.Provider>
  );
}

/**
 * 아직 서지 않은(시작 전) 또는 보관된(완료한) 지휘관 자리의 입력창 — 플러그인 대화가 자리를 고르고, 입력창은 그 id 의 묶음 대화 계약으로
 * 같은 그룹 입력창이 선다. 일하는 참여자가 없으므로 정지는 서지 않는다.
 */
function StandInComposer({ rootId, language }: { readonly rootId: string; readonly language: "en" | "ko" }) {
  const dockRef = React.useRef<HTMLDivElement | null>(null);
  useConversationDockHeight(dockRef);
  const snapshot = useLocalizedSnapshot(useGroupTimeline(rootId), language);
  const actions = useGroupConversationActions(rootId);
  const conversation = useGroupClusters().find((cluster) => cluster.conversation?.objectiveId === rootId)?.conversation;
  return <div ref={dockRef} className="group-standin-dock">
    <GroupComposer rootObjectiveId={rootId} snapshot={snapshot} actions={actions} language={language} topEntries={conversation?.recordedObjective ? <ComposerTopEntries /> : null} renderControls={conversation?.renderComposerControls} onStopOne={stopOne} />
  </div>;
}

/** 한 명 정지 — 기존 실행 중 중지 경로(채팅 턴만 닫는다. 백그라운드 작업은 그대로). */
function stopOne(speaker: ConversationSpeaker): Promise<void> {
  return speaker.objectiveId ? stopAgentChatTurn(speaker.objectiveId) : Promise.resolve();
}

function MemberLedger({ root, member, language, children }: {
  readonly root: ObjectiveRecord;
  readonly member: ObjectiveRecord;
  readonly language: "en" | "ko";
  readonly children: React.ReactNode;
}) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(root.id), language);
  const commander = member.id === root.id;
  const speaker: ConversationSpeaker = snapshot.participants.find((participant) => participant.speaker.objectiveId === member.id)?.speaker
    ?? { kind: commander ? "commander" : "member", name: member.title, objectiveId: member.id };
  // 지휘관 본문은 평소 입력 틀을 가진 채팅이다 — 이 틀 안에 선 동안만 구성원 원장처럼 입력 틀을 뺀다(commander-ledger).
  React.useLayoutEffect(() => (commander ? frameCommanderLedger(root.id) : undefined), [commander, root.id]);
  // 컴퓨터는 목표가 함께 쓰고 그 화면은 대화에만 선다 — 원장을 보는 동안 공유 중이면 머리 아래 한 줄이 대화로 데려간다.
  const shared = useConsoleState().nestedObjectiveRecords.some((objectiveRecord) => objectiveRecord.parentObjectiveId === root.id);
  const actorId = useComputerActor(root.id);
  const actor = shared && actorId ? snapshot.participants.find((participant) => participant.speaker.objectiveId === actorId)?.speaker ?? null : null;
  const t = getGroupT(language);
  const notice = actor ? (
    <div className="group-ledger-share" role="status">
      <SpeakerMark speaker={actor} size="sm" />
      <span>{t("group.share.ledger", { name: actor.name })}</span>
      <button type="button" className="group-chat-link" onClick={() => openLedger(root.id, null)}>{t("group.share.ledgerOpen")}</button>
    </div>
  ) : null;
  return (
    <GroupLedgerFrame speaker={speaker} language={language} notice={notice} onBack={() => openLedger(root.id, null)}>
      {children}
    </GroupLedgerFrame>
  );
}
