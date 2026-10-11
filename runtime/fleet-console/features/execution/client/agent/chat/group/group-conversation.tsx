import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { StreamedMarkdown } from "../../streamed-markdown.js";
import type { ConversationParticipant, ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot } from "./conversation-types.js";
import { getGroupT } from "./group-chat-i18n.js";
import { setGroupLedgerFocus, useGroupLedgerFocus } from "./group-ledger-focus.js";
import { SpeakerMark, SpeakerName, speakerKey } from "./speaker-mark.js";
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
 * 보기」는 이 자리에서 그 참여자의 원장만 읽기 전용으로 보인다. 진행 줄은 일하는 참여자를 모두 쌓아 보인다.
 *
 * 쓰기(정지·사령관 기록 열기)는 콜백 자리만 둔다. 콜백이 없으면 그 단추도 서지 않는다 — 눌리는 척하지 않는다.
 */
export interface GroupConversationProps {
  readonly snapshot: GroupTimelineSnapshot;
  readonly language: ConsoleLocale | undefined;
  /** 진행 줄 표식을 눌러 그 참여자만 멈춘다(임무 16에서 연결). */
  readonly onStopParticipant?: (speaker: ConversationSpeaker) => void;
  /** 사령관 행위 줄에서 사령관 기록의 그 턴을 연다(사령관 배치 작업에서 연결). */
  readonly onOpenCommodoreRecord?: (entry: Extract<GroupTimelineEntry, { kind: "board-action" }>) => void;
}

export function GroupConversation({ snapshot, language, onStopParticipant, onOpenCommodoreRecord }: GroupConversationProps) {
  const t = getGroupT(language);
  const root = snapshot.rootOperationId;
  const focus = useGroupLedgerFocus(root);
  const focusSpeaker = focus ? findSpeaker(snapshot, focus) : null;
  const entries = React.useMemo(
    () => (focus ? snapshot.entries.filter((entry) => inLedger(entry, focus)) : snapshot.entries),
    [snapshot.entries, focus],
  );
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const nearBottomRef = React.useRef(true);
  const last = entries[entries.length - 1];
  const growth = `${entries.length}:${last?.id ?? ""}:${last?.kind === "message" ? last.text.length : 0}`;

  // 바닥을 따라가는 중일 때만 새 말을 따라 내려간다. 위로 올려 읽는 중이면 그 자리를 지킨다.
  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (log && nearBottomRef.current) log.scrollTop = log.scrollHeight;
  }, [growth]);
  // 원장 보기로 들어가고 나올 때는 처음부터 다시 바닥에 선다.
  React.useLayoutEffect(() => {
    nearBottomRef.current = true;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [focus]);

  const unavailableNames = snapshot.unavailableOperationIds
    .map((id) => findSpeaker(snapshot, id)?.name)
    .filter((name): name is string => typeof name === "string");

  return (
    <div className={`group-chat${focus ? " is-ledger" : ""}`}>
      <div
        ref={logRef}
        className="group-chat-log"
        role="log"
        aria-label={t("group.aria.log")}
        aria-busy={snapshot.loading}
        onScroll={(event) => {
          const log = event.currentTarget;
          nearBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
        }}
      >
        <div className="group-chat-column">
          {focusSpeaker ? (
            <div className="group-chat-banner" role="status">
              <SpeakerMark speaker={focusSpeaker} size="sm" />
              <span>{t("group.ledger.banner", { name: focusSpeaker.name })}</span>
            </div>
          ) : null}
          {snapshot.truncated ? <p className="group-chat-notice">{t("group.truncated")}</p> : null}
          {snapshot.unavailableOperationIds.length > 0 ? (
            <p className="group-chat-notice">
              {unavailableNames.length > 0 ? t("group.unavailable", { names: unavailableNames.join(", ") }) : t("group.unavailableOne")}
            </p>
          ) : null}
          {entries.length === 0 ? (
            <p className="group-chat-empty">{snapshot.loading ? t("group.loading") : t("group.empty")}</p>
          ) : entries.map((entry, index) => (
            <TimelineEntry
              key={entry.id}
              entry={entry}
              previous={entries[index - 1]}
              language={language}
              root={root}
              onOpenCommodoreRecord={onOpenCommodoreRecord}
            />
          ))}
        </div>
      </div>
      {focus && root ? (
        <div className="group-chat-return">
          <button type="button" className="group-chat-return-button" onClick={() => setGroupLedgerFocus(root, null)}>
            {t("group.ledger.back")}
          </button>
        </div>
      ) : (
        <GroupWorkingLine working={snapshot.working} language={language} onStop={onStopParticipant} />
      )}
    </div>
  );
}

