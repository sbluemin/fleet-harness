import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ConversationParticipant, ConversationSpeaker, GroupTimelineEntry } from "@fleet-console/sdk/conversation";
import type { AgentConversationEntry } from "@fleet-console/sdk/components/agent-chat-transcript";
import { React } from "@fleet-console/sdk/plugin/browser";

import { AgentGlyph } from "../../agent-glyphs.js";
import { StreamedMarkdown } from "../../streamed-markdown.js";
import { pluginOriginIdentity } from "../origin-mark.js";
import { getGroupT } from "./group-chat-i18n.js";
import { LedgerTargetContext, SpeakerMark, speakerKey } from "./speaker-mark.js";

/**
 * 전언 — 참여자끼리 주고받은 말(위임)과 플러그인이 혼자 보낸 지시(목표 → 지휘관). 그룹 대화에서는 사람에게 한 말과 섞이지 않게
 * 가운데 한 줄(「보낸 사람 [아바타 이름]」)로만 서고, 누르면 그 자리에서 펼치지 않고 대화 칸 전체를 덮는 대화 화면으로 넘어간다.
 *
 * 대화 화면은 같은 참여자 묶음 사이의 전언 전체를 시간순으로 말풍선처럼 읽는다 — 위 가운데 칩에 보낸 이 ⇄ 받는 이, 아래 가운데에
 * 「채팅 닫기」. 오른쪽에서 밀려 들어오고 뒤의 기록은 조금 왼쪽으로 밀리며 흐려진다(움직임 줄이기면 바로 바뀐다). 열면 포커스가 화면으로
 * 가고 Esc·「채팅 닫기」로 닫으면 누른 줄로 돌아온다. 원장은 위 칩의 구성원 이름이 연다.
 *
 * 상태는 `useRelayConversation` 이 지고 화면은 `RelayConversation` 이 그린다 — 그룹 대화 루트에는 화면 한 줄만 끼운다.
 */
export type DelegationEntry = Extract<GroupTimelineEntry, { kind: "delegation" }>;
type PluginNoticeEntry = Extract<GroupTimelineEntry, { kind: "plugin-notice" }>;
type RelayEntry = DelegationEntry | PluginNoticeEntry;

/** 전언 줄을 눌러 대화 화면을 연다 — 닫으면 포커스가 `origin` 으로 돌아간다. */
export type RelayOpener = (entryId: string, origin: HTMLElement) => void;

interface RelayLayerPorts {
  readonly selected: string | null;
  readonly origin: React.RefObject<HTMLElement | null>;
  readonly onDismiss: () => void;
}

/** 대화 화면의 상태 — 연 전언 id 와 누른 줄. 열기 함수는 늘 같은 함수다(줄의 memo 를 깨지 않는다). */
export function useRelayConversation(): { readonly open: RelayOpener; readonly layer: RelayLayerPorts } {
  const [selected, setSelected] = React.useState<string | null>(null);
  const origin = React.useRef<HTMLElement | null>(null);
  const open = React.useCallback<RelayOpener>((entryId, element) => { origin.current = element; setSelected(entryId); }, []);
  const onDismiss = React.useCallback(() => setSelected(null), []);
  const layer = React.useMemo(() => ({ selected, origin, onDismiss }), [selected, onDismiss]);
  return { open, layer };
}

/**
 * 실패한 전달의 사람이 읽을 사유, 성공이면 null. `is_error` 없이 `{"success":false}` 영수증으로만 돌아오는 거절도 실패다
 * (호스트 `sessionMessageRefusal` 과 같은 판정). 사유는 JSON 영수증이면 그 `message`·`error` 낱말을, 아니면 도구 오류 꼬리표를
 * 벗긴 첫 줄을 쓴다.
 */
export function deliveryFailure(entry: DelegationEntry): string | null {
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

/** 전언의 한쪽 — 발화자이거나, 플러그인 지시면 그 출처(단일 채팅 출처 줄과 같은 이름·글리프, 모르는 플러그인은 「플러그인」). */
type Party =
  | { readonly kind: "speaker"; readonly key: string; readonly speaker: ConversationSpeaker }
  | { readonly kind: "source"; readonly key: string; readonly name: string; readonly glyph: string };

function senderOf(entry: RelayEntry, language: ConsoleLocale | undefined): Party {
  if (entry.kind === "delegation") return { kind: "speaker", key: speakerKey(entry.sender), speaker: entry.sender };
  const known = pluginOriginIdentity(entry.pluginId, language ?? "en");
  return { kind: "source", key: `plugin:${entry.pluginId}`, name: known?.name ?? getGroupT(language)("group.notice.plugin"), glyph: known?.glyph ?? "other" };
}

function recipientsOf(entry: RelayEntry): readonly Party[] {
  const speakers = entry.kind === "delegation" ? entry.recipients : [entry.recipient];
  const seen = new Set<string>();
  return speakers.flatMap((speaker): Party[] => {
    const key = speakerKey(speaker);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ kind: "speaker", key, speaker }];
  });
}

