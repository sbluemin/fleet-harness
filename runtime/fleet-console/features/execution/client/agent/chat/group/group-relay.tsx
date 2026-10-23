import type { ConsoleLocale } from "@fleet-console/i18n";
import type { ConversationParticipant, ConversationSpeaker, GroupTimelineEntry } from "../../../../shared/conversation/types.js";
import type { AgentConversationEntry } from "../../../../shared/chat-renderer.js";
import * as React from "react";

import { AgentGlyph } from "../../agent-glyphs.js";
import { StreamedMarkdown } from "../../streamed-markdown.js";
import { pluginOriginIdentity } from "../origin-mark.js";
import { getGroupT } from "./group-chat-i18n.js";
import { LedgerTargetContext, SpeakerMark, speakerKey } from "./speaker-mark.js";
import { publishConversationPillTakeover, useConversationPillHosted } from "../../../../../workspace/client/conversation/conversation-slots.js";
import { useViewMode } from "../../../../../../core/client/src/integration/view-mode-store.js";
import { pushBackLayer } from "../../../../../../core/client/src/chrome/mobile/mobile-back.js";
import { pushOverlayHistory, releaseOverlayHistory, runAfterOverlayRelease } from "../../../../../../core/client/src/chrome/mobile/mobile-overlay-history.js";

/**
 * 전언 — 참여자끼리 주고받은 말(위임)과 플러그인이 혼자 보낸 지시(목표 → 지휘관). 그룹 대화에서는 사람에게 한 말과 섞이지 않게
 * 가운데 한 줄(「보낸 사람 [아바타 이름]」)로만 서고, 누르면 그 자리에서 펼치지 않고 대화 칸 전체를 덮는 대화 화면으로 넘어간다.
 *
 * 대화 화면은 같은 참여자 묶음 사이의 전언 전체를 시간순으로 말풍선처럼 읽는다 — 위 가운데 칩에 보낸 이 ⇄ 받는 이, 아래 가운데에
 * 「채팅 닫기」. 오른쪽에서 밀려 들어오고 뒤의 기록은 조금 왼쪽으로 밀리며 흐려진다(움직임 줄이기면 바로 바뀐다). 열면 포커스가 화면으로
 * 가고 Esc·「채팅 닫기」로 닫으면 누른 줄로 돌아온다. 원장은 보낸 이 ⇄ 받는 이의 구성원 이름이 연다.
 *
 * 보낸 이 ⇄ 받는 이는 대화 주인 Objective 의 머리 pill(데스크톱 맨 위 줄·모바일 상단 막대)이 그 자리에서 바뀌어 보인다
 * (`publishConversationPillTakeover`) — 대화 화면은 그 줄을 덮지 않는다. 그 pill 이 없는 대화(플러그인 대화 등)에서만 화면 맨 위에
 * 같은 칩을 대신 세운다. pill 의 칩은 화면 밖 DOM 이지만 화면이 소유한다 — 접근성 트리에서는 화면이 `aria-owns` 로 품고, Tab 순환의 첫 자리다.
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

const FOCUSABLE = "a[href], area[href], button:not([disabled]), input:not([disabled]):not([type=\"hidden\"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable=\"true\"], [tabindex]:not([tabindex=\"-1\"])";

/** 화면 안에서 Tab 으로 닿는 것 — 원장 단추·마크다운 링크와 코드 복사·「채팅 닫기」. 보이지 않거나 inert 안에 든 것은 뺀다. */
function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.tabIndex >= 0 && !node.closest("[inert]") && node.getClientRects().length > 0);
}

/**
 * aria-modal 화면의 Tab 순환 — 형제 inert 는 대화 칸 안쪽만 덮으므로 셸 크롬(모바일 상단 막대·사이드바)으로 빠지지 않게 화면과 화면이
 * 소유한 pill 칩(`owned`) 안에서만 돈다. 순서는 위에서 아래 — pill 칩, 메시지 속 링크, 「채팅 닫기」. 끝에서 처음으로, 처음(또는 루트
 * 자신)에서 끝으로 잇는다. 셸 바깥에 inert 를 걸지 않는다 — 그쪽은 다른 기능의 몫이다.
 */
