import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { React } from "@fleet-console/sdk/plugin/browser";

import { AgentGlyph } from "../../agent-glyphs.js";
import { StreamedMarkdown } from "../../streamed-markdown.js";
import { pluginOriginIdentity } from "../origin-mark.js";
import { ChatDispatchAttachments } from "../chat-dispatch-attachments.js";
import { ChatReferenceText } from "../chat-reference.js";
import { useCodeBlockCopy } from "../code-block-copy.js";
import { getT } from "../../i18n/index.js";
import type { ConversationParticipant, ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot } from "@fleet-console/sdk/conversation";
import type { AgentConversationEntry } from "@fleet-console/sdk/components/agent-chat-transcript";
import { getGroupT } from "./group-chat-i18n.js";
import { ledgerTarget, LiveSpeakerMark, SpeakerMark, SpeakerName, speakerKey } from "./speaker-mark.js";
import "@fleet-console/markdown/styles.css";
import "../chat.css";
import "./group-chat.css";

/**
 * 그룹 대화 — 지휘관과 구성원의 원장을 한 줄기로 읽는 가운데 칸 본문(읽기 표면).
 *
 * 이 컴포넌트는 구독자일 뿐이다: 스냅숏은 실행 기능 전역 설치 수명의 집계(`useGroupTimeline`)가 주고, 여기서는 연결을
 * 열거나 닫지 않는다. 화면을 닫거나 다른 Operation 을 골라도 세션과 연결은 그대로다.
 *
 * 문법: 사람 말은 오른쪽 말풍선, 지휘관·구성원 말은 왼쪽 말풍선(표식·이름). 구성원끼리 주고받은 전언은 가운데 접힌 한
 * 줄로 두어 사람에게 한 말과 섞이지 않게 한다 — 펼치면 「보낸 메시지 → 수신자 / 본문 / 전달 결과」, 그 안의 「원장
 * 보기」는 이 자리에 그 참여자의 원장(기존 채팅 본문 전체)을 읽기 전용으로 세운다(`GroupLedgerFrame`). 원장은 걸러 낸
 * 요약이 아니다 — 고르는 일은 셸의 구성원 본문 선택이 지고, 이 컴포넌트는 그 문을 콜백으로 받는다.
 * 사람·사령관의 말 없이 플러그인이 혼자 보낸 지시(구성원 실패 알림 등)는 발화자가 아니라 출처이므로 같은 가운데 접힌 줄로
 * 선다 — 「목표 → 지휘관 발췌」, 펼치면 전문. 사람·사령관이 보드 행위에 덧붙인 말은 그 쪽의 말풍선에 「개시하며」 같은 행위를 단다.
 * 진행 줄은 일하는 참여자를 모두 쌓아 보인다.
 *
 * 쓰기(정지·사령관 기록 열기·원장 열기)는 콜백 자리만 둔다. 콜백이 없으면 그 단추도 서지 않는다 — 눌리는 척하지 않는다.
 *
 * 플러그인 대화(SDK `ctx.chat.Conversation`, 사령관 기록)도 이 화면이다 — 그 대화만 쓰는 노트 줄·이전 쪽 읽기·드러내기는 선택 prop 이라
 * 그룹 대화에서는 서지 않는다.
 */
/** 그룹 스냅숏에 플러그인 대화의 노트 줄을 더한 모양 — 그룹 대화의 스냅숏도 그대로 들어온다. */
export type ConversationLogSnapshot = Omit<GroupTimelineSnapshot, "entries"> & { readonly entries: readonly AgentConversationEntry[] };

export interface GroupConversationProps {
  readonly snapshot: ConversationLogSnapshot;
  readonly language: ConsoleLocale | undefined;
  /** 한 참여자의 원장을 이 자리에 연다 — 셸의 구성원 본문 선택으로 연결한다. */
  readonly onOpenLedger?: (operationId: string) => void;
  /**
   * 사령관 행위 줄에서 그 행위의 기록을 연다 — 임무 14 계약(`useOpenBoardActionRecord()` 가 돌려주는 함수)과 같은 모양이다.
   * 기록이 없는 줄이면 여는 쪽이 아무 일도 하지 않으므로 단추는 늘 둔다.
   */
  readonly onOpenCommodoreRecord?: (request: BoardActionRecordRequest) => void;
  /** 대화 끝에 서는 카드(결정 요청·허용 요청과 답한 결정 줄). 원장 흐름 맨 아래, 진행 줄 위다. */
  readonly cards?: React.ReactNode;
  /** 진행 줄 아래의 입력창. */
  readonly composer?: React.ReactNode;
  /** 사령관 행위 줄의 링크 낱말 — 주지 않으면 「사령관 기록에서 보기」. */
  readonly boardActionLabel?: string;
  /** 빈 대화의 문구 — 주지 않으면 그룹 대화의 문구. */
  readonly empty?: string;
  /** 첫 줄 위에 이전 기록이 있다 — 칼럼 맨 위 글자 단추가 읽는다. 앞에 붙어도 보던 자리를 지킨다. */
  readonly older?: { readonly label: string; readonly loading: boolean; readonly load: () => void } | null;
  /** 이 줄을 보이는 자리로 데려와 잠깐 표시한다. 같은 줄을 다시 부르면 nonce 가 오른다. */
  readonly reveal?: { readonly entryId: string; readonly nonce: number } | null;
  /**
   * 턴 접기(「턴 접기」 스위치) — 구성원 턴에서 이어지는 짧은 진행 말을 진행 칩 하나로 접고, 구성원 말풍선에 높이 상한을 두고,
   * 말풍선과 겹치는 구성원 보고 줄을 그 말풍선 머리의 꼬리표로 옮긴다. 지휘관 말은 접지 않고 상한도 두지 않는다.
   * 주지 않으면 지금까지의 모양 그대로다(플러그인 대화).
   */
  readonly fold?: boolean;
  /** 대화 칸 위에 떠 있는 것(공유 화면 미리보기). 이 칸(`.group-chat`)이 배치의 부모다. */
  readonly overlay?: React.ReactNode;
  /** 컴퓨터를 지금 조작하는 참여자 — 진행 줄의 그 사람 뒤에 「· 컴퓨터 사용」 꼬리가 붙는다. */
  readonly computerActor?: string | null;
}

/** 사령관 기록을 그 행위의 자리로 여는 요청 — 임무 14의 `BoardActionRecordRequest` 와 같은 필드. */
export interface BoardActionRecordRequest {
  readonly objectiveId: string;
  readonly entryId: string;
  readonly at: number | null;
}