/** 같은 참여자 묶음의 좌표 — 보낸 이와 받는 이를 방향 없이 모은다(A→B 와 B→A 는 한 대화다). */
function partyKey(entry: RelayEntry, language: ConsoleLocale | undefined): string {
  return Array.from(new Set([senderOf(entry, language).key, ...recipientsOf(entry).map((party) => party.key)])).sort().join("\u0000");
}

const isRelay = (entry: AgentConversationEntry): entry is RelayEntry =>
  entry.kind === "delegation" || (entry.kind === "plugin-notice" && entry.text.trim().length > 0);

const partyName = (party: Party): string => (party.kind === "speaker" ? party.speaker.name : party.name);

/** 파티 표식 — 발화자는 말풍선과 같은 몽글 아바타, 플러그인 출처는 그 글리프. */
function PartyMark({ party, size }: { readonly party: Party; readonly size: "md" | "lg" }) {
  if (party.kind === "speaker") return <SpeakerMark speaker={party.speaker} size={size} />;
  return <span className={`group-relay-glyph is-${size}`} aria-hidden="true"><AgentGlyph name={party.glyph} /></span>;
}

/**
 * 전언 줄 — 가운데 단추 하나: 「보낸 사람」 보조 글자와 보낸 이의 표식·이름만 담은 은은한 알약 칩. 발췌·받는 이·펼침 화살표는 없다.
 * 전달 실패만 칩 뒤에 신호 잉크로 짧게 남는다. 누르면 대화 화면이 열린다(여는 쪽이 없으면 눌리는 척하지 않는다).
 */
export function RelayLine({ entry, language, onOpen }: {
  readonly entry: RelayEntry;
  readonly language: ConsoleLocale | undefined;
  readonly onOpen: RelayOpener | undefined;
}) {
  const t = getGroupT(language);
  if (entry.kind === "plugin-notice" && entry.text.trim().length === 0) return null;
  const sender = senderOf(entry, language);
  const name = partyName(sender);
  const failed = entry.kind === "delegation" && deliveryFailure(entry) !== null;
  const body = (
    <>
      <span className="group-relay-from">{t("group.relay.from")}</span>
      <span className="group-relay-chip">
        <PartyMark party={sender} size="md" />
        <span className="group-relay-chip-name">{name}</span>
      </span>
      {failed ? <span className="group-relay-failed">{t("group.delegation.failed")}</span> : null}
    </>
  );
  return (
    <div className={`group-chat-line group-chat-relay${entry.kind === "plugin-notice" ? " is-notice" : ""}`} data-entry-id={entry.id}>
      {onOpen ? (
        <button
          type="button"
          className="group-relay-row"
          aria-haspopup="dialog"
          aria-label={t(failed ? "group.relay.openFailed" : "group.relay.open", { name })}
          onClick={(event) => onOpen(entry.id, event.currentTarget)}
        >
          {body}
        </button>
      ) : <span className="group-relay-row">{body}</span>}
    </div>
  );
}

/** 시안 값 — 밀기 전환의 길이. 끝 알림(transitionend)이 오지 않아도 이만큼 뒤에는 닫기를 마친다. */
const SLIDE_MS = 340;

const reducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 대화 화면 — 연 전언이 없으면 아무것도 그리지 않는다. 다른 전언을 열면 새 화면으로 선다. */
export function RelayConversation({ selected, origin, onDismiss, entries, participants, language, onOpenLedger, timeLabel }: RelayLayerPorts & {
  readonly entries: readonly AgentConversationEntry[];
  readonly participants: readonly ConversationParticipant[];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger?: ((operationId: string) => void) | undefined;
  /** 메시지 위 가운데 시각 — 그룹 대화의 시각 줄과 같은 문구. */
  readonly timeLabel: (at: number) => string;
}) {
  const entry = selected === null ? undefined : entries.find((candidate) => candidate.id === selected);
  if (!entry || !isRelay(entry)) return null;
  return <RelayLayer key={entry.id} entry={entry} origin={origin} onDismiss={onDismiss} entries={entries} participants={participants} language={language} onOpenLedger={onOpenLedger} timeLabel={timeLabel} />;
}

