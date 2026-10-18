import type { ConversationSpeaker, GroupBoardAction, GroupBoardActionGlyph, GroupBoardRunResult, GroupConversationActions, GroupMessageTarget, GroupTimelineSnapshot, GroupWriteResult } from "@fleet-console/sdk/conversation";
import {
  AttachImageIcon,
  ComposerAttachmentTray,
  ComposerDeck,
  ComposerQuoteTray,
  ComposerDeckGroup,
  ComposerDeckRow,
  ComposerMenu,
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerNotice,
  ComposerPlusButton,
  ComposerSendButton,
  MentionChip,
  composerAttachmentNoticeText,
  composerDeckKeyDown,
  composeQuotedPrompt,
  composerQuotePlaceholder,
  composerQuoteValues,
  composerT,
  createComposerAttachments,
  useComposerAttachmentInput,
  useComposerAttachmentSnapshot,
  useComposerQuotes,
} from "@fleet-console/sdk/composer";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { React } from "@fleet-console/sdk/plugin/browser";

import { useMenuButtonKeyboard } from "../../../../../../core/client/src/chrome/components/use-menu-button-keyboard.js";
import { useViewMode } from "../../../../../../core/client/src/integration/view-mode-store.js";
import { discardLaunchAttachment, uploadLaunchAttachment } from "../../api.js";
import { getComposerDraft } from "../../../operation-view-state.js";
import { claimComposerInbox } from "../composer-inbox.js";
import { getGroupT } from "./group-chat-i18n.js";
import { SpeakerMark, speakerKey } from "./speaker-mark.js";

/**
 * 그룹 대화 입력창 — 가운데 칸 바닥의 캡슐.
 *
 * 받는 이: 멘션이 없으면 지휘관(사람 확정). `@` 로 구성원 한 명 · 모두 · 바깥의 사령관 중 하나를 고른다. 받는 이는 한 번에
 * 하나다 — 구성원 여럿을 고르면 지휘관 사본이 사람 말 하나에 여러 번 가므로, 여럿에게는 「모두」를 쓴다.
 *
 * 쓰기는 계약의 액션(`send`·`stopAll`)과 기존 한 명 정지 경로(`onStopOne`)로만 한다. 결과는 targets 그대로 평이한 문장으로
 * 알리고, 일부만 닿아도 다시 보내지 않는다(자동 재전송 금지). 지휘관 사본이 실패하면 「모두 전달됨」이라고 하지 않는다.
 * 요청 전체가 거절되면 쓴 말을 지운다는 약속을 하지 않는다 — 그대로 남긴다.
 *
 * 정지: 쓴 말이 없고 누군가 일하는 중이면 보내기 단추가 정지가 된다. 누르면 「모두 정지」와 일하는 참여자별 정지를 고른다.
 *
 * 첨부: 캡슐 왼쪽 「+」 하나가 입구다 — 누르면 위로 뜨는 메뉴에서 「이미지 첨부」와 「받는 이 지정」을 고른다. 이미지 붙여넣기는
 * 같은 첨부 길로 들어간다(텍스트 붙여넣기는 브라우저 기본 동작 그대로). 업로드·상한·형식은 1:1 채팅 입력창과 같은 계약이고,
 * 이미지는 받는 세션 한 곳에만 실리므로 「모두」에게는 싣지 않는다. 사령관은 자기 메시지 소유로 받는다.
 *
 * 보드 동작(`actions.board`): 입력창 위 한 줄(제안 줄)에 보드가 고른 지금 할 일이 칩으로 선다. 덧붙일 말을 받는 칩을 고르면
 * 입력창 안에 동작 칩이 앉고, 쓰는 말이 곧 덧붙일 말이다 — 그동안 받는 이는 지휘관으로 고정되고 @ 는 막힌다(고르던 받는 이는
 * 동작을 풀면 돌아온다). 말이 없는 칩은 누르면 곧 실행이고(확인이 걸린 칩은 두 번), 결과는 같은 알림 줄에 선다. 플러그인이
 * 이어받는 칸(라우팅 확인·후속 후보)은 입력창 바로 위 자리에 플러그인이 그린다. 압축은 「+」 메뉴의 마지막 행이다.
 */
type Candidate =
  | { readonly kind: "member"; readonly speaker: ConversationSpeaker }
  | { readonly kind: "all" }
  | { readonly kind: "commodore" };

type Notice = { readonly tone: "info" | "warn"; readonly text: string };

/** 입력창에 붙은 이미지 — id 가 서기 전(업로드 중)에는 보내지 않는다. */
export interface GroupComposerProps {
  readonly rootOperationId: string;
  readonly snapshot: GroupTimelineSnapshot;
  readonly actions: GroupConversationActions | null;
  readonly language: ConsoleLocale | undefined;
  /** 한 명만 멈춘다 — 기존 실행 중 중지 경로. */
  readonly onStopOne: (speaker: ConversationSpeaker) => Promise<void>;
}