/** 이 참여자의 원장에 드는 줄 — 그가 받은 말, 그가 한 말, 그가 주고받은 전언, 그의 합류·제거. */
function inLedger(entry: GroupTimelineEntry, operationId: string): boolean {
  switch (entry.kind) {
    case "message": return entry.operationId === operationId;
    case "delegation": return entry.sender.operationId === operationId || entry.recipients.some((recipient) => recipient.operationId === operationId);
    case "member-joined":
    case "member-left": return entry.speaker.operationId === operationId;
    case "board-action": return false;
  }
}

function findSpeaker(snapshot: GroupTimelineSnapshot, operationId: string): ConversationSpeaker | null {
  return snapshot.participants.find((participant) => participant.speaker.operationId === operationId)?.speaker ?? null;
}

function sameSpeaker(entry: GroupTimelineEntry | undefined, speaker: ConversationSpeaker): boolean {
  return entry?.kind === "message" && speakerKey(entry.speaker) === speakerKey(speaker);
}

const TIME_FORMATS = {
  en: new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }),
  ko: new Intl.DateTimeFormat("ko", { hour: "2-digit", minute: "2-digit" }),
};
const timeOf = (at: number | null, language: ConsoleLocale | undefined): string | undefined =>
  at === null ? undefined : TIME_FORMATS[language ?? "en"].format(new Date(at));

/** 본문 첫 줄 조각 — 접힌 줄에 선다. 마크다운 표식은 걷는다. */
function excerpt(text: string, max = 120): string {
  const first = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:>\s?|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").replace(/\*\*|[*`]/g, "").trim()).find((line) => line.length > 0) ?? "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

function TimelineEntry({ entry, previous, language, root, onOpenCommodoreRecord }: {
  readonly entry: GroupTimelineEntry;
  readonly previous: GroupTimelineEntry | undefined;
  readonly language: ConsoleLocale | undefined;
  readonly root: string | null;
  readonly onOpenCommodoreRecord: GroupConversationProps["onOpenCommodoreRecord"];
}) {
  switch (entry.kind) {
    case "message": return <MessageBubble entry={entry} continued={sameSpeaker(previous, entry.speaker)} language={language} />;
    case "delegation": return <DelegationLine entry={entry} language={language} root={root} />;
    case "member-joined":
    case "member-left": return <MembershipLine entry={entry} language={language} />;
    case "board-action": return <BoardActionLine entry={entry} language={language} onOpenRecord={onOpenCommodoreRecord} />;
  }
}

function MessageBubble({ entry, continued, language }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "message" }>;
  readonly continued: boolean;
  readonly language: ConsoleLocale | undefined;
}) {
  const t = getGroupT(language);
  const time = timeOf(entry.at, language);
  if (entry.speaker.kind === "human") {
    return (
      <div className="group-chat-human" {...(time ? { title: time } : {})}>
        <div className={`group-chat-bubble is-human${entry.format === "markdown" ? " is-markdown" : ""}`}>
          {entry.format === "markdown"
            ? <StreamedMarkdown text={entry.text} streaming={false} className="group-chat-md markdown-body" language={language} />
            : entry.text}
        </div>
      </div>
    );
  }
  // 지휘관·구성원의 응답은 채팅과 같이 마크다운이다. 흐르는 동안에는 글자 단위로 자란다.
  return (
    <div className={`group-chat-agent${continued ? " is-continued" : ""}`} {...(time ? { title: time } : {})}>
      <span className="group-chat-agent-mark">{continued ? null : <SpeakerMark speaker={entry.speaker} />}</span>
      <div className="group-chat-agent-box">
        {continued ? null : <SpeakerName speaker={entry.speaker} className="group-chat-agent-name" />}
        <div className="group-chat-bubble is-agent is-markdown">
          {entry.text.trim().length === 0 && entry.streaming
            ? <span className="group-chat-writing agent-chat-live-text">{t("group.streaming")}</span>
            : <StreamedMarkdown text={entry.text} streaming={entry.streaming} className="group-chat-md markdown-body" language={language} />}
        </div>
      </div>
    </div>
  );
}