function trapTab(event: React.KeyboardEvent<HTMLElement>, root: HTMLElement, owned: HTMLElement | null): void {
  const stops = [...(owned ? tabStops(owned) : []), ...tabStops(root)];
  const active = document.activeElement;
  if (stops.length === 0) { event.preventDefault(); root.focus({ preventScroll: true }); return; }
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const inside = active instanceof HTMLElement && (root.contains(active) || owned?.contains(active) === true);
  const index = inside ? stops.indexOf(active) : -1;
  let next: HTMLElement | null;
  if (!inside || active === root) next = event.shiftKey ? last : first;
  else if (index < 0) next = null;
  else next = stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]!;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** 대화 화면 — 연 전언이 없으면 아무것도 그리지 않는다. 다른 전언을 열면 새 화면으로 선다. */
export function RelayConversation({ selected, origin, onDismiss, entries, participants, language, onOpenLedger, timeLabel, pillObjectiveId = null }: RelayLayerPorts & {
  readonly entries: readonly AgentConversationEntry[];
  readonly participants: readonly ConversationParticipant[];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger?: ((objectiveId: string) => void) | undefined;
  /** 메시지 위 가운데 시각 — 그룹 대화의 시각 줄과 같은 문구. */
  readonly timeLabel: (at: number) => string;
  /** 머리 pill 을 바꿀 대화 주인 Objective — 그 pill 이 서 있으면 보낸 이 ⇄ 받는 이를 거기에 보인다. 없으면 화면 안에 칩을 둔다. */
  readonly pillObjectiveId?: string | null | undefined;
}) {
  const entry = selected === null ? undefined : entries.find((candidate) => candidate.id === selected);
  if (!entry || !isRelay(entry)) return null;
  return <RelayLayer key={entry.id} entry={entry} origin={origin} onDismiss={onDismiss} entries={entries} participants={participants} language={language} onOpenLedger={onOpenLedger} timeLabel={timeLabel} pillObjectiveId={pillObjectiveId} />;
}

