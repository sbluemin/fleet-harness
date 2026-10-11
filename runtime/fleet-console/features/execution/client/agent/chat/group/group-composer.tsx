import type { ConversationSpeaker, GroupConversationActions, GroupMessageTarget, GroupTimelineSnapshot, GroupWriteResult } from "@fleet-console/sdk/conversation";
import { AttachImageIcon, COMPOSER_ATTACHMENT_MAX_BYTES, COMPOSER_MAX_ATTACHMENTS, isComposerAttachmentCandidate } from "@fleet-console/sdk/composer";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { useMenuButtonKeyboard } from "../../../../../../core/client/src/chrome/components/use-menu-button-keyboard.js";
import { discardLaunchAttachment, uploadLaunchAttachment } from "../../api.js";
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
 */
type Candidate =
  | { readonly kind: "member"; readonly speaker: ConversationSpeaker }
  | { readonly kind: "all" }
  | { readonly kind: "commodore" };

type Notice = { readonly tone: "info" | "warn"; readonly text: string };

/** 입력창에 붙은 이미지 — id 가 서기 전(업로드 중)에는 보내지 않는다. */
interface DraftAttachment {
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  readonly previewUrl: string;
  readonly uploading: boolean;
}

export interface GroupComposerProps {
  readonly snapshot: GroupTimelineSnapshot;
  readonly actions: GroupConversationActions | null;
  readonly language: ConsoleLocale | undefined;
  /** 한 명만 멈춘다 — 기존 실행 중 중지 경로. */
  readonly onStopOne: (speaker: ConversationSpeaker) => Promise<void>;
}

const MENTION_QUERY = /(?:^|\s)@([^\s@]*)$/u;