/** 사람의 스크롤 입력 뒤 그 scroll 사건을 사람의 뜻으로 읽는 창 — 입력과 그 scroll 사건 사이의 한두 프레임을 덮는다. */
const USER_SCROLL_MS = 250;
/** 기록을 움직이는 키 — 그 밖의 키 입력은 스크롤 의도가 아니다. */
const SCROLL_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function GroupConversation({ snapshot, language, onOpenLedger, onOpenCommodoreRecord, cards, composer, boardActionLabel, empty, older, reveal, fold = false, overlay, computerActor = null }: GroupConversationProps) {
  const t = getGroupT(language);
  const { onClick: onCodeCopyClick, announcement: codeCopyAnnouncement } = useCodeBlockCopy(getT(language));
  const entries = snapshot.entries;
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const nearBottomRef = React.useRef(true);
  const programmaticTop = React.useRef<number | null>(null);
  // 사람이 이 기록을 스크롤한 마지막 입력 시각 — 그 직후의 scroll 사건은 사람의 뜻으로 읽는다.
  const userScrollAt = React.useRef(-Infinity);
  const markUserScroll = React.useCallback(() => { userScrollAt.current = performance.now(); }, []);
  const last = entries[entries.length - 1];
  const first = entries[0]?.id;
  const growth = `${entries.length}:${first ?? ""}:${last?.id ?? ""}:${snapshot.decision?.id ?? ""}:${snapshot.holds.map((hold) => hold.id).join(",")}`;
  const placed = React.useRef<{ readonly first: string | undefined; readonly height: number } | null>(null);

  // 이전 쪽이 앞에 붙는 경우에만 커밋에서 높이를 읽어 보던 줄을 지킨다. 글자 조각은 이 경로를 돌리지 않는다.
  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const before = placed.current;
    let height = before?.height ?? 0;
    if (before?.first !== undefined && before.first !== first && entries.some((entry) => entry.id === before.first)) {
      height = log.scrollHeight;
      if (!nearBottomRef.current) {
        log.scrollTop += height - before.height;
        programmaticTop.current = log.scrollTop;
      }
    }
    placed.current = { first, height };
  }, [first]); // eslint-disable-line react-hooks/exhaustive-deps -- 첫 좌표 변화만 이전 쪽의 삽입일 수 있다.

  // 초기 배치·흐르는 말·늦은 마크다운·결정 카드 모두 레이아웃 완료 뒤 한 통지에서 따라간다.
  React.useEffect(() => {
    const log = logRef.current;
    const column = log?.firstElementChild;
    if (!log || !column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // 산 채로 숨긴 대화의 배치는 읽기 위치나 따라가기 의도를 바꾸지 않는다.
      if (log.closest("[inert]") || log.clientHeight === 0) return;
      const height = log.scrollHeight;
      placed.current = { first: placed.current?.first, height };
      if (nearBottomRef.current) {
        log.scrollTop = height;
        programmaticTop.current = log.scrollTop;
      }
    });
    observer.observe(column);
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  // 드러내기 — 그 줄이 아직 없으면(쪽을 읽는 중) 줄이 올 때 다시 찾는다. 찾은 요청만 끝낸다.
  const revealed = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!reveal || revealed.current === reveal.nonce) return;
    const target = Array.from(logRef.current?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? []).find((node) => node.dataset.entryId === reveal.entryId);
    if (!target) return;
    revealed.current = reveal.nonce;
    nearBottomRef.current = false;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("is-revealed");
    void target.offsetWidth;
    target.classList.add("is-revealed");
    const timer = window.setTimeout(() => target.classList.remove("is-revealed"), 1_600);
    return () => window.clearTimeout(timer);
  }, [reveal, growth]);

  // 화면에 서는 줄 — 턴 접기를 켜면 접힌 말은 칩 하나로, 말풍선에 옮긴 보고 줄은 빠진다. 끄면 원장 줄 그대로다.
  const items = React.useMemo(() => fold ? foldTimeline(entries, snapshot.participants, snapshot.rootOperationId) : entries.map((entry): TimelineItem => ({ kind: "entry", entry })), [entries, fold, snapshot.participants, snapshot.rootOperationId]);
  // 칩은 말풍선 묶음을 끊는 자리(null)다. 시각 줄은 칩도 그 자리의 첫 말로 센다.
  const flow = React.useMemo(() => items.map((item) => item.kind === "entry" ? item.entry : null), [items]);
  const anchors = React.useMemo(() => items.map((item) => item.kind === "entry" ? item.entry : item.anchor), [items]);
  // 발화자마다 가장 최근 말풍선 묶음의 꼬리 — 그 표식만 발화자의 지금 상태를 보인다(지난 묶음은 쉼).
  const liveTails = React.useMemo(() => latestBubbleTails(flow), [flow]);
  // 가운데 시각 줄은 대화가 쉬었다 다시 이어지는 자리에 선다. 묶음의 표식은 마지막 말풍선 옆에 선다(이름은 첫 말풍선 위) —
  // 시각 줄은 같은 발화자의 말도 두 묶음으로 가른다.
  const breaks = React.useMemo(() => timeBreaks(anchors), [anchors]);
  const runTails = React.useMemo(() => bubbleRunTails(flow, breaks), [flow, breaks]);
  // 상대가 하나뿐이면(사령관 채팅, 구성원 없는 지휘관) 말풍선 옆 아바타를 두지 않는다. 구성원이 명부에 서면 다시 붙는다.
  const showMark = showsSpeakerMarks(snapshot.participants);
  const now = Date.now();

  const unavailableNames = snapshot.unavailableOperationIds
    .map((id) => findSpeaker(snapshot, id)?.name)
    .filter((name): name is string => typeof name === "string");

  return (
    <div className="group-chat" onClick={onCodeCopyClick}>
      <span className="agent-chat-sr-only" aria-live="polite" aria-atomic="true">{codeCopyAnnouncement}</span>
      <div
        ref={logRef}
        className="group-chat-log"
        role="log"
        aria-label={t("group.aria.log")}
        aria-busy={snapshot.loading}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        onKeyDown={(event) => { if (SCROLL_KEYS.has(event.key)) markUserScroll(); }}
        onScroll={(event) => {
          const log = event.currentTarget;
          if (log.closest("[inert]") || log.clientHeight === 0) return;
          // 우리가 바닥으로 옮긴 scroll 사건은 읽기 의도가 아니다. 다음 조각이 먼저 자라도 따라가기를 끊지 않는다.
          if (log.scrollTop === programmaticTop.current) return;
          programmaticTop.current = null;
          // 따라가는 중이면 판정 높이는 지금 높이와 마지막 RO 높이 중 작은 쪽이다. 복귀·폭 전이로 줄면 브라우저가 먼저 scrollTop을
          // 제한하므로 지금 높이로 재고(RO 전의 cached 높이는 위로 읽기로 오인한다), 원장 재생처럼 clamp·anchoring 사건이 닿기 전에
          // 칼럼이 먼저 자라면 RO 전 높이로 잰다(그 성장을 사람이 위로 올린 것으로 오인하지 않는다 — 다음 RO 가 따라간다).
          // 위로 올려 읽는 중이거나 사람의 스크롤 입력 직후이면 지금 높이로만 잰다 — 보이는 줄 위가 자라 anchoring 이 올린 scrollTop 을
          // 짧은 cached 높이와 견주면 바닥에 닿은 것으로 오인해, 읽거나 위로 올리던 사람을 바닥으로 끌어내린다.
          const cached = placed.current?.height;
          const gesture = performance.now() - userScrollAt.current < USER_SCROLL_MS;
          const height = cached && nearBottomRef.current && !gesture ? Math.min(log.scrollHeight, cached) : log.scrollHeight;
          nearBottomRef.current = height - log.scrollTop - log.clientHeight < 60;
        }}
      >
        <div className="group-chat-column">
          {older ? (
            <button type="button" className="group-chat-link group-chat-older" disabled={older.loading} onClick={older.load}>{older.label}</button>
          ) : null}
          {snapshot.truncated ? <p className="group-chat-notice">{t("group.truncated")}</p> : null}
          {snapshot.unavailableOperationIds.length > 0 ? (
            <p className="group-chat-notice">
              {unavailableNames.length > 0 ? t("group.unavailable", { names: unavailableNames.join(", ") }) : t("group.unavailableOne")}
            </p>
          ) : null}
          {entries.length === 0 ? (
            <p className="group-chat-empty">{snapshot.loading ? t("group.loading") : empty ?? t("group.empty")}</p>
          ) : items.map((item, index) => {
            const anchor = anchors[index]!;
            const time = breaks.has(anchor.id) && anchor.at !== null ? <div className="group-chat-time">{breakLabel(anchor.at, now, language)}</div> : null;
            if (item.kind === "notes") {
              return (
                <React.Fragment key={item.id}>
                  {time}
                  <TurnNotes item={item} participants={snapshot.participants} language={language} onOpenLedger={onOpenLedger} />
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={item.entry.id}>
                {time}
                <TimelineEntry
                  entry={item.entry}
                  previous={flow[index - 1] ?? undefined}
                  breakBefore={breaks.has(item.entry.id)}
                  tail={runTails.has(item.entry.id)}
                  live={liveTails.has(item.entry.id)}
                  participants={snapshot.participants}
                  language={language}
                  onOpenLedger={onOpenLedger}
                  onOpenCommodoreRecord={onOpenCommodoreRecord}
                  boardActionLabel={boardActionLabel}
                  capped={fold}
                  report={item.report}
                  showMark={showMark}
                />
              </React.Fragment>
            );
          })}
          {cards}
        </div>
      </div>
      <GroupWorkingLine working={snapshot.working} participants={snapshot.participants} language={language} onOpenLedger={onOpenLedger} computerActor={computerActor} />
      {composer}
      {overlay}
    </div>
  );
}

/**
 * 한 참여자의 원장을 그룹 대화 자리에 세우는 틀 — 위에 「읽기 전용」 머리, 가운데 그 Operation 의 기존 본문(셸이 주는
 * 기본 본문: 채팅이면 도구 스텝까지 담은 구성원 원장, 터미널이면 터미널). 대화로 돌아가는 길은 머리 끝의 「대화로 돌아가기」다 —
 * 원장은 말풍선 머리에서도 열리고 오른쪽 「구성원」 탭은 닫혀 있거나 다른 탭일 수 있으므로, 돌아갈 단서를 틀 안에 둔다.
 * 「구성원」 탭에서 보고 있는 줄을 다시 누르는 길도 그대로 남는다. 콜백이 없으면 그 링크는 서지 않는다.
 * 본문은 셸의 기존 구성원 본문 경로가 그리므로 이 틀은 연결을 만들지 않는다. 사람 입력창은 서지 않는다 — 구성원 본문에는
 * 처음부터 입력 틀이 없다.
 */