function RelayLayer({ entry, origin, onDismiss, entries, participants, language, onOpenLedger, timeLabel, pillObjectiveId }: {
  readonly entry: RelayEntry;
  readonly origin: React.RefObject<HTMLElement | null>;
  readonly onDismiss: () => void;
  readonly entries: readonly AgentConversationEntry[];
  readonly participants: readonly ConversationParticipant[];
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger: ((objectiveId: string) => void) | undefined;
  readonly timeLabel: (at: number) => string;
  readonly pillObjectiveId: string | null;
}) {
  const t = getGroupT(language);
  const ledgerOf = React.useContext(LedgerTargetContext);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(reducedMotion);
  const closing = React.useRef(false);
  // 사람이 닫았다(「채팅 닫기」·Esc) — 내려가는 순간 누른 줄로 포커스를 돌려준다. 원장으로 가며 닫힐 때는 돌려주지 않는다.
  const returnFocus = React.useRef(false);
  const titleId = React.useId();
  const pairId = React.useId();
  const hosted = useConversationPillHosted(pillObjectiveId);

  // 폰 배치에서는 하드웨어·브라우저 뒤로와 상단 ‹ 가 Objective 을 떠나지 않고 이 화면부터 닫는다(좌표 시트와 같은 계약) — 열린 동안
  // history 항목 하나와 뒤로 층 하나를 올린다. 데스크톱은 올리지 않는다(브라우저 뒤로도 지금 그대로다).
  const phone = useViewMode().effective === "mobile";
  const historyRef = React.useRef<number | null>(null);
  const backLayerRef = React.useRef<(() => void) | null>(null);
  const closeRef = React.useRef<() => void>(() => undefined);
  /** 뒤로 길을 거둔다 — 뒤로 층은 바로 내리고, 아직 남은 history 항목 id 를 돌려준다(걷기는 부르는 쪽이 길에 맞게 한다). */
  const takeBackPaths = React.useCallback((): number | null => {
    backLayerRef.current?.();
    backLayerRef.current = null;
    const id = historyRef.current;
    historyRef.current = null;
    return id;
  }, []);
  React.useEffect(() => {
    if (!phone) return;
    // 뒤로(popstate)로 걷히면 항목은 이미 없다 — 닫기 애니메이션·포커스 복귀만 탄다.
    historyRef.current = pushOverlayHistory(() => { historyRef.current = null; closeRef.current(); });
    backLayerRef.current = pushBackLayer(() => closeRef.current());
    return () => {
      const left = takeBackPaths();
      if (left !== null) releaseOverlayHistory(left);
    };
  }, [phone, takeBackPaths]);

  const sender = senderOf(entry, language);
  const recipients = recipientsOf(entry);
  const key = partyKey(entry, language);
  // 같은 참여자 묶음의 전언 전체 — 원장 순서(시간순) 그대로. 새 전언이 오면 이 화면에도 붙는다.
  const thread = React.useMemo(() => entries.filter((candidate): candidate is RelayEntry => isRelay(candidate) && partyKey(candidate, language) === key), [entries, key, language]);

  // 대화 칸(부모)에 화면의 상태를 단다 — 칸의 넘침 자르기와 형제를 밀어내는 CSS 가 이 속성을 읽는다. `:has(> .group-relay)` 로
  // 고르면 문서 어디의 자식 변화(입력창 한 글자)에도 대화 전체의 스타일을 다시 계산해, 긴 대화에서 입력이 수백 ms 늦어진다.
  React.useLayoutEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    host.setAttribute("data-relay", open ? "open" : "shown");
    return () => host.removeAttribute("data-relay");
  }, [open]);

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
    // 연 메시지가 보이게 — 그 메시지(시각 줄부터)를 목록의 위쪽 여백 선에 둔다. 여백은 폰 배치에서 떠 있는 상단 막대 몫(--m-chrome-top)을
    // 품으므로 고정값이 아니라 계산된 여백을 뺀다 — 그래야 첫 줄이 막대 밑에 숨지 않는다. 늦게 그려지는 마크다운을 한 프레임 뒤에 다시 맞춘다.
    const place = () => {
      const log = logRef.current;
      const target = log?.querySelector<HTMLElement>("[data-relay-current]");
      if (!log || !target) return;
      const inset = Number.parseFloat(getComputedStyle(log).paddingTop) || 0;
      log.scrollTop = Math.max(0, target.offsetTop - inset);
    };
    place();
    const frame = requestAnimationFrame(() => { place(); setOpen(true); });
    return () => {
      cancelAnimationFrame(frame);
      for (const child of marked) child.removeAttribute("inert");
      // inert 를 걷은 바로 이 자리에서 돌려준다 — 화면이 아직 문서에 있어 포커스가 BODY 로 떨어지기 전이고, 닫기를 부른 길
      // (React 사건·transitionend·타이머)이 무엇이든 언마운트 커밋과 순서가 엇갈리지 않는다. 줄이 다시 그려졌으면 같은 전언의 단추를 찾는다.
      if (!returnFocus.current) return;
      const back = origin.current;
      const button = back?.isConnected ? back : Array.from(host.querySelectorAll<HTMLElement>("[data-entry-id]")).find((node) => node.dataset.entryId === entry.id)?.querySelector<HTMLElement>("button");
      button?.focus({ preventScroll: true });
    };
  }, [entry.id, origin]);

  const finish = React.useCallback(() => {
    returnFocus.current = true;
    onDismiss();
  }, [onDismiss]);

  const close = React.useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    // UI(「채팅 닫기」·Esc·뒤로 층)로 닫으면 쌓아 둔 history 항목을 곧바로 걷는다 — 닫기 애니메이션 동안의 뒤로는 화면 너머로 간다.
    const left = takeBackPaths();
    if (left !== null) releaseOverlayHistory(left);
    const root = rootRef.current;
    // pill 칩에서 닫으면 포커스를 먼저 화면으로 거둔다 — 칩은 화면이 내려가는 커밋 뒤에야 걷히므로, 그대로 두면 React 가 커밋 뒤 그 칩으로
    // 포커스를 되돌려(누른 줄로 돌려준 포커스를 빼앗고) 칩이 걷힐 때 BODY 로 떨어진다.
    if (root && document.getElementById(pairId)?.contains(document.activeElement)) root.focus({ preventScroll: true });
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
  }, [finish, pairId, takeBackPaths]);
  closeRef.current = close;

  // 원장으로 가면 그 자리가 원장 틀로 바뀐다 — 화면을 먼저 내리고 연다. 폰 배치면 history 항목이 걷힌 다음에 옮긴다(걷기 전에 옮기면
  // 새 상태가 걷히는 항목에 쓰여 사라진다).
  const openLedger = (objectiveId: string) => {
    if (closing.current) return;
    closing.current = true;
    runAfterOverlayRelease(takeBackPaths(), () => { onDismiss(); onOpenLedger?.(objectiveId); });
  };
  const onKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (!root) return;
    if (event.key === "Tab") { trapTab(event, root, hosted ? document.getElementById(pairId) : null); return; }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  // pill 칩은 화면 밖 트리에 서므로 최신 동작을 이 자리로 부른다(칩 내용은 참여자가 바뀔 때만 새로 만든다).
  const actions = React.useRef({ openLedger, onKey });
  actions.current = { openLedger, onKey };
  const ledgerFor = (party: Party): string | null =>
    party.kind === "speaker" && party.speaker.kind === "member" && onOpenLedger ? ledgerOf(party.speaker, participants) : null;

  const partyChip = (party: Party, place: "head" | "pill") => {
    const target = ledgerFor(party);
    const label = t("group.speaker.openLedger", { name: partyName(party) });
    const className = place === "pill" ? "group-relay-pill-party" : "group-relay-party";
    const body = <><PartyMark party={party} size={place === "pill" ? "md" : "lg"} /><span className={`${className}-name`}>{partyName(party)}</span></>;
    return target
      ? <button key={party.key} type="button" className={`${className} is-ledger`} title={label} aria-label={label} onClick={() => actions.current.openLedger(target)}>{body}</button>
      : <span key={party.key} className={className}>{body}</span>;
  };
  const pairBody = (place: "head" | "pill") => (
    <>
      {partyChip(sender, place)}
      <svg className="group-relay-swap" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 8h15m0 0-3.5-3.5M19 8l-3.5 3.5M20 16H5m0 0 3.5-3.5M5 16l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {recipients.map((party, index) => (
        <React.Fragment key={party.key}>
          {index > 0 ? <span className="group-relay-pair-sep" aria-hidden="true">·</span> : null}
          {partyChip(party, place)}
        </React.Fragment>
      ))}
    </>
  );

  const names = [partyName(sender), ...recipients.map(partyName)].join(", ");
  const ledgerKey = [sender, ...recipients].map((party) => ledgerFor(party) ?? "").join(",");
  // 머리 pill 에 보일 칩 — 화면이 선 동안(밀려 들어온 뒤부터 내려가기 시작할 때까지) 주인 Objective 의 pill 을 이것으로 바꾼다.
  const takeover = React.useMemo(() => ({
    key: `relay:${entry.id}`,
    label: t("group.relay.title", { names }),
    content: <span id={pairId} className="group-relay-pill" onKeyDown={(event) => actions.current.onKey(event)}>{pairBody("pill")}</span>,
  }), [entry.id, names, ledgerKey, language, pairId]); // eslint-disable-line react-hooks/exhaustive-deps -- 칩 모양은 이름·원장 대상·언어만 바꾼다.
  React.useLayoutEffect(() => {
    if (!hosted || !open || pillObjectiveId === null) return;
    publishConversationPillTakeover(pillObjectiveId, takeover);
    return () => publishConversationPillTakeover(pillObjectiveId, null);
  }, [hosted, open, pillObjectiveId, takeover]);
  const owned = hosted && open;
  return (
    <div
      ref={rootRef}
      className={`group-relay${open ? " is-open" : ""}${hosted ? " is-pill" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-owns={owned ? pairId : undefined}
      tabIndex={-1}
      onKeyDown={onKey}
    >
      <h2 id={titleId} className="agent-chat-sr-only">{t("group.relay.title", { names })}</h2>
      {hosted ? null : (
        <div className="group-relay-head">
          <div className="group-relay-pair">{pairBody("head")}</div>
        </div>
      )}
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