export function GroupComposer({ snapshot, actions, language, onStopOne }: GroupComposerProps) {
  const t = getGroupT(language);
  const [text, setText] = React.useState("");
  const textRevision = React.useRef(0);
  const [target, setTarget] = React.useState<Candidate | null>(null);
  const [popIndex, setPopIndex] = React.useState(0);
  const [popDismissed, setPopDismissed] = React.useState(false);
  const [stopOpen, setStopOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const pendingPick = React.useRef<Candidate | null>(null);
  const [attachments, setAttachments] = React.useState<readonly DraftAttachment[]>([]);
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  // 업로드 중에 뺀 칩 — 업로드가 끝나면 서버의 파일을 거둔다.
  const canceledKeys = React.useRef(new Set<string>());
  const [menuOpen, setMenuOpen] = React.useState(false);
  const plusRootRef = React.useRef<HTMLSpanElement | null>(null);
  const plusRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  useMenuButtonKeyboard(plusRootRef, plusRef, menuRef, menuOpen, setMenuOpen);
  const menuId = React.useId();

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
  const popOpen = !popDismissed && candidates.length > 0;
  const index = Math.min(popIndex, Math.max(0, candidates.length - 1));
  const working = snapshot.working;
  const empty = text.trim().length === 0;
  const uploading = attachments.some((attachment) => attachment.uploading);
  const stopMode = empty && attachments.length === 0 && working.length > 0;

  // 결과 안내는 다음 행동까지 남는다 — 새로 쓰기 시작하면 걷는다.
  const edit = (value: string) => {
    textRevision.current += 1;
    setText(value);
    setPopIndex(0);
    setPopDismissed(false);
    if (notice) setNotice(null);
  };

  const choose = (candidate: Candidate) => {
    textRevision.current += 1;
    setTarget(candidate);
    setText((value) => value.replace(MENTION_QUERY, (match) => (match.startsWith("@") ? "" : match.slice(0, 1))));
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

  const addFiles = React.useCallback((files: readonly File[]) => {
    const images = files.filter((file) => isComposerAttachmentCandidate(file));
    // 이미지가 하나도 없으면 아무 말도 하지 않는다 — 텍스트 붙여넣기·비이미지 선택은 조용히 지나간다.
    if (images.length === 0) return;
    let rejected: Notice | null = null;
    // 상태 갱신은 배치되므로 상한은 로컬 카운터로 센다.
    let count = attachmentsRef.current.length;
    for (const file of images) {
      if (count >= COMPOSER_MAX_ATTACHMENTS) {
        rejected = { tone: "warn", text: t("group.notice.attachLimit", { count: String(COMPOSER_MAX_ATTACHMENTS) }) };
        break;
      }
      if (file.size > COMPOSER_ATTACHMENT_MAX_BYTES) {
        rejected = { tone: "warn", text: t("group.notice.attachTooLarge", { mb: String(Math.round(COMPOSER_ATTACHMENT_MAX_BYTES / (1024 * 1024))) }) };
        continue;
      }
      count += 1;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      const name = file.name.length > 0 ? file.name : "pasted image";
      setAttachments((current) => [...current, { key, id: null, name, previewUrl, uploading: true }]);
      void uploadLaunchAttachment(file)
        .then(({ id }) => {
          if (canceledKeys.current.delete(key)) {
            void discardLaunchAttachment(id).catch(() => {});
            return;
          }
          setAttachments((current) => current.map((attachment) => (attachment.key === key ? { ...attachment, id, uploading: false } : attachment)));
        })
        .catch(() => {
          canceledKeys.current.delete(key);
          URL.revokeObjectURL(previewUrl);
          setAttachments((current) => current.filter((attachment) => attachment.key !== key));
          setNotice({ tone: "warn", text: t("group.notice.attachFailed") });
        });
    }
    setNotice(rejected);
  }, [t]);

  const removeAttachment = (key: string) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.key === key);
    if (!removed) return;
    if (removed.id !== null) void discardLaunchAttachment(removed.id).catch(() => {});
    else canceledKeys.current.add(key);
    URL.revokeObjectURL(removed.previewUrl);
    setAttachments((current) => current.filter((attachment) => attachment.key !== key));
    setNotice(null);
    inputRef.current?.focus();
  };

  // 다른 대화로 옮겨 가면 붙여 둔 이미지는 그 대화의 것이 아니다 — 거둔다.
  const rootId = snapshot.rootOperationId;
  React.useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.id !== null) void discardLaunchAttachment(attachment.id).catch(() => {});
      else canceledKeys.current.add(attachment.key);
      URL.revokeObjectURL(attachment.previewUrl);
    }
    attachmentsRef.current = [];
    setAttachments([]);
  }, [rootId]);

  const pickImages = () => {
    setMenuOpen(false);
    fileRef.current?.click();
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

  const submit = async () => {
    if (busy || !actions || empty || uploading) return;
    const sentTo = target;
    const sentText = text;
    const sentRevision = textRevision.current;
    const sentAttachments = attachmentsRef.current;
    const sentKeys = new Set(sentAttachments.map((attachment) => attachment.key));
    const ids = sentAttachments.map((attachment) => attachment.id).filter((id): id is string => id !== null);
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
      const result = await actions.send(groupTarget, sentText.trim(), ids.length > 0 ? ids : undefined);
      // 일부만 닿았어도 보낸 말이다 — 보낸 스냅샷만 걷고, 기다리는 동안 새로 쓴 말은 남긴다.
      if (textRevision.current === sentRevision) setText("");
      setTarget((current) => current === sentTo ? null : current);
      // 보낸 이미지는 받는 세션에 묶였다 — 그 미리보기만 놓고 새로 붙인 이미지는 남긴다.
      for (const attachment of attachmentsRef.current) {
        if (sentKeys.has(attachment.key)) URL.revokeObjectURL(attachment.previewUrl);
      }
      attachmentsRef.current = attachmentsRef.current.filter((attachment) => !sentKeys.has(attachment.key));
      setAttachments((current) => current.filter((attachment) => !sentKeys.has(attachment.key)));
      setNotice(describeSend(result, sentTo));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setNotice({ tone: "warn", text: code === "attachment_budget_exceeded" ? t("group.notice.attachCommodoreBudget") : /commodore_(?:inactive|disabled|stopping)/.test(code) ? t("group.notice.commodoreOff") : t("group.notice.failedSend") });
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
      if (event.key === "ArrowDown") { event.preventDefault(); setPopIndex((index + 1) % candidates.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setPopIndex((index - 1 + candidates.length) % candidates.length); return; }
      if (event.key === "Escape") { event.preventDefault(); setPopDismissed(true); return; }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        // 한글 조합 중의 Enter 는 조합을 끝내는 키다 — 조합이 끝난 뒤에 고른다.
        if (event.nativeEvent.isComposing) pendingPick.current = candidates[index]!;
        else choose(candidates[index]!);
        return;
      }
    }
    if (event.key === "Backspace" && text.length === 0 && target) { setTarget(null); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const placeholder = !actions ? t("group.composer.unavailable")
    : target ? t("group.composer.placeholderTo", { name: targetName(target) }) : t("group.composer.placeholder");

  return (
    <div className="group-composer-wrap">
      {notice ? (
        <div className={`group-composer-notice is-${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="group-chat-link" onClick={() => setNotice(null)}>{t("group.notice.dismiss")}</button>
        </div>
      ) : null}
      {popOpen ? (
        <div className="group-composer-pop" role="listbox" aria-label={t("group.mention.heading")}>
          {candidates.map((candidate, at) => {
            const previous = candidates[at - 1];
            const heading = candidate.kind === "member" && previous === undefined ? t("group.mention.members")
              : candidate.kind === "commodore" ? t("group.mention.outside") : null;
            return (
              <React.Fragment key={candidate.kind === "member" ? speakerKey(candidate.speaker) : candidate.kind}>
                {heading ? <div className="group-composer-pop-heading">{heading}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={at === index}
                  className="group-composer-pop-row"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(candidate)}
                >
                  {candidate.kind === "member" ? <SpeakerMark speaker={candidate.speaker} size="sm" />
                    : candidate.kind === "all" ? <span className="cluster-member-glyph is-neutral group-chat-mark is-sm" aria-hidden="true">@</span>
                      : <SpeakerMark speaker={{ kind: "commodore", name: t("group.commodore") }} size="sm" />}
                  <span className="group-composer-pop-name">{targetName(candidate)}</span>
                  <span className="group-composer-pop-sub">
                    {candidate.kind === "member" ? t("group.mention.member") : candidate.kind === "all" ? t("group.mention.everyoneSub") : t("group.mention.commodoreSub")}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
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
        <div ref={menuRef} id={menuId} className="group-composer-pop is-plus" role="menu" aria-label={t("group.composer.more")}>
          <button type="button" role="menuitem" className="group-composer-pop-row" onClick={pickImages}>
            <span className="group-composer-pop-glyph" aria-hidden="true"><AttachImageIcon /></span>
            <span className="group-composer-pop-name">{t("group.composer.attachImage")}</span>
          </button>
          <button type="button" role="menuitem" className="group-composer-pop-row" onClick={pickTarget}>
            <span className="group-composer-pop-glyph is-at" aria-hidden="true">@</span>
            <span className="group-composer-pop-name">{t("group.composer.pickTarget")}</span>
          </button>
        </div>
      ) : null}
      <div className={`group-composer${!actions ? " is-disabled" : ""}${attachments.length > 0 ? " has-attachments" : ""}`}>
        {attachments.length > 0 ? (
          <div className="group-composer-attachments" role="group" aria-label={t("group.composer.attachments")}>
            {attachments.map((attachment) => (
              <span key={attachment.key} className={`group-composer-attachment${attachment.uploading ? " is-uploading" : ""}`}>
                <img src={attachment.previewUrl} alt={attachment.name} />
                <button
                  type="button"
                  className="group-composer-attachment-remove"
                  onClick={() => removeAttachment(attachment.key)}
                  aria-label={t("group.composer.removeAttachment", { name: attachment.name })}
                  title={t("group.composer.removeAttachment", { name: attachment.name })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <span className="group-composer-plus-root" ref={plusRootRef}>
          <button
            ref={plusRef}
            type="button"
            className="group-composer-plus"
            aria-label={t("group.composer.more")}
            title={t("group.composer.more")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            disabled={!actions}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              // 같은 파일을 연달아 고를 수 있게 값을 비운다 — 남기면 change 가 다시 오지 않는다.
              event.target.value = "";
              inputRef.current?.focus();
            }}
          />
        </span>
        {target ? (
          <span className="group-composer-chip">
            {target.kind === "member" ? <SpeakerMark speaker={target.speaker} size="sm" /> : null}
            <span>@{targetName(target)}</span>
            <button type="button" className="group-composer-chip-x" aria-label={t("group.composer.removeTarget", { name: targetName(target) })} onClick={() => { setTarget(null); inputRef.current?.focus(); }}>×</button>
          </span>
        ) : null}
        <textarea
          ref={inputRef}
          className="group-composer-input"
          rows={1}
          value={text}
          disabled={!actions}
          placeholder={placeholder}
          aria-label={t("group.composer.aria")}
          onChange={(event) => edit(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []).filter((file) => isComposerAttachmentCandidate(file));
            if (files.length === 0) return;
            // 이미지가 실린 붙여넣기만 가로챈다 — 텍스트 붙여넣기는 브라우저 기본 동작 그대로 흐른다.
            event.preventDefault();
            addFiles(files);
          }}
          onKeyDown={onKeyDown}
          onCompositionEnd={() => {
            const pick = pendingPick.current;
            pendingPick.current = null;
            if (pick) window.setTimeout(() => choose(pick), 0);
          }}
        />
        {stopMode ? (
          <button type="button" className="group-composer-send is-stop" aria-label={t("group.composer.stop")} title={t("group.composer.stop")} aria-haspopup="menu" aria-expanded={stopOpen} onClick={() => setStopOpen((open) => !open)}>
            <span className="group-composer-stop-mark" aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="group-composer-send" aria-label={t("group.composer.send")} title={t("group.composer.send")} disabled={!actions || empty || busy || uploading} onClick={() => { void submit(); }}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