export function GroupLedgerFrame({ speaker, language, onBack, notice, children }: {
  readonly speaker: ConversationSpeaker;
  readonly language: ConsoleLocale | undefined;
  /** 원장을 닫고 그룹 대화로 돌아간다. */
  readonly onBack?: () => void;
  /** 머리 아래 한 줄 — 공유 화면처럼 이 원장에 서지 않고 대화에 서는 것을 알리고 그리로 데려간다. */
  readonly notice?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const t = getGroupT(language);
  return (
    <div className="group-ledger">
      <div className="group-ledger-head">
        <SpeakerMark speaker={speaker} size="sm" />
        <span className="group-ledger-banner" role="status">{t("group.ledger.banner", { name: speaker.name })}</span>
        {onBack ? <button type="button" className="group-ledger-back" onClick={onBack}>{t("group.ledger.back")}</button> : null}
      </div>
      {notice}
      <div className="group-ledger-body">{children}</div>
    </div>
  );
}

function findSpeaker(snapshot: ConversationLogSnapshot, operationId: string): ConversationSpeaker | null {
  return snapshot.participants.find((participant) => participant.speaker.operationId === operationId)?.speaker ?? null;
}

function sameSpeaker(entry: AgentConversationEntry | undefined, speaker: ConversationSpeaker): boolean {
  return entry?.kind === "message" && speakerKey(entry.speaker) === speakerKey(speaker);
}

/** 말풍선이 서는 말인가 — 문면이 없는 말은 흐르는 중일 때만 「쓰는 중」으로 선다(`MessageBubble` 과 같은 규칙). */
const bubbleShown = (entry: Extract<GroupTimelineEntry, { kind: "message" }>): boolean =>
  entry.streaming || entry.text.trim().length > 0 || !!entry.attachments?.length;

/**
 * 사람이 아닌 발화자마다 가장 최근 말풍선 묶음의 꼬리 말 id. 묶음은 같은 발화자의 이어진 말이고 꼬리는 그 마지막으로 서는 말(표식이
 * 서는 자리)이다. 흐르는 중인 응답이 있으면 그 말이 꼬리다. 서는 말이 하나도 없는 묶음은 최신으로 치지 않는다.
 */
function latestBubbleTails(entries: readonly (AgentConversationEntry | null)[]): ReadonlySet<string> {
  const latest = new Map<string, string>();
  for (const entry of entries) {
    if (entry?.kind === "message" && entry.speaker.kind !== "human" && bubbleShown(entry)) latest.set(speakerKey(entry.speaker), entry.id);
  }
  return new Set(latest.values());
}

/**
 * 묶음마다 마지막으로 서는 말의 id — 표식이 그 말풍선 옆(묶음 왼쪽 아래)에 선다. 이름은 여전히 묶음 첫 말 위에 선다.
 * 시각 줄이 선 말은 같은 발화자여도 새 묶음을 연다. 문면 없는 말은 말풍선이 서지 않으므로 꼬리로 치지 않는다. 턴 접기의 칩(null)은
 * 묶음을 끊는다 — 칩은 자기 표식을 단다.
 */
function bubbleRunTails(entries: readonly (AgentConversationEntry | null)[], breaks: ReadonlySet<string>): ReadonlySet<string> {
  const tails = new Set<string>();
  let tail: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind !== "message" || entry.speaker.kind === "human") { if (tail) tails.add(tail); tail = null; continue; }
    if (!sameSpeaker(entries[index - 1] ?? undefined, entry.speaker) || breaks.has(entry.id)) { if (tail) tails.add(tail); tail = null; }
    if (bubbleShown(entry)) tail = entry.id;
  }
  if (tail) tails.add(tail);
  return tails;
}

type MessageEntry = Extract<GroupTimelineEntry, { kind: "message" }>;
type DelegationEntry = Extract<GroupTimelineEntry, { kind: "delegation" }>;
/**
 * 화면의 한 줄 — 원장 줄 하나, 또는 턴 접기의 진행 칩 하나. `report` 는 그 말풍선 머리로 옮긴 구성원 보고 줄이다.
 * 칩은 줄이 아니므로 앞뒤 말풍선의 이어짐(머리 생략)을 끊는다.
 */
type TimelineItem =
  | { readonly kind: "entry"; readonly entry: AgentConversationEntry; readonly report?: DelegationEntry }
  | { readonly kind: "notes"; readonly id: string; readonly speaker: ConversationSpeaker; readonly notes: readonly MessageEntry[]; readonly writing: MessageEntry | null; readonly anchor: MessageEntry };

/** 이 길이보다 짧은 진행 말은 턴 접기에서 칩으로 접힌다(시안 B 기준). 턴의 마지막 말은 길이와 무관하게 말풍선으로 선다. */
const NOTE_MAX_CHARS = 200;

/**
 * 턴 접기 — 1:1 채팅·모바일 원장의 「최종 답 하나 + 작업 접힘」 문법을 구성원 턴에 옮긴다. 지휘관 말은 대상이 아니다.
 *
 * - 구성원 한 명의 한 턴(`turn`)에서 뒤에 말이 더 이어지는 200자 미만의 말은 칩 하나로 모인다. 칩은 그 턴의 가장 최근 접힌 말(흐르는
 *   말이 있으면 그 말) 자리에 서서 진행을 따라 내려온다 — 오래 도는 턴에서도 지금 진행이 대화 바닥 근처에 보인다. 그 사이에 완성된
 *   200자 이상의 말풍선은 제자리에 남아 칩 위로 쌓인다. 턴이 끝나면 칩은 마지막 접힌 말 자리, 곧 그 턴의 답 바로 위에 남는다
 *   (「접힌 진행 → 최종 답」). 턴이 아직 열려 있으면(원장이 연 턴이 이 턴이고 그 참여자가 살아 있다) 마지막 말도
 *   아직 진행 말이다 — 턴이 끝나야 마지막 말이 그 턴의 답으로 말풍선이 된다. 열린 턴은 원장의 좌표로 판정하므로, 같은 발화자가
 *   새 턴을 열고 아직 말이 없는 동안에도 지난 턴의 답은 말풍선으로 남는다.
 * - 접을지는 말이 완성될 때 한 번 정한다. 흐르는 중인 구성원 말은 길이와 무관하게 칩의 최신 한 줄로만 보인다 —
 *   완성되어 200자 이상이면 그때 그 자리에 말풍선으로 선다. 흐르는 동안 칩과 말풍선을 오가지 않는다.
 *   흐르는 중인 지휘관 말은 칩이 아니라 말풍선으로 선다(접기를 껐을 때와 같다).
 * - 구성원이 지휘관에게 보낸 보고 줄은 같은 턴에 말풍선이 있으면 빠지고, 그 턴의 마지막 말풍선 머리에 꼬리표로 붙는다(누르면
 *   보고 전문). 그 턴이 아직 열려 있거나 흐르는 말이 있으면 말풍선이 정해지지 않았으므로 줄을 세우지 않는다 — 턴이 끝나도 말풍선이
 *   없으면 그때 줄로 선다. 받는 이가 아직 풀리지 않은 구성원의 전언(도구 결과 전)도 열린 턴 동안은 같은 이유로 기다린다.
 *   전달에 실패한 줄은 늘 남는다.
 * 턴 좌표가 없는 말(사람·사령관·플러그인 대화의 말), 지휘관의 말, 그 밖의 줄은 그대로다. 지휘관은 턴이 있어도 칩으로 접지 않는다.
 */