const MENTION_QUERY = /(?:^|\s)@([^\s@]*)$/u;
/** 두 번 눌러 보내는 칩·압축 행 — 첫 누름 뒤 이 안에 다시 눌러야 보낸다. */
const ARM_MS = 4000;

const glyphPath = (d: string) => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
/** 보드 동작 글리프 — 목표 보드의 같은 동작과 같은 모양이다. */
const BOARD_GLYPHS: Readonly<Record<GroupBoardActionGlyph, React.ReactNode>> = {
  plan: glyphPath("M3 13l7-7M10 3l.6 1.6L12.2 5l-1.6.6L10 7.2 9.4 5.6 7.8 5l1.6-.6zM13 9l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z"),
  start: glyphPath("M4.5 3.5l8 4.5-8 4.5z"),
  steer: glyphPath("M2.5 11.5c2-4 5-6 11-6M10.5 2.5l3 3-3 3"),
  complete: glyphPath("M3.5 8.5 6.5 11.5 12.5 4.5"),
  handOff: glyphPath("M2.5 8h8M7.5 4.5 11 8l-3.5 3.5M13.5 3v10"),
};
const LockGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
const RequestGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.2 2.8h9.6a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H7.4L4.4 14v-2.4H3.2a1.4 1.4 0 0 1-1.4-1.4v-6a1.4 1.4 0 0 1 1.4-1.4z" /><path d="M6.5 5.6a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.6.5-.6.9v.3" /></svg>;
const CompactGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.75v4M5.75 3.75 8 6l2.25-2.25M8 14.25v-4M5.75 12.25 8 10l2.25 2.25M3 8h10" /></svg>;

interface GroupComposerDraft {
  readonly text: string;
  readonly textRevision: number;
  readonly target: Candidate | null;
  readonly busy: boolean;
  readonly notice: Notice | null;
  /** 입력창에 앉은 보드 동작의 id — 보드의 제안에서 사라지면 걷힌다. */
  readonly mode: string | null;
  /** 플러그인 칸이 이어받은 동작과, 그 동작이 덧붙일 말로 가져간 초안의 판 — 칸이 끝내면 그 초안만 걷는다. */
  readonly held: BoardConsumed | null;
}

/** 보드 동작이 덧붙일 말로 가져간 초안 — 그 판(textRevision)이 그대로일 때만 보낸 뒤 걷는다. */
interface BoardConsumed {
  readonly mode: string;
  readonly revision: number;
}

/** 실행 기능이 소유하는 페이지 메모리 — 대화 본문이 내려가도 초안·업로드·전송은 같은 루트에 남는다. */
const groupDrafts = new Map<string, ReturnType<typeof createGroupDraft>>();
function createGroupDraft() {
  const attachments = createComposerAttachments({
    upload: (file) => uploadLaunchAttachment(file),
    discard: (id) => discardLaunchAttachment(id),
  });
  let current: GroupComposerDraft = { text: "", textRevision: 0, target: null, busy: false, notice: null, mode: null, held: null };
  const listeners = new Set<() => void>();
  return {
    attachments,
    read: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (patch: Partial<GroupComposerDraft>) => {
      current = { ...current, ...patch };
      for (const listener of listeners) listener();
    },
  };
}
function groupDraft(rootOperationId: string) {
  let draft = groupDrafts.get(rootOperationId);
  if (!draft) { draft = createGroupDraft(); groupDrafts.set(rootOperationId, draft); }
  return draft;
}