function DelegationLine({ entry, language, root }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "delegation" }>;
  readonly language: ConsoleLocale | undefined;
  readonly root: string | null;
}) {
  const t = getGroupT(language);
  const names = entry.recipients.map((recipient) => recipient.name).join(", ");
  const status = entry.ok === false ? t("group.delegation.failed") : !entry.received ? t("group.delegation.unconfirmed") : null;
  const ledgers = dedupe([entry.sender, ...entry.recipients].filter((speaker) => speaker.kind !== "human" && speaker.operationId));
  const preview = excerpt(entry.text);
  return (
    <details className="group-chat-line group-chat-delegation">
      <summary className="group-chat-line-summary">
        <SpeakerMark speaker={entry.sender} size="sm" />
        <span className="group-chat-line-who">{entry.sender.name}</span>
        <span className="group-chat-line-arrow" aria-hidden="true">→</span>
        {entry.recipients.map((recipient) => <SpeakerMark key={speakerKey(recipient)} speaker={recipient} size="sm" />)}
        <span className="group-chat-line-who">{names}</span>
        {preview ? <><span className="group-chat-line-sep" aria-hidden="true">·</span><span className="group-chat-line-excerpt">{preview}</span></> : null}
        {status ? <><span className="group-chat-line-sep" aria-hidden="true">·</span><span className={`group-chat-line-status${entry.ok === false ? " is-failed" : ""}`}>{status}</span></> : null}
        <span className="group-chat-line-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="group-chat-line-detail">
        <span className="group-chat-line-label">{t("group.delegation.sent")}</span>
        <div className="group-chat-line-recipient">→ {names}</div>
        <StreamedMarkdown text={entry.text} streaming={false} className="group-chat-md markdown-body" language={language} />
        <span className="group-chat-line-label">{t("group.delegation.result")}</span>
        <div className="group-chat-line-result">{entry.result.trim() || t("group.delegation.pending")}</div>
        {root && ledgers.length > 0 ? (
          <div className="group-chat-line-actions">
            {ledgers.map((speaker) => (
              <button key={speakerKey(speaker)} type="button" className="group-chat-link" onClick={() => setGroupLedgerFocus(root, speaker.operationId!)}>
                {t("group.delegation.openLedger", { name: speaker.name })}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
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

function MembershipLine({ entry, language }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "member-joined" | "member-left" }>;
  readonly language: ConsoleLocale | undefined;
}) {
  const t = getGroupT(language);
  const time = timeOf(entry.at, language);
  return (
    <div className="group-chat-line group-chat-membership">
      <SpeakerMark speaker={entry.speaker} size="sm" />
      <span>{t(entry.kind === "member-joined" ? "group.joined" : "group.left", { name: entry.speaker.name })}</span>
      {time ? <span className="group-chat-line-time">{time}</span> : null}
    </div>
  );
}

function BoardActionLine({ entry, language, onOpenRecord }: {
  readonly entry: Extract<GroupTimelineEntry, { kind: "board-action" }>;
  readonly language: ConsoleLocale | undefined;
  readonly onOpenRecord: GroupConversationProps["onOpenCommodoreRecord"];
}) {
  const t = getGroupT(language);
  const time = timeOf(entry.at, language);
  const summary = (
    <>
      <SpeakerMark speaker={entry.speaker} size="sm" />
      <span className="group-chat-line-who">{entry.speaker.name}</span>
      <span className="group-chat-line-sep" aria-hidden="true">·</span>
      <span className="group-chat-line-excerpt">{entry.action}</span>
      {time ? <span className="group-chat-line-time">{time}</span> : null}
    </>
  );
  // 펼칠 이유도, 열 기록도 없으면 눌리는 척하지 않는다.
  if (entry.text.trim().length === 0 && !onOpenRecord) return <div className="group-chat-line group-chat-board">{summary}</div>;
  return (
    <details className="group-chat-line group-chat-board">
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
            <button type="button" className="group-chat-link" onClick={() => onOpenRecord(entry)}>{t("group.board.openRecord")}</button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * 진행 줄 — 지금 일하는 참여자(activity=running)를 모두 쌓아 보인다. 받은 전언으로 일한다고 짐작하지 않는다(계약).
 * 정지 콜백이 있으면 표식이 그 참여자만 멈추는 단추가 된다. 일하는 이가 없으면 줄은 높이만 지켜 입력창이 뛰지 않게 한다.
 */
export function GroupWorkingLine({ working, language, onStop }: {
  readonly working: readonly ConversationSpeaker[];
  readonly language: ConsoleLocale | undefined;
  readonly onStop?: (speaker: ConversationSpeaker) => void;
}) {
  const t = getGroupT(language);
  if (working.length === 0) return <div className="group-chat-working is-empty" aria-hidden="true" />;
  const label = working.length === 1
    ? t("group.working.one", { name: working[0]!.name })
    : t("group.working.many", { names: working.map((speaker) => speaker.name).join(" · ") });
  return (
    <div className="group-chat-working" role="status">
      <span className="group-chat-working-stack">
        {working.map((speaker) => onStop ? (
          <button key={speakerKey(speaker)} type="button" className="group-chat-working-stop" aria-label={t("group.working.stop", { name: speaker.name })} title={t("group.working.stop", { name: speaker.name })} onClick={() => onStop(speaker)}>
            <SpeakerMark speaker={speaker} size="sm" />
          </button>
        ) : <SpeakerMark key={speakerKey(speaker)} speaker={speaker} size="sm" />)}
      </span>
      <span className="group-chat-working-text agent-chat-live-text">{label}</span>
      {onStop ? <span className="group-chat-working-hint">{t("group.working.stopHint")}</span> : null}
    </div>
  );
}

/** 참여자 활동 낱말 — 구성원 탭이 쓴다. */
export function activityKey(activity: ConversationParticipant["activity"]) {
  return `group.activity.${activity}` as const;
}