function foldTimeline(entries: readonly AgentConversationEntry[], participants: readonly ConversationParticipant[], rootOperationId: string | null): readonly TimelineItem[] {
  const turns = new Map<string, MessageEntry[]>();
  for (const entry of entries) {
    // 사람·지휘관은 접지 않는다. 지휘관은 턴이 있어도, 흐르는 중에도 말풍선으로 남긴다.
    if (entry.kind !== "message" || entry.speaker.kind === "human" || entry.speaker.kind === "commander" || !entry.turn || !bubbleShown(entry)) continue;
    const list = turns.get(entry.turn);
    if (list) list.push(entry); else turns.set(entry.turn, [entry]);
  }
  // 지금 열린 턴 — 원장이 연 턴이고 그 참여자가 살아 있다(휴면 기록이 턴 중간에서 끝났어도 닫힌 것으로 읽는다).
  const openTurns = new Set(participants.flatMap(({ turn, activity }) => turn && activity !== "ended" && activity !== "unknown" ? [turn] : []));
  const folded = new Set<string>();
  const writing = new Map<string, MessageEntry>();
  const answers = new Map<string, string>();
  for (const [turn, list] of turns) {
    const settled = list.filter((entry) => !entry.streaming);
    const last = settled[settled.length - 1];
    const open = openTurns.has(turn) || settled.length < list.length;
    for (const entry of list) {
      if (entry.streaming) writing.set(turn, entry);
      else if (entry.text.length < NOTE_MAX_CHARS && (open || entry !== last)) folded.add(entry.id);
    }
    const bubbles = settled.filter((entry) => !folded.has(entry.id));
    if (bubbles.length > 0) answers.set(turn, bubbles[bubbles.length - 1]!.id);
  }
  // 말풍선으로 옮길 보고 줄 — 받는 이가 모두 지휘관(목표가 아닌 묶음이면 루트)인 구성원의 전언이다.
  const toLead = (recipient: ConversationSpeaker) => recipient.kind === "commander" || (rootOperationId !== null && recipient.operationId === rootOperationId);
  const reports = new Map<string, DelegationEntry>();
  const moved = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "delegation" || entry.sender.kind !== "member" || !entry.turn || deliveryFailure(entry) !== null) continue;
    const pending = openTurns.has(entry.turn) || writing.has(entry.turn);
    // 도구 결과가 오기 전 받는 이는 이름 힌트뿐이다(Operation 미확정). 지휘관 보고인지 모르는 동안은 열린 턴이면 기다린다 —
    // 풀린 뒤 지휘관이 아니면 줄로 서고, 턴이 끝나도 풀리지 않으면 정보가 사라지지 않게 줄로 선다.
    if (entry.recipients.length === 0 || entry.recipients.some((recipient) => !recipient.operationId && recipient.kind !== "commander")) {
      if (pending) moved.add(entry.id);
      continue;
    }
    if (!entry.recipients.every(toLead)) continue;
    const answer = answers.get(entry.turn);
    if (answer && !reports.has(answer)) { reports.set(answer, entry); moved.add(entry.id); continue; }
    // 그 턴의 말풍선이 아직 정해지지 않았다 — 섰다가 꼬리표로 옮겨 가지 않도록 기다린다.
    if (!answer && pending) moved.add(entry.id);
  }
  // 칩이 설 자리 — 턴마다 칩에 드는 말(접힌 말·흐르는 말) 가운데 원장에서 가장 뒤의 말이다.
  const inChip = (entry: AgentConversationEntry): entry is MessageEntry =>
    entry.kind === "message" && !!entry.turn && (folded.has(entry.id) || writing.get(entry.turn) === entry);
  const chipAt = new Map<string, string>();
  for (const entry of entries) if (inChip(entry)) chipAt.set(entry.turn!, entry.id);
  const items: TimelineItem[] = [];
  for (const entry of entries) {
    if (moved.has(entry.id)) continue;
    if (inChip(entry) && entry.turn) {
      if (chipAt.get(entry.turn) !== entry.id) continue;
      items.push({ kind: "notes", id: `notes:${entry.turn}`, speaker: entry.speaker, notes: turns.get(entry.turn)!.filter((note) => folded.has(note.id)), writing: writing.get(entry.turn) ?? null, anchor: entry });
      continue;
    }
    const report = reports.get(entry.id);
    items.push(report ? { kind: "entry", entry, report } : { kind: "entry", entry });
  }
  return items;
}

/**
 * 진행 칩 — 발화자 이름과 최신 말의 마지막 줄. 누르면 그 자리에서 전부 펼친다. 흐르는 중이면 그 말이 최신이고 그동안 점이 숨
 * 쉰다(접힌 말이 아직 없으면 이름 뒤에 「쓰는 중」). 개수는 화면 글자에 두지 않는다 — 접근성 이름과 툴팁만 진행 말 개수를 말한다.
 * 칩이 그 턴의 유일한 자취일 수 있으므로(아직 도는 턴) 펼친 칸에 그 발화자의 원장 링크를 둔다 — 머리의 원장 열기와 같은 길이다.
 */