export function GroupComposer({ rootOperationId, snapshot, actions, language, onStopOne }: GroupComposerProps) {
  const phone = useViewMode().effective === "mobile";
  const t = getGroupT(language);
  // 첨부·「+」 메뉴 문구는 사령관 입력창과 한 벌이다(SDK).
  const ct = composerT(language);
  const draft = groupDraft(rootOperationId);
  const { text, target, busy, notice, mode } = React.useSyncExternalStore(draft.subscribe, draft.read, draft.read);
  const attachmentSnap = useComposerAttachmentSnapshot(draft.attachments);
  const attachments = attachmentSnap.items;
  // 인용 칩은 지휘관 Operation 의 초안이 가진다 — 채팅 원장과 이 그룹 입력창이 같은 묶음을 읽어, 어느 화면으로 열어도 칩이 서 있다.
  const quoteStore = getComposerDraft(rootOperationId).quotes;
  const quotes = useComposerQuotes(quoteStore);
  const hasQuotes = quotes.length > 0;
  const attachmentInput = useComposerAttachmentInput(draft.attachments, {
    disabled: busy || !actions,
    pastedName: ct("composer.attach.pasted"),
  });
  const setText = (value: string) => draft.update({ text: value, textRevision: draft.read().textRevision + 1 });
  const setTarget = (value: Candidate | null) => draft.update({ target: value });
  const setBusy = (value: boolean) => draft.update({ busy: value });
  const setNotice = (value: Notice | null) => draft.update({ notice: value });
  const [popIndex, setPopIndex] = React.useState(0);
  const [popDismissed, setPopDismissed] = React.useState(false);
  const [stopOpen, setStopOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  // 다른 표면(Codex 문서)이 인용을 붙이면 커서가 이 입력창으로 온다. 처음 서는 순간의 기존 칩은 초점을 가져가지 않는다.
  const quoteCount = React.useRef(quotes.length);
  React.useEffect(() => {
    if (quotes.length > quoteCount.current) inputRef.current?.focus({ preventScroll: true });
    quoteCount.current = quotes.length;
  }, [quotes.length]);
  // 수신함 — 대화 중심 화면에서는 이 입력창이 지휘관(루트)의 입력 자리다. Operation Browser 가 맡긴 주석·스크린샷을 주차된 원장 채팅
  // 대신 여기서 붙여넣기와 같은 길(업로드 → 칩)로 세운다. 보내지는 않는다.
  React.useEffect(() => claimComposerInbox(rootOperationId, (entry) => {
    draft.attachments.add(entry.files, (file) => file.name.trim().length > 0 ? file.name : ct("composer.attach.pasted"));
    inputRef.current?.focus();
  }), [rootOperationId, draft, ct]);
  const pendingPick = React.useRef<Candidate | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const plusRootRef = React.useRef<HTMLSpanElement | null>(null);
  const plusRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  useMenuButtonKeyboard(plusRootRef, plusRef, menuRef, menuOpen, setMenuOpen);
  const menuId = React.useId();
  const deckId = React.useId();
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const local = (value: Parameters<typeof resolveLocalizedText>[0]) => resolveLocalizedText(value, language ?? "en");

  // 보드 동작 — 고정된 동작(완료한 목표)이 있으면 늘 그 동작이 앉는다. 앉힌 동작이 제안에서 사라지면(상태가 바뀜) 걷는다.
  const board = actions?.board ?? null;
  const offered = React.useMemo(() => (board ? [...board.suggestions, ...(board.more ?? [])] : []), [board]);
  const seated: GroupBoardAction | null = board?.fixed ?? (mode !== null ? offered.find((action) => action.id === mode && action.context) ?? null : null);
  React.useEffect(() => {
    if (mode !== null && !board?.fixed && !offered.some((action) => action.id === mode && action.context)) draft.update({ mode: null });
  }, [board, offered, mode, draft]);
  // 두 번 누름 — 칩 id 또는 압축 행. 다른 일을 하면 풀린다.
  const [armed, setArmed] = React.useState<string | null>(null);
  const armTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(armTimer.current), []);
  const arm = (key: string | null) => {
    clearTimeout(armTimer.current);
    setArmed(key);
    if (key !== null) armTimer.current = setTimeout(() => setArmed((current) => (current === key ? null : current)), ARM_MS);
  };
  /**
   * 무장은 그 칸(`data-board-arm`) 밖을 누르면 풀린다. 포커스로 판정하지 않는다 — 대화 칸은 누를 때마다 활성 Operation 을 풀며 포커스를
   * 먼저 빼므로(호스트 공용 pointerdown), 같은 칩을 다시 누르는 두 번째 누름도 그 직전에 blur 가 온다.
   */
  React.useEffect(() => {
    if (armed === null) return;
    const onPointer = (event: PointerEvent) => {
      const held = event.target instanceof Element ? event.target.closest("[data-board-arm]")?.getAttribute("data-board-arm") : null;
      if (held === armed) return;
      clearTimeout(armTimer.current);
      setArmed((current) => (current === armed ? null : current));
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [armed]);
  /** 키보드로 다른 컨트롤에 옮겨 가면 푼다 — 다른 요소가 포커스를 받지 않는 blur(위의 호스트 blur 등)는 떠남이 아니다. */
  const disarmOnLeave = (key: string) => (event: React.FocusEvent<HTMLElement>) => {
    if (armed === key && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) arm(null);
  };

  const members = snapshot.participants.filter((participant) => participant.speaker.kind === "member").map((participant) => participant.speaker);
  const commander = snapshot.participants.find((participant) => participant.speaker.kind === "commander")?.speaker ?? null;
  const query = MENTION_QUERY.exec(text)?.[1] ?? null;
  const candidates = React.useMemo<readonly Candidate[]>(() => {
    if (query === null) return [];
    const q = query.toLocaleLowerCase();
    const hit = (...labels: string[]) => q.length === 0 || labels.some((label) => label.toLocaleLowerCase().includes(q));
    return [
      ...members.filter((speaker) => hit(speaker.name)).map((speaker): Candidate => ({ kind: "member", speaker })),
      ...(hit(t("group.mention.everyone"), "all", "everyone") ? [{ kind: "all" } as const] : []),
      ...(hit(t("group.commodore"), "commodore") ? [{ kind: "commodore" } as const] : []),
    ];
  }, [query, members, t]);
  // 동작 칩이 앉아 있는 동안(그리고 동작만 받는 입력창에서는) 받는 이는 지휘관이다 — @ 목록을 열지 않는다.
  const popOpen = !popDismissed && candidates.length > 0 && seated === null && !board?.actionsOnly;
  const index = Math.min(popIndex, Math.max(0, candidates.length - 1));
  const working = snapshot.working;
  const empty = text.trim().length === 0;
  const uploading = attachments.some((attachment) => attachment.uploading);
  // 문면이 비어도 첨부가 있으면 보낼 말이다. 다만 「모두」 방송은 첨부를 싣지 않고 사령관은 말을 기록으로 남기므로 둘에게는 문면이 있어야 한다.
  // 인용은 문면 끝 줄로 합성되는 글이라 「모두」·사령관에게도 실린다.
  const blank = empty && !hasQuotes && (attachments.length === 0 || target?.kind === "all" || target?.kind === "commodore");
  const stopMode = empty && attachments.length === 0 && !hasQuotes && working.length > 0 && seated === null;

  // 결과 안내는 다음 행동까지 남는다 — 새로 쓰기 시작하면 걷는다.
  const edit = (value: string) => {
    setText(value);
    setPopIndex(0);
    setPopDismissed(false);
    if (notice) setNotice(null);
  };

  const choose = (candidate: Candidate) => {
    setTarget(candidate);
    setText(draft.read().text.replace(MENTION_QUERY, (match) => (match.startsWith("@") ? "" : match.slice(0, 1))));
    setPopIndex(0);
    inputRef.current?.focus();
  };

  const targetName = (candidate: Candidate): string =>
    candidate.kind === "member" ? candidate.speaker.name : candidate.kind === "all" ? t("group.mention.everyone") : t("group.commodore");

  const nameOf = (targetId: string): string => {
    if (targetId.startsWith("commodore:")) return t("group.commodore");
    if (targetId === snapshot.rootOperationId) return commander?.name ?? t("group.commander");
    return snapshot.participants.find((participant) => participant.speaker.operationId === targetId)?.speaker.name ?? t("group.member");
  };

  const describeSend = (result: GroupWriteResult, sentTo: Candidate | null): Notice | null => {
    const skipped = result.targets.filter((entry) => entry.outcome === "skipped").map((entry) => nameOf(entry.targetId));
    const failed = result.targets.filter((entry) => entry.outcome === "failed").map((entry) => nameOf(entry.targetId));
    const lines: string[] = [];
    if (failed.length > 0) lines.push(t("group.notice.failed", { names: failed.join(", ") }));
    if (skipped.length > 0) lines.push(t("group.notice.skipped", { names: skipped.join(", ") }));
    if (result.commanderNotified === false && sentTo?.kind === "member") lines.push(t("group.notice.noCopy", { name: sentTo.speaker.name }));
    if (lines.length > 0) return { tone: "warn", text: lines.join(" ") };
    // 사령관에게 간 말은 이 대화가 아니라 사령관 기록에 선다 — 어디로 갔는지 말해 둔다.
    if (sentTo?.kind === "commodore") return { tone: "info", text: t("group.notice.toCommodore") };
    return null;
  };

  const pickImages = () => {
    setMenuOpen(false);
    attachmentInput.pick();
  };

  const pickTarget = () => {
    setMenuOpen(false);
    // 「@」를 넣으면 멘션 목록이 열린다 — 손으로 「@」를 친 것과 같은 길이다.
    edit(text.length === 0 || /\s$/u.test(text) ? `${text}@` : `${text} @`);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  /**
   * 보드 동작의 결과를 입력창에 옮긴다. 초안은 그 동작이 덧붙일 말로 가져간 경우(`consumed`)에만, 그때의 판 그대로일 때만 걷는다 —
   * 말을 받지 않는 동작(완료·인계·압축)은 쓰던 초안을 건드리지 않고, 보내는 사이(또는 칸이 열린 사이) 새로 쓴 말은 남는다.
   * 칸이 이어받으면(held) 가져간 판을 기억해 두었다가, 칸이 같은 동작으로 끝낼 때 그 판만 걷는다.
   */
  const settle = (result: GroupBoardRunResult, consumed: BoardConsumed | null) => {
    const current = draft.read();
    const done = result.outcome === "done" && consumed !== null;
    draft.update({
      ...(done && current.textRevision === consumed.revision ? { text: "" } : {}),
      ...(done && current.mode === consumed.mode ? { mode: null } : {}),
      held: result.outcome === "held" ? consumed ?? current.held : consumed !== null && current.held?.mode === consumed.mode ? null : current.held,
      notice: result.notice ? { tone: result.notice.tone, text: local(result.notice.text) } : null,
    });
  };

  /** 칸이 끝낸 동작 — 그 동작을 제출할 때 기억한 판이 있으면 그 초안만 걷는다. */
  const settlePanel = (result: GroupBoardRunResult) => {
    const held = draft.read().held;
    settle(result, result.actionId !== undefined && held?.mode === result.actionId ? held : null);
  };

  const runBoard = async (action: GroupBoardAction, context: string, consumes: boolean) => {
    if (!board || draft.read().busy) return;
    const consumed: BoardConsumed | null = consumes ? { mode: action.id, revision: draft.read().textRevision } : null;
    setBusy(true);
    setNotice(null);
    try {
      settle(await board.run(action.id, context), consumed);
    } catch {
      setNotice({ tone: "warn", text: t("group.board.failed") });
    } finally {
      setBusy(false);
    }
  };

  const submitBoard = (action: GroupBoardAction) => {
    if (attachments.length > 0) { setNotice({ tone: "warn", text: t("group.board.noImages") }); return; }
    if (action.unavailable) { setNotice({ tone: "warn", text: local(action.unavailable) }); return; }
    if (action.context?.required && empty) { setNotice({ tone: "warn", text: t("group.board.required", { label: local(action.label) }) }); inputRef.current?.focus(); return; }
    void runBoard(action, text.trim(), true);
  };

  /**
   * 제안 칩 — 덧붙일 말을 받으면 입력창에 앉히고, 아니면 곧 실행한다(확인이 걸리면 두 번 눌러). 앉은 칩을 다시 누르면 Enter 와 같이
   * 제출한다 — 해제는 입력창 칩의 × 와 빈 입력의 Backspace 가 맡는다.
   */
  const pressChip = (action: GroupBoardAction) => {
    if (busy || action.unavailable) return;
    setNotice(null);
    if (action.context) {
      if (seated?.id === action.id) { arm(null); submitBoard(action); return; }
      arm(null);
      draft.update({ mode: action.id, ...(draft.read().text.trim().length === 0 && action.context.prefill ? { text: action.context.prefill, textRevision: draft.read().textRevision + 1 } : {}) });
      window.requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      return;
    }
    if (action.confirm && armed !== action.id) { arm(action.id); return; }
    arm(null);
    void runBoard(action, "", false);
  };
  /** 누르고 있는 키의 반복은 누름으로 세지 않는다 — 두 번 눌러야 하는 칩이 길게 누른 한 번으로 실행되지 않게. */
  const ignoreRepeat = (event: React.KeyboardEvent<HTMLElement>) => { if ((event.key === "Enter" || event.key === " ") && event.repeat) event.preventDefault(); };

  const pressCompact = async () => {
    const compact = board?.compact;
    if (!compact || compact.sessions === 0 || busy) return;
    if (armed !== "compact") { arm("compact"); return; }
    arm(null);
    setMenuOpen(false);
    setBusy(true);
    setNotice(null);
    try {
      settle(await compact.run(), null);
    } catch {
      setNotice({ tone: "warn", text: t("group.board.failed") });
    } finally {
      setBusy(false);
    }
  };

  /** 허용을 기다리는 참여자 — 대화의 요청 카드로 데려간다. */
  const toCards = () => {
    const card = wrapRef.current?.parentElement?.querySelector<HTMLElement>(".group-card:not(.is-hold)");
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  };

  const submit = async () => {
    if (seated) { submitBoard(seated); return; }
    if (board?.actionsOnly) { setNotice({ tone: "info", text: t("group.board.pick") }); return; }
    if (draft.read().busy || !actions || blank || uploading) return;
    const sentTo = target;
    const sentText = text;
    const sentRevision = draft.read().textRevision;
    const sentAttachments = draft.attachments.read().items;
    const sentKeys = sentAttachments.map((attachment) => attachment.key);
    const ids = draft.attachments.ids();
    const sentQuotes = quoteStore.read();
    if (empty && ids.length === 0 && sentQuotes.length === 0) return;
    if (ids.length > 0 && (sentTo?.kind === "all")) {
      setNotice({ tone: "warn", text: t("group.notice.attachOneTarget", { name: targetName(sentTo) }) });
      return;
    }
    const groupTarget: GroupMessageTarget = !sentTo ? { kind: "commander" }
      : sentTo.kind === "member" ? { kind: "member", operationId: sentTo.speaker.operationId! }
        : sentTo.kind === "all" ? { kind: "all" } : { kind: "commodore" };
    setBusy(true);
    setNotice(null);
    try {
      const result = await actions.send(groupTarget, composeQuotedPrompt(sentText.trim(), composerQuoteValues(sentQuotes)), ids.length > 0 ? ids : undefined);
      // 일부만 닿았어도 보낸 말이다 — 보낸 스냅샷만 걷고, 기다리는 동안 새로 쓴 말은 남긴다.
      const current = draft.read();
      draft.attachments.releaseSent(sentKeys);
      quoteStore.releaseSent(sentQuotes.map((quote) => quote.key));
      draft.update({
        ...(current.textRevision === sentRevision ? { text: "" } : {}),
        target: current.target === sentTo ? null : current.target,
        notice: describeSend(result, sentTo),
      });
    } catch (error) {
      if (draft.attachments.noteSendFailure(error, ids) === "expired") return;
      const code = error instanceof Error ? error.message : "";
      setNotice({ tone: "warn", text: code === "attachment_budget_exceeded" ? ct("composer.attach.commodoreBudget") : /commodore_(?:inactive|disabled|stopping)/.test(code) ? t("group.notice.commodoreOff") : t("group.notice.failedSend") });
    } finally {
      setBusy(false);
    }
  };

  const stopAll = async () => {
    setStopOpen(false);
    if (!actions) return;
    setBusy(true);
    try {
      const result = await actions.stopAll();
      const stopped = result.targets.filter((entry) => entry.outcome === "stopped").map((entry) => nameOf(entry.targetId));
      const failed = result.targets.filter((entry) => entry.outcome === "failed").map((entry) => nameOf(entry.targetId));
      const lines = [
        ...(stopped.length > 0 ? [t("group.notice.stopped", { names: stopped.join(", ") })] : []),
        ...(failed.length > 0 ? [t("group.notice.stopFailed", { names: failed.join(", ") })] : []),
      ];
      setNotice({ tone: failed.length > 0 ? "warn" : "info", text: lines.length > 0 ? lines.join(" ") : t("group.notice.stopNone") });
    } catch {
      setNotice({ tone: "warn", text: t("group.notice.stopError") });
    } finally {
      setBusy(false);
    }
  };

  const stopOne = async (speaker: ConversationSpeaker) => {
    setStopOpen(false);
    try {
      await onStopOne(speaker);
    } catch {
      setNotice({ tone: "warn", text: t("group.notice.stopFailed", { names: speaker.name }) });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popOpen) {
      // 한글 조합 중의 Enter 는 조합을 끝내는 키다 — 조합이 끝난 뒤에 고른다.
      if ((event.key === "Enter" || event.key === "Tab") && event.nativeEvent.isComposing) {
        event.preventDefault();
        pendingPick.current = candidates[index]!;
        return;
      }
      // 덱 키 문법(SDK) — ↑↓ 이동, Enter·Tab 고르기, Esc 는 목록만 닫는다.
      if (composerDeckKeyDown(event, {
        rows: candidates,
        activeIndex: index,
        setActive: setPopIndex,
        pick: (at) => choose(candidates[at]!),
        dismiss: () => setPopDismissed(true),
      })) return;
    }
    if (event.key === "Backspace" && text.length === 0 && seated && !board?.fixed) { draft.update({ mode: null }); return; }
    if (event.key === "Backspace" && text.length === 0 && target && !seated) { setTarget(null); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const placeholder = !actions ? t("group.composer.unavailable")
    : seated?.context ? local(seated.context.placeholder)
      : board?.actionsOnly ? t("group.board.placeholder")
        : composerQuotePlaceholder(quotes.length, ct) ?? (target ? t("group.composer.placeholderTo", { name: targetName(target) }) : t(phone ? "group.composer.placeholderMobile" : "group.composer.placeholder"));
  const chips = board && !board.fixed ? board.suggestions : [];
  const note = board?.note ?? null;
  const showHint = !!board?.hint && (chips.length > 0 || !!board.fixed);
  const suggest = note !== null || chips.length > 0 || showHint;
  const chipClass = (action: GroupBoardAction) => `group-composer-action${action.emphasis === "primary" ? " is-primary" : action.emphasis === "review" ? " is-review" : ""}${armed === action.id ? " is-armed" : ""}`;
  const panel = board?.renderPanel ? board.renderPanel({ language: language === "ko" ? "ko" : "en", settle: settlePanel }) : null;
  const more = board && !board.fixed ? board.more ?? [] : [];

  return (
    <div ref={wrapRef} className="group-composer-wrap">
      {notice ? <ComposerNotice tone={notice.tone} text={notice.text} dismissLabel={ct("composer.notice.dismiss")} onDismiss={() => setNotice(null)} />
        : composerAttachmentNoticeText(attachmentSnap.notice, ct) ? <ComposerNotice tone="warn" text={composerAttachmentNoticeText(attachmentSnap.notice, ct) ?? ""} dismissLabel={ct("composer.notice.dismiss")} onDismiss={() => { draft.attachments.clearNotice(); inputRef.current?.focus(); }} /> : null}
      {popOpen ? (
        // '@' 덱 — 네 컴포저가 같이 쓰는 SDK 덱이다. 묶음은 「이 목표」(구성원 → 모두)와 「바깥 · 목표 밖 운영자」(사령관).
        <ComposerDeck id={deckId} label={t("group.mention.heading")} listbox contentKey={`${query ?? ""}:${candidates.length}`} className="group-composer-deck">
          {[
            { key: "objective", label: t("group.mention.objective"), rows: candidates.flatMap((candidate, at) => (candidate.kind === "commodore" ? [] : [{ candidate, at }])) },
            { key: "outside", label: t("group.mention.outside"), rows: candidates.flatMap((candidate, at) => (candidate.kind === "commodore" ? [{ candidate, at }] : [])) },
          ].filter((group) => group.rows.length > 0).map((group) => (
            <ComposerDeckGroup key={group.key} label={group.label}>
              {group.rows.map(({ candidate, at }) => (
                <ComposerDeckRow
                  key={candidate.kind === "member" ? speakerKey(candidate.speaker) : candidate.kind}
                  id={`${deckId}-${at}`}
                  active={at === index}
                  lead={candidate.kind === "member" ? <SpeakerMark speaker={candidate.speaker} size="sm" />
                    : candidate.kind === "all" ? <span className="cluster-member-glyph is-neutral group-chat-mark is-sm" aria-hidden="true">@</span>
                      : <SpeakerMark speaker={{ kind: "commodore", name: t("group.commodore") }} size="sm" />}
                  name={targetName(candidate)}
                  value={candidate.kind === "member" ? t("group.mention.member") : candidate.kind === "all" ? t("group.mention.everyoneSub") : t("group.mention.commodoreSub")}
                  onPick={() => choose(candidate)}
                  onHover={() => setPopIndex(at)}
                />
              ))}
            </ComposerDeckGroup>
          ))}
        </ComposerDeck>
      ) : null}
      {stopOpen && stopMode ? (
        <div className="group-composer-pop is-stop" role="menu" aria-label={t("group.stop.heading")}>
          {actions ? <button type="button" role="menuitem" className="group-composer-pop-row" onClick={() => { void stopAll(); }}>{t("group.stop.all")}</button> : null}
          {working.map((speaker) => (
            <button key={speakerKey(speaker)} type="button" role="menuitem" className="group-composer-pop-row" onClick={() => { void stopOne(speaker); }}>
              <SpeakerMark speaker={speaker} size="sm" />
              <span className="group-composer-pop-name">{t("group.stop.one", { name: speaker.name })}</span>
            </button>
          ))}
        </div>
      ) : null}
      {menuOpen ? (
        <ComposerMenu ref={menuRef} id={menuId} className="group-composer-plus-menu" aria-label={ct("composer.more")}>
          <ComposerMenuItem glyph={<AttachImageIcon />} onClick={pickImages}>{ct("composer.attach.image")}</ComposerMenuItem>
          {seated === null && !board?.actionsOnly ? (
            <ComposerMenuItem glyph="@" onClick={pickTarget}>{t("group.composer.pickTarget")}</ComposerMenuItem>
          ) : null}
          {more.length > 0 ? (
            <>
              <ComposerMenuSeparator />
              <ComposerMenuHeading>{t("group.board.more")}</ComposerMenuHeading>
              {more.map((action) => (
                <ComposerMenuItem
                  key={action.id}
                  className={armed === action.id ? "is-armed" : undefined}
                  glyph={BOARD_GLYPHS[action.glyph]}
                  sub={action.detail ? local(action.detail) : undefined}
                  data-board-arm={action.id}
                  aria-disabled={busy || !!action.unavailable || undefined}
                  title={action.unavailable ? local(action.unavailable) : seated?.id === action.id ? t("group.board.again", { label: local(action.label) }) : undefined}
                  onClick={() => { const arming = !action.context && action.confirm && armed !== action.id; pressChip(action); if (!arming) setMenuOpen(false); }}
                  onKeyDown={ignoreRepeat}
                >
                  {armed === action.id ? t("group.board.again", { label: local(action.label) }) : local(action.label)}
                </ComposerMenuItem>
              ))}
            </>
          ) : null}
          {board?.compact ? (
            <>
              <ComposerMenuSeparator />
              <ComposerMenuItem
                className={armed === "compact" ? "is-armed" : undefined}
                glyph={<CompactGlyph />}
                sub={t("group.board.compactSub")}
                data-board-arm="compact"
                aria-disabled={board.compact.sessions === 0 || busy || undefined}
                onClick={() => { void pressCompact(); }}
                onKeyDown={ignoreRepeat}
              >
                {board.compact.sessions === 0 ? t("group.board.compactNone") : armed === "compact" ? t("group.board.compactArmed", { count: String(board.compact.sessions) }) : t("group.board.compact")}
              </ComposerMenuItem>
            </>
          ) : null}
        </ComposerMenu>
      ) : null}
      {panel !== null ? <div className="group-composer-panel">{panel}</div> : null}
      {suggest ? (
        <div className="group-composer-suggest">
          {note ? (
            <span className={`group-composer-suggest-note is-${note.tone}`}>
              {note.tone === "lock" ? <LockGlyph /> : note.tone === "awaiting" ? <RequestGlyph /> : <span className="group-composer-suggest-dot" aria-hidden="true" />}
              <span>{local(note.text)}</span>
              {note.reveal ? <button type="button" className="group-composer-suggest-link" onClick={note.reveal.run}>{local(note.reveal.label)}</button> : null}
              {note.tone === "awaiting" ? <button type="button" className="group-composer-suggest-link" onClick={toCards}>{t("group.board.toCards")}</button> : null}
            </span>
          ) : null}
          {chips.map((action) => (
            <button
              key={action.id}
              type="button"
              className={chipClass(action)}
              aria-pressed={action.context ? seated?.id === action.id : undefined}
              aria-disabled={busy || !!action.unavailable || undefined}
              title={action.unavailable ? local(action.unavailable) : seated?.id === action.id ? t("group.board.again", { label: local(action.label) }) : undefined}
              onClick={() => pressChip(action)}
              onKeyDown={ignoreRepeat}
              data-board-arm={action.id}
              onBlur={disarmOnLeave(action.id)}
            >
              {BOARD_GLYPHS[action.glyph]}
              <span>{armed === action.id ? t("group.board.again", { label: local(action.label) }) : local(action.label)}</span>
              {action.detail && armed !== action.id ? <span className="group-composer-action-detail">{local(action.detail)}</span> : null}
            </button>
          ))}
          {showHint ? <span className="group-composer-suggest-hint">{local(board!.hint!)}</span> : null}
        </div>
      ) : null}
      <div
        className={`fc-composer-capsule group-composer${!actions ? " is-disabled" : ""}${attachments.length > 0 ? " has-attachments" : ""}${attachmentInput.dragOver ? " is-dragover" : ""}`}
        onDragOver={attachmentInput.onDragOver}
        onDragLeave={attachmentInput.onDragLeave}
        onDrop={attachmentInput.onDrop}
      >
        <ComposerQuoteTray store={quoteStore} t={ct} disabled={busy} onDone={() => inputRef.current?.focus()} />
        <ComposerAttachmentTray store={draft.attachments} t={ct} disabled={busy} />
        <span className="group-composer-plus-root" ref={plusRootRef}>
          <ComposerPlusButton
            ref={plusRef}
            aria-label={ct("composer.more")}
            title={ct("composer.more")}
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            disabled={!actions}
            onClick={() => setMenuOpen((open) => !open)}
          />
          {attachmentInput.fileInput}
        </span>
        {seated ? (
          <span className="group-composer-chip is-action">
            {BOARD_GLYPHS[seated.glyph]}
            <span>{local(seated.label)}</span>
            {board?.fixed ? null : <button type="button" className="group-composer-chip-x" aria-label={t("group.board.release", { label: local(seated.label) })} onClick={() => { draft.update({ mode: null }); inputRef.current?.focus(); }}>×</button>}
          </span>
        ) : board?.actionsOnly ? (
          <MentionChip label={commander?.name ?? t("group.commander")} />
        ) : target ? (
          <MentionChip
            label={targetName(target)}
            mark={target.kind === "member" ? <SpeakerMark speaker={target.speaker} size="sm" /> : undefined}
            removeLabel={t("group.composer.removeTarget", { name: targetName(target) })}
            onRemove={() => { setTarget(null); inputRef.current?.focus(); }}
          />
        ) : null}
        <textarea
          ref={inputRef}
          className="fc-composer-input group-composer-input"
          rows={1}
          value={text}
          disabled={!actions}
          maxLength={seated?.context?.maxLength}
          placeholder={placeholder}
          aria-label={t("group.composer.aria")}
          aria-autocomplete="list"
          aria-controls={popOpen ? deckId : undefined}
          aria-expanded={popOpen}
          aria-activedescendant={popOpen ? `${deckId}-${index}` : undefined}
          onChange={(event) => edit(event.target.value)}
          onPaste={attachmentInput.onPaste}
          onKeyDown={onKeyDown}
          onCompositionEnd={() => {
            const pick = pendingPick.current;
            pendingPick.current = null;
            if (pick) window.setTimeout(() => choose(pick), 0);
          }}
        />
        {stopMode ? (
          <ComposerSendButton className="is-stop" aria-label={t("group.composer.stop")} title={t("group.composer.stop")} aria-haspopup="menu" aria-expanded={stopOpen} onClick={() => setStopOpen((open) => !open)}>
            <span className="group-composer-stop-mark" aria-hidden="true" />
          </ComposerSendButton>
        ) : (
          <ComposerSendButton
            className={seated ? "group-composer-send-action" : undefined}
            aria-label={seated ? local(seated.label) : t("group.composer.send")}
            title={seated ? local(seated.label) : t("group.composer.send")}
            disabled={!actions || busy || uploading || (seated ? !!seated.unavailable : blank || !!board?.actionsOnly)}
            onClick={() => { void submit(); }}
          />
        )}
      </div>
    </div>
  );
}