function RelayLayer({ entry, origin, onDismiss, entries, participants, language, onOpenLedger, timeLabel }: {
  readonly entry: RelayEntry;
  readonly origin: React.RefObject<HTMLElement | null>;
  readonly onDismiss: () => void;
  readonly entries: readonly AgentConversationEntry[];
  readonly participants: readonly ConversationParticipant[];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger: ((operationId: string) => void) | undefined;
  readonly timeLabel: (at: number) => string;
}) {
  const t = getGroupT(language);
  const ledgerOf = React.useContext(LedgerTargetContext);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(reducedMotion);
  const closing = React.useRef(false);
  const titleId = React.useId();

  const sender = senderOf(entry, language);
  const recipients = recipientsOf(entry);
  const key = partyKey(entry, language);
  // 같은 참여자 묶음의 전언 전체 — 원장 순서(시간순) 그대로. 새 전언이 오면 이 화면에도 붙는다.
  const thread = React.useMemo(() => entries.filter((candidate): candidate is RelayEntry => isRelay(candidate) && partyKey(candidate, language) === key), [entries, key, language]);

  // 뒤의 기록·진행 줄·입력창은 화면이 선 동안 닿지 않는다 — 형제에게만 inert 를 걸고, 우리가 건 것만 닫을 때 걷는다.
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!root || !host) return;
    const marked: Element[] = [];
    for (const child of Array.from(host.children)) {
      if (child === root || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      marked.push(child);
    }
    root.focus({ preventScroll: true });
    // 연 메시지가 보이게 — 그 메시지(시각 줄부터)를 화면 위쪽에 둔다. 늦게 그려지는 마크다운을 한 프레임 뒤에 다시 맞춘다.
    const place = () => {
      const log = logRef.current;
      const target = log?.querySelector<HTMLElement>("[data-relay-current]");
      if (log && target) log.scrollTop = Math.max(0, target.offsetTop - 12);
    };
    place();
    const frame = requestAnimationFrame(() => { place(); setOpen(true); });
    return () => {
      cancelAnimationFrame(frame);
      for (const child of marked) child.removeAttribute("inert");
    };
  }, []);

  const finish = React.useCallback(() => {
    const back = origin.current;
    const host = rootRef.current?.parentElement ?? null;
    onDismiss();
    // 화면이 내려가고 inert 가 걷힌 뒤 누른 줄로 돌아간다. 그사이 줄이 다시 그려졌으면 같은 전언의 단추를 찾는다.
    requestAnimationFrame(() => {
      const button = back?.isConnected ? back : Array.from(host?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? []).find((node) => node.dataset.entryId === entry.id)?.querySelector<HTMLElement>("button");
      button?.focus({ preventScroll: true });
    });
  }, [entry.id, onDismiss, origin]);

  const close = React.useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const root = rootRef.current;
    if (!root || reducedMotion()) { finish(); return; }
    setOpen(false);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      root.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      finish();
    };
    const onEnd = (event: TransitionEvent) => { if (event.target === root && event.propertyName === "transform") end(); };
    root.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(end, SLIDE_MS + 80);
  }, [finish]);

  // 원장으로 가면 그 자리가 원장 틀로 바뀐다 — 화면을 먼저 내리고 연다.
  const openLedger = (operationId: string) => { closing.current = true; onDismiss(); onOpenLedger?.(operationId); };
  const ledgerFor = (party: Party): string | null =>
    party.kind === "speaker" && party.speaker.kind === "member" && onOpenLedger ? ledgerOf(party.speaker, participants) : null;

  const partyChip = (party: Party) => {
    const target = ledgerFor(party);
    const label = t("group.speaker.openLedger", { name: partyName(party) });
    return target ? (
      <button key={party.key} type="button" className="group-relay-party is-ledger" title={label} aria-label={label} onClick={() => openLedger(target)}>
        <PartyMark party={party} size="lg" />
        <span className="group-relay-party-name">{partyName(party)}</span>
      </button>
    ) : (
      <span key={party.key} className="group-relay-party">
        <PartyMark party={party} size="lg" />
        <span className="group-relay-party-name">{partyName(party)}</span>
      </span>
    );
  };

  const names = [partyName(sender), ...recipients.map(partyName)].join(", ");
  return (
    <div
      ref={rootRef}
      className={`group-relay${open ? " is-open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <h2 id={titleId} className="agent-chat-sr-only">{t("group.relay.title", { names })}</h2>
      <div className="group-relay-head">
        <div className="group-relay-pair">
          {partyChip(sender)}
          <svg className="group-relay-swap" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 8h15m0 0-3.5-3.5M19 8l-3.5 3.5M20 16H5m0 0 3.5-3.5M5 16l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {recipients.map((party, index) => (
            <React.Fragment key={party.key}>
              {index > 0 ? <span className="group-relay-pair-sep" aria-hidden="true">·</span> : null}
              {partyChip(party)}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div ref={logRef} className="group-relay-log">
        {thread.map((message) => {
          const from = senderOf(message, language);
          const failure = message.kind === "delegation" ? deliveryFailure(message) : null;
          return (
            <div key={message.id} className="group-relay-message" data-relay-current={message.id === entry.id || undefined}>
              {message.at !== null ? <div className="group-relay-time">{timeLabel(message.at)}</div> : null}
              <div className="group-relay-name">{partyName(from)}</div>
              <div className="group-relay-row-body">
                <span className="group-relay-mark"><PartyMark party={from} size="lg" /></span>
                <div className="group-relay-box">
                  <div className="group-chat-bubble is-agent is-markdown group-relay-bubble">
                    <StreamedMarkdown text={message.text} streaming={false} className="agent-chat-answer-body markdown-body group-chat-md" language={language} siteLinks />
                  </div>
                  {failure !== null ? <span className="group-relay-failure">{failure ? `${t("group.delegation.failed")} · ${failure}` : t("group.delegation.failed")}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="group-relay-foot">
        <button type="button" className="group-relay-close" onClick={close}>{t("group.relay.close")}</button>
      </div>
    </div>
  );
}