function TurnNotes({ item, participants, language, onOpenLedger }: {
  readonly item: Extract<TimelineItem, { kind: "notes" }>;
  readonly participants: GroupTimelineSnapshot["participants"];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger: GroupConversationProps["onOpenLedger"];
}) {
  const t = getGroupT(language);
  const [open, setOpen] = React.useState(false);
  const detailId = React.useId();
  const latest = item.writing ?? item.notes[item.notes.length - 1];
  const live = item.writing !== null;
  const speaker = item.speaker.kind === "commodore" ? { ...item.speaker, name: t("group.commodore") } : item.speaker;
  const ledger = onOpenLedger ? ledgerTarget(speaker, participants) : null;
  const preview = latest ? tailExcerpt(latest.text, 80) : "";
  const shown = item.writing ? [...item.notes, item.writing] : item.notes;
  const count = shown.length;
  return (
    <div className="group-chat-notes" data-entry-id={item.id}>
      <button
        type="button"
        className={`group-chat-notes-chip${live ? " is-live" : ""}`}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        aria-label={t(open ? "group.notes.collapse" : "group.notes.expand", { name: speaker.name, count })}
        title={t("group.notes.count", { count })}
        onClick={() => setOpen((current) => !current)}
      >
        <SpeakerMark speaker={speaker} size="sm" />
        <span className="group-chat-notes-count"><SpeakerName speaker={speaker} />{item.notes.length > 0 ? null : <><span className="group-chat-line-sep" aria-hidden="true">·</span>{t("group.streaming")}</>}</span>
        {preview ? <TailExcerpt text={preview} /> : null}
        <span className="group-chat-line-chev" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="group-chat-notes-list" id={detailId}>
          {shown.map((note) => (
            <div key={note.id} className="group-chat-notes-item">
              {note.text.trim().length === 0
                ? <span className="agent-chat-live-text">{t("group.streaming")}</span>
                : <StreamedMarkdown text={note.text} streaming={note.streaming} className="group-chat-md markdown-body" language={language} />}
            </div>
          ))}
          {ledger ? (
            <div className="group-chat-line-actions">
              <button type="button" className="group-chat-link" onClick={() => onOpenLedger!(ledger)}>{t("group.delegation.openLedger", { name: speaker.name })}</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 진행 칩의 꼬리 줄 — 칩이 좁아도 줄의 끝(지금 쓰는 자리)이 보이도록 오른쪽 끝에 붙여 앞쪽을 자른다. 글자 순서와 방향은 그대로다
 * (자르기는 배치로만 한다). 잘렸을 때만 앞 가장자리를 흐려 앞이 더 있음을 보인다 — 글이 자라거나 칩 폭이 바뀌면 다시 잰다.
 */
function TailExcerpt({ text }: { readonly text: string }) {
  const boxRef = React.useRef<HTMLSpanElement | null>(null);
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [clipped, setClipped] = React.useState(false);
  React.useLayoutEffect(() => {
    const box = boxRef.current;
    const line = textRef.current;
    if (!box || !line) return;
    // 소수 폭의 반올림 차이로 잘림을 오인하지 않게 반 픽셀 여유를 둔다.
    const measure = () => setClipped(line.getBoundingClientRect().width - box.getBoundingClientRect().width > 0.5);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(line);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={boxRef} className="group-chat-notes-excerpt" data-clipped={clipped || undefined}>
      <span ref={textRef} className="group-chat-notes-excerpt-text">{text}</span>
    </span>
  );
}

/** 대화가 이만큼 쉬었다 이어지면 가운데 시각 줄이 선다. */
const TIME_BREAK_GAP_MS = 5 * 60_000;
const dayOf = (at: number): string => new Date(at).toDateString();

/**
 * 가운데 시각 줄이 설 말의 id — 서는 첫 말, 앞의 기록과 5분 넘게 떨어진 말, 날이 바뀐 말. 시각을 스스로 다는 줄(위임·참여 등)과
 * 화면에 서지 않는 기록(개시 알림 등)은 줄 대신 간격의 기준으로만 센다. 서지 않는 말에는 세우지 않는다.
 */
function timeBreaks(entries: readonly AgentConversationEntry[]): ReadonlySet<string> {
  const breaks = new Set<string>();
  let last: number | null = null;
  let firstShown = true;
  for (const entry of entries) {
    if (entry.at === null) continue;
    const shown = entry.kind === "message" && bubbleShown(entry);
    if (shown && (firstShown || last === null || entry.at - last > TIME_BREAK_GAP_MS || dayOf(entry.at) !== dayOf(last))) breaks.add(entry.id);
    if (shown) firstShown = false;
    last = entry.at;
  }
  return breaks;
}

const TIME_FORMATS = {
  en: new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }),
  ko: new Intl.DateTimeFormat("ko", { hour: "2-digit", minute: "2-digit" }),
};
const DATE_FORMATS = {
  en: new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }),
  ko: new Intl.DateTimeFormat("ko", { month: "long", day: "numeric" }),
};
const timeOf = (at: number | null, language: ConsoleLocale | undefined): string | undefined =>
  at === null ? undefined : TIME_FORMATS[language ?? "en"].format(new Date(at));

/** 시각 줄의 문구 — 오늘은 시각만, 어제는 「어제」를 앞에, 그 전은 날짜를 앞에 둔다. */
function breakLabel(at: number, now: number, language: ConsoleLocale | undefined): string {
  const time = timeOf(at, language)!;
  if (dayOf(at) === dayOf(now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const t = getGroupT(language);
  if (dayOf(at) === yesterday.toDateString()) return t("group.time.yesterday", { time });
  return t("group.time.dated", { date: DATE_FORMATS[language ?? "en"].format(new Date(at)), time });
}

/** 줄마다 마크다운 표식을 걷은 글자 줄 — 빈 줄은 뺀다. */
const plainLines = (text: string): string[] =>
  text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:>\s?|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").replace(/\*\*|[*`]/g, "").trim()).filter((line) => line.length > 0);

/** 본문 첫 줄 조각 — 접힌 줄에 선다. 마크다운 표식은 걷는다. */
function excerpt(text: string, max = 120): string {
  const first = plainLines(text)[0] ?? "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/** 본문 마지막 줄의 끝 조각 — 진행 칩에 선다. 흐르는 말이면 지금 쓰는 줄이고, 길면 앞을 줄여 끝을 보인다. */
function tailExcerpt(text: string, max: number): string {
  const lines = plainLines(text);
  const last = lines[lines.length - 1] ?? "";
  return last.length > max ? `…${last.slice(-max)}` : last;
}

const TimelineEntry = React.memo(function TimelineEntry({ entry, previous, breakBefore, tail, live, participants, language, onOpenLedger, onOpenCommodoreRecord, boardActionLabel, capped = false, report, showMark = true }: {
  readonly entry: AgentConversationEntry;
  readonly previous: AgentConversationEntry | undefined;
  /** 이 말 앞에 가운데 시각 줄이 선다 — 같은 발화자의 이어진 말이어도 새 묶음의 머리다. */
  readonly breakBefore: boolean;
  readonly tail: boolean;
  readonly live: boolean;
  readonly participants: GroupTimelineSnapshot["participants"];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger: GroupConversationProps["onOpenLedger"];
  readonly onOpenCommodoreRecord: GroupConversationProps["onOpenCommodoreRecord"];
  readonly boardActionLabel: string | undefined;
  readonly capped?: boolean;
  readonly report?: DelegationEntry | undefined;
  /** 말풍선 옆 아바타. 상대가 하나뿐인 대화에서는 끄고, 그 칸은 말풍선이 쓴다. */
  readonly showMark?: boolean;
}) {
  switch (entry.kind) {
    case "message": return <MessageBubble entry={entry} continued={sameSpeaker(previous, entry.speaker) && !breakBefore} tail={tail} live={live} participants={participants} language={language} onOpenLedger={onOpenLedger} capped={capped} report={report} showMark={showMark} />;
    case "delegation": return <DelegationLine entry={entry} language={language} onOpenLedger={onOpenLedger} />;
    case "member-joined":
    case "member-left": return <MembershipLine entry={entry} language={language} />;
    case "board-action": return <BoardActionLine entry={entry} language={language} onOpenRecord={onOpenCommodoreRecord} label={boardActionLabel} />;
    case "decision-answer": return <DecisionAnswerLine entry={entry} asker={participants.find((participant) => participant.speaker.kind === "commander")?.speaker ?? null} language={language} />;
    case "plugin-notice": return <PluginNoticeLine entry={entry} language={language} onOpenLedger={onOpenLedger} />;
    case "note": return <NoteLine entry={entry} language={language} />;
  }
}, (before, after) => {
  if (before.entry !== after.entry || before.live !== after.live || before.language !== after.language || before.onOpenLedger !== after.onOpenLedger || before.onOpenCommodoreRecord !== after.onOpenCommodoreRecord || before.boardActionLabel !== after.boardActionLabel) return false;
  if (before.breakBefore !== after.breakBefore || before.tail !== after.tail || before.capped !== after.capped || before.report !== after.report || before.showMark !== after.showMark) return false;
  // 결정 답 줄은 받는 이(지휘관)를 참여자에서 읽는다 — 명부가 늦게 와도 그 표식이 선다.
  if (after.entry.kind === "decision-answer") {
    const commander = (participants: readonly ConversationParticipant[]) => participants.find((participant) => participant.speaker.kind === "commander")?.speaker;
    return commander(before.participants) === commander(after.participants);
  }
  if (after.entry.kind !== "message") return true;
  const speaker = after.entry.speaker;
  if (sameSpeaker(before.previous, speaker) !== sameSpeaker(after.previous, speaker)) return false;
  // 최신 표식만 참여자 활동을 읽는다. 다른 참여자의 델타 때문에 지난 말까지 다시 그리지 않는다.
  const activity = (participants: readonly ConversationParticipant[]) => participants.find((participant) => speakerKey(participant.speaker) === speakerKey(speaker))?.activity;
  return !after.live || activity(before.participants) === activity(after.participants);
});

/** 누구의 말도 아닌 가운데 줄 — 세션 교대·실패 알림(플러그인 대화만 쓴다). 실패는 신호 잉크다. */
function NoteLine({ entry, language }: {
  readonly entry: Extract<AgentConversationEntry, { kind: "note" }>;
  readonly language: ConsoleLocale | undefined;
}) {
  const time = timeOf(entry.at, language);
  return (
    <div className={`group-chat-line group-chat-note${entry.tone === "warn" ? " is-warn" : ""}`} data-entry-id={entry.id}>
      <span className="group-chat-note-text">{entry.text}</span>
      {time ? <span className="group-chat-line-time">{time}</span> : null}
    </div>
  );
}

/**
 * 말풍선 옆 아바타를 둘 대화인가. 스냅숏 참여자는 지금 명부다 — 루트(지휘관)·구성원·아직 기동하지 않은 명부.
 * 떠난 구성원은 여기에 없다. 사람 말고 상대가 둘 이상이면 아바타가 선다. 하나뿐이면(사령관 채팅, 구성원 없는 지휘관) 끈다.
 */
function showsSpeakerMarks(participants: readonly ConversationParticipant[]): boolean {
  let agents = 0;
  for (const participant of participants) {
    if (participant.speaker.kind === "human") continue;
    agents += 1;
    if (agents > 1) return true;
  }
  return false;
}

function MessageBubble({ entry, continued, tail, live, participants, language, onOpenLedger, capped = false, report, showMark = true }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "message" }>;
  readonly continued: boolean;
  readonly tail: boolean;
  readonly live: boolean;
  readonly participants: GroupTimelineSnapshot["participants"];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger: GroupConversationProps["onOpenLedger"];
  /** 턴 접기 — 구성원 말풍선에 높이 상한을 두고 넘치면 「전체 보기」로 펼친다. 지휘관 말에는 걸지 않는다. */
  readonly capped?: boolean;
  /** 턴 접기 — 이 말풍선으로 옮긴 보고 줄. 머리의 꼬리표가 되고 누르면 보고 전문이 펼쳐진다. */
  readonly report?: DelegationEntry | undefined;
  /** 말풍선 옆 아바타. 상대가 하나뿐이면 끄고 이름만 남긴다. 원장을 여는 이름 단추는 그대로다. */
  readonly showMark?: boolean;
}) {
  const t = getGroupT(language);
  // 높이 상한은 구성원 말풍선만. 지휘관 말은 접기를 켜도 상한 없이 선다.
  const clip = useBubbleClip(capped && entry.speaker.kind !== "human" && entry.speaker.kind !== "commander");
  const [reportOpen, setReportOpen] = React.useState(false);
  const reportId = React.useId();
  // 문면이 없는 말(표시 문면 없이 보낸 플러그인 지시 등)은 빈 말풍선으로 세우지 않는다. 흐르는 중이면 「쓰는 중」이 선다.
  if (!entry.streaming && entry.text.trim().length === 0 && !entry.attachments?.length) return null;
  // 보드 행위에 덧붙인 말이면 받는 이 뒤에 그 행위를 단다 — 그냥 대화가 아니라 개시·구상·방향 수정과 함께 간 말이다.
  const via = entry.via ? <><span className="group-chat-line-sep" aria-hidden="true">·</span><span className="group-chat-via">{t(`group.via.${entry.via}`)}</span></> : null;
  if (entry.speaker.kind === "human") {
    return (
      <div className="group-chat-human" data-entry-id={entry.id}>
        {entry.recipient ? (
          <span className="group-chat-human-to">
            <span aria-hidden="true">→</span>
            <SpeakerMark speaker={entry.recipient} size="sm" />
            <SpeakerName speaker={entry.recipient} />
            {via}
          </span>
        ) : null}
        <div className={`group-chat-bubble is-human${entry.pending ? " is-pending" : ""}${entry.format === "markdown" ? " is-markdown" : ""}`}>
          {entry.attachments?.length ? <ChatDispatchAttachments attachments={entry.attachments} language={language ?? "en"} /> : null}
          {entry.format === "markdown"
            ? <StreamedMarkdown text={entry.text} streaming={false} className="agent-chat-dispatch-md" language={language} />
            : <ChatReferenceText text={entry.text} references={entry.references} />}
        </div>
        {entry.pending ? <span className="group-chat-pending">{t("group.pending")}</span> : null}
        {entry.undelivered ? <span className="agent-chat-undelivered" title={t("group.undelivered")}>{t("group.undelivered")}</span> : null}
      </div>
    );
  }
  // 지휘관·구성원의 응답은 채팅과 같이 마크다운이다. 흐르는 동안에는 글자 단위로 자란다.
  // 사령관은 이 화면의 언어로 부른다 — 원장이 실어 오는 이름은 언어를 모른다.
  const speaker = entry.speaker.kind === "commodore" ? { ...entry.speaker, name: t("group.commodore") } : entry.speaker;
  // 묶음 머리의 이름과 꼬리의 표식은 그 발화자의 원장을 여는 한 대상이다 — 탭 정지는 이름 하나, 표식은 마우스·터치용 복제 히트
  // 영역이다. 원장이 없는 발화자(사람·사령관·명부에 없는 id)와 콜백이 없는 대화(플러그인 대화)에서는 눌리는 척하지 않는다.
  const target = (continued && !tail) || !onOpenLedger ? null : ledgerTarget(speaker, participants);
  const open = target ? () => onOpenLedger!(target) : undefined;
  const label = open ? t("group.speaker.openLedger", { name: speaker.name }) : undefined;
  // 표식은 묶음 꼬리(마지막으로 서는 말풍선) 옆에 선다 — 묶음 왼쪽 아래.
  const mark = !tail ? null : live ? <LiveSpeakerMark speaker={speaker} participants={participants} /> : <SpeakerMark speaker={speaker} />;
  // 보드 행위 줄(via)의 발화자는 사람·사령관뿐이라 원장 대상이 아니다 — 단추는 일반 머리 이름에만 선다.
  const name = open
    ? <button type="button" className="group-chat-speaker-hit is-name group-chat-agent-name" aria-label={label} title={label} onClick={open}><SpeakerName speaker={speaker} /></button>
    : <SpeakerName speaker={speaker} className="group-chat-agent-name" />;
  // 보고 꼬리표 — 은은한 보조 낱말. 말풍선과 문면이 다를 수 있으므로 누르면 보낸 보고 전문이 그 아래에 펼쳐진다.
  const reportTag = report ? (
    <button type="button" className="group-chat-report-tag" aria-expanded={reportOpen} aria-controls={reportOpen ? reportId : undefined} onClick={() => setReportOpen((current) => !current)}>
      {t("group.report.tag", { name: report.recipients[0]?.name ?? t("group.commander") })}
    </button>
  ) : null;
  return (
    <div className={`group-chat-agent${continued ? " is-continued" : ""}${showMark ? "" : " is-solo"}`} data-entry-id={entry.id}>
      {showMark ? (
        <span className="group-chat-agent-mark">
          {open && mark ? <button type="button" className="group-chat-speaker-hit is-mark" tabIndex={-1} aria-hidden="true" title={label} onClick={open}>{mark}</button> : mark}
        </span>
      ) : null}
      <div className="group-chat-agent-box">
        {continued ? null : via && entry.recipient ? (
          <span className="group-chat-agent-name group-chat-agent-via">
            <SpeakerName speaker={speaker} />
            <span className="group-chat-line-arrow" aria-hidden="true">→</span>
            <SpeakerName speaker={entry.recipient} />
            {via}
          </span>
        ) : report ? <span className="group-chat-agent-head">{name}{reportTag}</span> : name}
        <div className={`group-chat-bubble is-agent is-markdown${clip.className}`}>
          {/* 본문 칸 — 높이 상한에 걸리면 이 칸이 그 자리에서 스크롤되고 흐림은 말풍선(바깥 틀)에 고정된다. 상한이 없으면 꾸밈 없는 블록이다. */}
          <div ref={clip.ref} className="group-chat-bubble-body">
            {/* 첨부는 사람 말풍선과 같은 자리(본문 앞)에 선다 — 문면 없이 첨부만 실은 말도 빈 말풍선이 아니다. */}
            {entry.attachments?.length ? <ChatDispatchAttachments attachments={entry.attachments} language={language ?? "en"} /> : null}
            {entry.text.trim().length === 0
              ? entry.streaming ? <span className="group-chat-writing agent-chat-live-text">{t("group.streaming")}</span> : null
              : <StreamedMarkdown text={entry.text} streaming={entry.streaming} preserveStreamingDom className="agent-chat-answer-body markdown-body group-chat-md" language={language} siteLinks />}
          </div>
        </div>
        {clip.clipped ? <button type="button" className="group-chat-link group-chat-more" onClick={clip.expand}>{t("group.bubble.more")}</button> : null}
        {report && continued ? <span className="group-chat-agent-head is-after">{reportTag}</span> : null}
        {report && reportOpen ? (
          <div className="group-chat-line-detail group-chat-report-detail" id={reportId}>
            <StreamedMarkdown text={report.text} streaming={false} className="group-chat-md markdown-body" language={language} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
/**
 * 말풍선 높이 상한(시안 B, 상한 값은 CSS 의 본문 칸 max-height) — 글자 수가 아니라 그려진 높이로 넘침을 잰다(표·코드는 짧은 글로도 길다).
 * 늦게 그려지는 마크다운(표·그림)으로 자라는 높이도 따라 잰다. 넘치는 본문 칸은 그 자리에서 스크롤되고(마우스 환경), 가려진 위·아래 가장자리만 흐린다.
 * 턴 접기에서 흐르는 구성원 말은 말풍선이 아니라 「쓰는 중」 칩으로 서므로(foldTimeline) 상한이 걸린 말풍선은 이미 완성된 구성원 말이다.
 * 펼친 말풍선은 이 화면을 보는 동안 펼친 채다(같은 말은 완성 때도 같은 key 라 펼침이 이어진다).
 */
function useBubbleClip(enabled: boolean): { readonly ref: React.RefCallback<HTMLDivElement>; readonly className: string; readonly clipped: boolean; readonly expand: () => void } {
  const [element, setElement] = React.useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [overflowing, setOverflowing] = React.useState(false);
  // 위로 가려진 줄이 있다(맨 위가 아니다) · 끝까지 내렸다.
  const [scrolled, setScrolled] = React.useState(false);
  const [atEnd, setAtEnd] = React.useState(false);
  const active = enabled && !expanded;
  React.useLayoutEffect(() => {
    if (!active || !element) { setOverflowing(false); setScrolled(false); setAtEnd(false); return; }
    const read = () => {
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
      setScrolled(element.scrollTop > 1);
      setAtEnd(element.scrollTop + element.clientHeight >= element.scrollHeight - 1);
    };
    read();
    element.addEventListener("scroll", read, { passive: true });
    // 본문 칸 자체는 상한에서 멈추므로 자라는 자식들(첨부·본문)을 함께 본다.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    if (observer) for (const target of [element, ...Array.from(element.children)]) observer.observe(target);
    return () => { element.removeEventListener("scroll", read); observer?.disconnect(); };
  }, [active, element]);
  const expand = React.useCallback(() => setExpanded(true), []);
  const edges = overflowing ? `${scrolled ? " is-scrolled" : ""}${atEnd ? " is-at-end" : ""}` : "";
  return { ref: setElement, className: active ? ` is-capped${overflowing ? " is-clipped" : ""}${edges}` : "", clipped: active && overflowing, expand };
}


function DelegationLine({ entry, language, onOpenLedger }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "delegation" }>;
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger: GroupConversationProps["onOpenLedger"];
}) {
  const t = getGroupT(language);
  // 성공한 전달의 도구 결과(JSON 영수증)는 본문을 되풀이할 뿐이라 세우지 않는다. 실패만 사유 한 줄을 남긴다.
  const failure = deliveryFailure(entry);
  const failed = failure !== null;
  const reason = failure ?? "";
  // 받는이 이름은 둘까지 쓰고 나머지는 「외 N명」으로 접는다 — 얼굴 묶음은 모두 선다. 셋째부터의 이름은 펼친 칸의 원장 링크가 말한다.
  const named = entry.recipients.length > 2 ? entry.recipients.slice(0, 2) : entry.recipients;
  const more = entry.recipients.length - named.length;
  // 지휘관의 원장은 이 그룹 대화 자체가 그 자리이므로 원장 링크를 두지 않는다 — 구성원 본문 선택은 루트를 고를 수 없다.
  const ledgers = dedupe([entry.sender, ...entry.recipients].filter((speaker) => speaker.kind === "member" && speaker.operationId));
  const preview = excerpt(entry.text);
  // 줄은 「보낸이 → 받는이 발췌」만 말한다. 도착 미확인은 낱말로 세우지 않고, 실패만 신호 잉크로 남긴다.
  return (
    <details className="group-chat-line group-chat-delegation" data-entry-id={entry.id}>
      <summary className="group-chat-line-summary">
        <span className="group-chat-delegation-party">
          <SpeakerMark speaker={entry.sender} size="sm" />
          <SpeakerName speaker={entry.sender} />
        </span>
        <span className="group-chat-line-arrow" aria-hidden="true">→</span>
        <span className="group-chat-delegation-party">
          <span className="group-chat-delegation-faces">
            {entry.recipients.map((recipient) => <SpeakerMark key={speakerKey(recipient)} speaker={recipient} size="sm" />)}
          </span>
          {named.map((recipient, index) => (
            <React.Fragment key={speakerKey(recipient)}>
              {index > 0 ? <span className="group-chat-line-sep" aria-hidden="true">,</span> : null}
              <SpeakerName speaker={recipient} />
            </React.Fragment>
          ))}
          {more > 0 ? <span className="group-chat-delegation-more">{t("group.delegation.more", { count: more })}</span> : null}
        </span>
        {preview ? <span className="group-chat-line-excerpt">{preview}</span> : null}
        {failed ? <span className="group-chat-line-status is-failed">{t("group.delegation.failed")}</span> : null}
        <span className="group-chat-line-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="group-chat-line-detail">
        <StreamedMarkdown text={entry.text} streaming={false} className="group-chat-md markdown-body" language={language} />
        {reason ? <div className="group-chat-line-failure">{reason}</div> : null}
        {onOpenLedger && ledgers.length > 0 ? (
          <div className="group-chat-line-actions">
            {ledgers.map((speaker) => (
              <button key={speakerKey(speaker)} type="button" className="group-chat-link" onClick={() => onOpenLedger(speaker.operationId!)}>
                {t("group.delegation.openLedger", { name: speaker.name })}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * 실패한 전달의 사람이 읽을 사유, 성공이면 null. `is_error` 없이 `{"success":false}` 영수증으로만 돌아오는 거절도 실패다
 * (호스트 `sessionMessageRefusal` 과 같은 판정). 사유는 JSON 영수증이면 그 `message`·`error` 낱말을, 아니면 도구 오류 꼬리표를
 * 벗긴 첫 줄을 쓴다.
 */
function deliveryFailure(entry: Extract<GroupTimelineEntry, { kind: "delegation" }>): string | null {
  let text = entry.result.trim();
  let refused = false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const fields = parsed as Record<string, unknown>;
      refused = fields.success === false;
      const said = [fields.message, fields.error].find((value): value is string => typeof value === "string" && value.trim().length > 0);
      text = said ?? "";
    }
  } catch { /* 평문 오류 */ }
  if (entry.ok !== false && !refused) return null;
  const line = text.replace(/<\/?tool_use_error>/gu, "").trim().split("\n")[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function dedupe(speakers: readonly ConversationSpeaker[]): readonly ConversationSpeaker[] {
  const seen = new Set<string>();
  return speakers.filter((speaker) => {
    const key = speakerKey(speaker);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 플러그인이 혼자 보낸 지시 — 「목표 → 지휘관 발췌」 한 줄, 펼치면 전문. 출처는 단일 채팅의 출처 줄과 같은 이름·글리프이고,
 * 모르는 플러그인은 「플러그인」으로 부른다(플러그인 id 는 화면에 쓰지 않는다). 문면이 없는 지시는 지금처럼 세우지 않는다.
 */
function PluginNoticeLine({ entry, language, onOpenLedger }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "plugin-notice" }>;
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger: GroupConversationProps["onOpenLedger"];
}) {
  const t = getGroupT(language);
  if (entry.text.trim().length === 0) return null;
  const known = pluginOriginIdentity(entry.pluginId, language ?? "en");
  const time = timeOf(entry.at, language);
  const preview = excerpt(entry.text);
  // 지휘관에게 간 알림이면 이 대화가 곧 그 원장이다 — 구성원에게 간 것만 원장 링크를 둔다(위임 줄과 같은 규칙).
  const ledger = onOpenLedger && entry.recipient.kind === "member" && entry.recipient.operationId ? entry.recipient : null;
  return (
    <details className="group-chat-line group-chat-plugin-notice" data-entry-id={entry.id}>
      <summary className="group-chat-line-summary">
        <span className="group-chat-notice-source">
          <span className="group-chat-notice-glyph" aria-hidden="true"><AgentGlyph name={known?.glyph ?? "other"} /></span>
          {known?.name ?? t("group.notice.plugin")}
        </span>
        <span className="group-chat-line-arrow" aria-hidden="true">→</span>
        <span className="group-chat-delegation-party">
          <SpeakerMark speaker={entry.recipient} size="sm" />
          <SpeakerName speaker={entry.recipient} />
        </span>
        {preview ? <span className="group-chat-line-excerpt">{preview}</span> : null}
        {time ? <span className="group-chat-line-time">{time}</span> : null}
        <span className="group-chat-line-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="group-chat-line-detail">
        <StreamedMarkdown text={entry.text} streaming={false} className="group-chat-md markdown-body" language={language} />
        {ledger ? (
          <div className="group-chat-line-actions">
            <button type="button" className="group-chat-link" onClick={() => onOpenLedger!(ledger.operationId!)}>
              {t("group.delegation.openLedger", { name: ledger.name })}
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function MembershipLine({ entry, language }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "member-joined" | "member-left" }>;
  readonly language: ConsoleLocale | undefined;
}) {
  const t = getGroupT(language);
  const time = timeOf(entry.at, language);
  return (
    <div className="group-chat-line group-chat-membership" data-entry-id={entry.id}>
      <SpeakerMark speaker={entry.speaker} size="sm" />
      <span>{t(entry.kind === "member-joined" ? "group.joined" : "group.left", { name: entry.speaker.name })}</span>
      {time ? <span className="group-chat-line-time">{time}</span> : null}
    </div>
  );
}

/**
 * 사람이 답한 결정 — 답한 시각의 자리에 사람이 보낸 말과 같은 오른쪽 말풍선으로 선다(같은 면·반경·여백, 머리의 「→ 받는 이 · 행위」 줄).
 * 질문마다 머리말 칩(있으면, 결정 카드와 같은 칩)·질문(작은 보조 글자)·답(본문 글자)이 쌓이고, 아무리 길어도 말풍선 폭 안에서 줄을 바꾼다.
 */
function DecisionAnswerLine({ entry, asker, language }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "decision-answer" }>;
  readonly asker: ConversationSpeaker | null;
  readonly language: ConsoleLocale | undefined;
}) {
  const t = getGroupT(language);
  return (
    <div className="group-chat-human" data-entry-id={entry.id}>
      <span className="group-chat-human-to">
        {asker ? <>
          <span aria-hidden="true">→</span>
          <SpeakerMark speaker={asker} size="sm" />
          <SpeakerName speaker={asker} />
          <span className="group-chat-line-sep" aria-hidden="true">·</span>
        </> : null}
        <span className="group-chat-via">{t("group.decision.answered")}</span>
        <span className="group-card-settled-mark" aria-hidden="true">✓</span>
      </span>
      <div className="group-chat-bubble is-human group-card-settled-body">
        {entry.answers.map((answer, at) => (
          <div key={at} className="group-card-settled-item">
            {answer.header ? <span className="group-card-header">{answer.header}</span> : null}
            <span className="group-card-settled-q">{answer.question}</span>
            <span>{answer.answer}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardActionLine({ entry, language, onOpenRecord, label }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "board-action" }>;
  readonly language: ConsoleLocale | undefined;
  readonly onOpenRecord: GroupConversationProps["onOpenCommodoreRecord"];
  readonly label?: string | undefined;
}) {
  const t = getGroupT(language);
  const time = timeOf(entry.at, language);
  const action = resolveLocalizedText(entry.action, language ?? "en");
  const summary = (
    <>
      <SpeakerMark speaker={entry.speaker} size="sm" />
      <span className="group-chat-line-who">{entry.speaker.name}</span>
      <span className="group-chat-line-sep" aria-hidden="true">·</span>
      <span className="group-chat-line-excerpt">{action}</span>
      {time ? <span className="group-chat-line-time">{time}</span> : null}
    </>
  );
  // 펼칠 이유도, 열 기록도 없으면 눌리는 척하지 않는다.
  if (entry.text.trim().length === 0 && !onOpenRecord) return <div className="group-chat-line group-chat-board" data-entry-id={entry.id}>{summary}</div>;
  return (
    <details className="group-chat-line group-chat-board" data-entry-id={entry.id}>
      <summary className="group-chat-line-summary">
        {summary}
        <span className="group-chat-line-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="group-chat-line-detail">
        {entry.text.trim() ? <>
          <span className="group-chat-line-label">{t("group.board.reason")}</span>
          <StreamedMarkdown text={entry.text} streaming={false} className="group-chat-md markdown-body" language={language} />
        </> : null}
        {onOpenRecord ? (
          <div className="group-chat-line-actions">
            <button type="button" className="group-chat-link" onClick={() => onOpenRecord({ objectiveId: entry.objectiveId, entryId: entry.id, at: entry.at })}>{label ?? t("group.board.openRecord")}</button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** 진행 줄 낱말을 이름 자리에서 가르는 표 — 번역 문형의 앞뒤 글자를 그대로 두고 이름만 단추로 세우려고 쓴다. */
const WORKING_NAME_SLOT = "\u0000";

/**
 * 진행 줄 — 지금 일하는 참여자(activity=running)를 모두 쌓아 보인다. 받은 전언으로 일한다고 짐작하지 않는다(계약).
 * 표식과 이름은 말풍선 머리와 같은 규칙(`ledgerTarget`)으로 그 참여자의 원장을 연다 — 지휘관이면 루트 id 라 여는 쪽이
 * 지휘관 원장으로 연다. 원장이 없는 참여자와 콜백이 없는 대화에서는 눌리는 척하지 않는다. 진행 줄은 아무도 멈추지 않는다
 * (정지는 입력창과 「구성원」 탭의 몫이다). 표식은 32px 로 서서 사이드바처럼 지금 하는 일(생각·읽기·편집…)을 연기한다.
 * 일하는 이가 없으면 줄은 높이만 지켜 입력창이 뛰지 않게 한다.
 */
export function GroupWorkingLine({ working, participants, language, onOpenLedger, computerActor = null }: {
  readonly working: readonly ConversationSpeaker[];
  readonly participants: readonly ConversationParticipant[];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger?: (operationId: string) => void;
  /** 컴퓨터를 지금 조작하는 참여자. 일하는 사람 중에 있으면 낱말 뒤에 도구 꼬리가 붙는다. */
  readonly computerActor?: string | null;
}) {
  const t = getGroupT(language);
  if (working.length === 0) return <div className="group-chat-working is-empty" aria-hidden="true" />;
  const targets = working.map((speaker) => (onOpenLedger ? ledgerTarget(speaker, participants) : null));
  const openLabel = (speaker: ConversationSpeaker) => t("group.speaker.openLedger", { name: speaker.name });
  // 표식은 마우스·터치용 복제 히트 영역이다 — 탭 정지는 이름(낱말) 하나가 진다(말풍선 머리와 같은 관례).
  const marks = working.map((speaker, index) => {
    const target = targets[index];
    return target ? (
      <button key={speakerKey(speaker)} type="button" className="group-chat-working-hit is-mark" tabIndex={-1} aria-hidden="true" title={openLabel(speaker)} onClick={() => onOpenLedger!(target)}>
        <SpeakerMark speaker={speaker} size="lg" state="running" acting />
      </button>
    ) : <SpeakerMark key={speakerKey(speaker)} speaker={speaker} size="lg" state="running" acting />;
  });
  return (
    <div className="group-chat-working" role="status">
      <span className="group-chat-working-stack">{marks}</span>
      <WorkingText working={working} targets={targets} t={t} openLabel={openLabel} onOpenLedger={onOpenLedger} />
      {toolTail(working, computerActor, t)}
    </div>
  );
}

/** 진행 줄의 도구 꼬리 — 조작자가 일하는 사람 중에 있을 때만. 한 명이면 「· 컴퓨터 사용」, 여럿이면 누구인지 밝힌다. */
function toolTail(working: readonly ConversationSpeaker[], actor: string | null, t: ReturnType<typeof getGroupT>): React.ReactNode {
  const speaker = actor ? working.find((candidate) => candidate.operationId === actor) : undefined;
  if (!speaker) return null;
  return <span className="group-chat-working-tool">{working.length === 1 ? t("group.working.computer") : t("group.working.computerBy", { name: speaker.name })}</span>;
}

/**
 * 진행 줄 낱말. 한 명이면 낱말 전체가 그 원장을 여는 단추다. 여럿이면 이름마다 제 원장을 여는 단추가 되고 나머지 글자는 그대로
 * 선다. 물결(`agent-chat-live-text`)은 낱말 상자 하나에 걸어 이름 단추를 지나도 한 물결로 흐른다.
 */
function WorkingText({ working, targets, t, openLabel, onOpenLedger }: {
  readonly working: readonly ConversationSpeaker[];
  readonly targets: readonly (string | null)[];
  readonly t: ReturnType<typeof getGroupT>;
  readonly openLabel: (speaker: ConversationSpeaker) => string;
  readonly onOpenLedger: ((operationId: string) => void) | undefined;
}) {
  if (working.length === 1) {
    const speaker = working[0]!;
    const target = targets[0];
    const label = t("group.working.one", { name: speaker.name });
    return target
      ? <button type="button" className="group-chat-working-text agent-chat-live-text group-chat-working-hit is-text" title={openLabel(speaker)} onClick={() => onOpenLedger!(target)}>{label}</button>
      : <span className="group-chat-working-text agent-chat-live-text">{label}</span>;
  }
  if (!targets.some(Boolean)) {
    return <span className="group-chat-working-text agent-chat-live-text">{t("group.working.many", { names: working.map((speaker) => speaker.name).join(" · ") })}</span>;
  }
  const [before = "", after = ""] = t("group.working.many", { names: WORKING_NAME_SLOT }).split(WORKING_NAME_SLOT);
  return (
    <span className="group-chat-working-text agent-chat-live-text is-parts">
      {before ? <span className="group-chat-working-part is-rest">{before}</span> : null}
      {working.map((speaker, index) => {
        const target = targets[index];
        return (
          <React.Fragment key={speakerKey(speaker)}>
            {index > 0 ? <span className="group-chat-working-part is-sep">{" · "}</span> : null}
            {target
              ? <button type="button" className="group-chat-working-part group-chat-working-hit is-text" title={openLabel(speaker)} onClick={() => onOpenLedger!(target)}>{speaker.name}</button>
              : <span className="group-chat-working-part">{speaker.name}</span>}
          </React.Fragment>
        );
      })}
      {after ? <span className="group-chat-working-part is-rest">{after}</span> : null}
    </span>
  );
}

/** 참여자 활동 낱말 — 구성원 탭이 쓴다. 턴 뒤에 남은 백그라운드 작업은 화면에서 작업 중으로 읽힌다(memberActivityVisual). */
export function activityKey(activity: Exclude<ConversationParticipant["activity"], "background">) {
  return `group.activity.${activity}` as const;
}

/** 구성원 점·낱말이 그리는 활동 — Operation 표시 어휘와 같게 background 를 running 으로 접는다. 원시 활동은 중단 버튼 판정이 그대로 읽는다. */
export function memberActivityVisual(activity: ConversationParticipant["activity"]): Exclude<ConversationParticipant["activity"], "background"> {
  return activity === "background" ? "running" : activity;
}
