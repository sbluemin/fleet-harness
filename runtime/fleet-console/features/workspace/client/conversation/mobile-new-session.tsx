import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { OperationCatalogPlugin, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import { composerAttachmentNoticeText, composerT, createComposerAttachments, nextUltracodeIgnored, readUltracodeTokens, useComposerAttachmentSnapshot } from "@fleet-console/sdk/composer";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
import { closeMobileNewSession, consumeNewSessionRejection, consumeNewSessionSeed, getState, requestLaunch } from "../../../../core/client/src/integration/store.js";
import type { LaunchDraftAttachment } from "../../../../core/client/src/integration/types.js";
import { useViewMode } from "../../../../core/client/src/integration/view-mode-store.js";
import { discardLaunchAttachment, uploadLaunchAttachment } from "../../../execution/client/agent/api.js";
import { resolveRowEffort } from "../../../execution/client/components/effort-track.js";
import { findVariantLaunchKind, LAUNCH_DEFAULT_MODEL, LAUNCH_PROMPT_MAX_CHARS, launchErrorMessageKey, resolveSelection } from "../../../execution/client/launch-selection.js";
import { MobileNewSessionSheet } from "./mobile-new-session-sheet.js";
import { resolveNewSessionTheaterId } from "./new-session-entry.js";
import { isMentionSelectable, mentionErrorMessageKey, readMentionToken, resolveMentionEntry, stripMentionToken, type MentionTarget, type MentionToken } from "./new-session-mention.js";
import { useMentionSources } from "./new-session-mention-sources.js";
import { readNewSessionSelection, writeNewSessionModelEffort, writeNewSessionTheater } from "./new-session-preferences.js";

/**
 * 모바일 「새 대화」 — 폰의 새 세션 입구. 데스크톱 새 세션 화면과 같은 실행 의도(requestLaunch)·기억(new-session-preferences)·
 * 거절 칸(newSessionRejection)을 쓰고, 그리는 것은 시트(mobile-new-session-sheet)가 맡는다.
 *
 * 앱에 늘 마운트돼 있다 — 시트를 닫아도 쓰던 문장·칩이 이 컴포넌트 상태에 남아 다음 열림에서 이어진다(닫힘은 취소가 아니라 미룸).
 * 보내면 비운다. '@'로 기존 Operation·플러그인 행선지(부관 등)에 보낼 수 있고, 부관의 답은 부관 자기 카드에 선다.
 * 시작 보기 선택은 없다 — 폰의 새 대화는 채팅을 선언한 실행 종류면 늘 채팅으로 연다.
 */
export function MobileNewSession() {
  const state = useConsoleState();
  const t = useT();
  const ct = composerT(useConsoleLocale());
  const navigate = useNavigate();
  const registry = usePluginRegistry();
  const mobileLayout = useViewMode().effective === "mobile";
  const open = state.mobileNewSessionOpen && mobileLayout;

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const [theaterId, setTheaterId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(LAUNCH_DEFAULT_MODEL);
  const [effort, setEffort] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mentionToken, setMentionToken] = useState<MentionToken | null>(null);
  const [mentionPick, setMentionPick] = useState<MentionTarget | null>(null);
  const [mentionErrorKey, setMentionErrorKey] = useState<string | null>(null);
  const [pluginAddressUnavailable, setPluginAddressUnavailable] = useState(false);
  const [attachmentErrorKey, setAttachmentErrorKey] = useState<string | null>(null);
  const [rejection, setRejection] = useState<{ readonly code: string | null; readonly shortenBy: number | null } | null>(null);
  const [ultracodeIgnored, setUltracodeIgnored] = useState(false);
  // 시트 회차 — 열림마다 오른다. 대기 중인 멘션 전달 promise가 다음 회차를 닫거나 스테일 에러로 칠하지 못하게 한다.
  const epochRef = useRef(0);

  const attachmentStore = useMemo(() => createComposerAttachments({
    upload: (file) => uploadLaunchAttachment(file),
    discard: (id) => discardLaunchAttachment(id),
  }), []);
  const attachmentSnap = useComposerAttachmentSnapshot(attachmentStore);
  const attachments = attachmentSnap.items;

  const theaters = state.theaters ?? [];
  const target = useMemo(() => findVariantLaunchKind(catalog), [catalog]);
  const groups = target?.kind.variants ?? [];
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const selectedRow = rows.find((row) => row.launch.model === model) ?? null;
  const chatStart = target?.kind.launchViews?.includes("chat") === true;

  const sources = useMentionSources(state, registry.providers, mentionToken === null ? null : mentionToken.query);
  const { messageableTypesByPlugin, allPluginRows } = sources;
  const mentionTarget = useMemo(() => sources.latest(mentionPick), [sources, mentionPick]);
  const mentionTargetRef = useRef(mentionTarget);
  mentionTargetRef.current = mentionTarget;
  const mentionEntries = useMemo(() => sources.operationGroups.flatMap((group) => group.entries), [sources.operationGroups]);
  const pluginMentionRows = useMemo(() => sources.pluginCategories.flatMap((category) => category.rows), [sources.pluginCategories]);
  const mentionDeckOpen = mentionToken !== null;
  // 행이 있는 덱만 제출을 막는다 — 매치가 없으면 "@3pm" 같은 프로즈 토큰이다.
  const deckHasRows = mentionDeckOpen && (mentionEntries.length + pluginMentionRows.length) > 0;

  const ultracodeTokens = useMemo(() => readUltracodeTokens(prompt), [prompt]);
  const ultracodeArmed = ultracodeTokens.length > 0 && !ultracodeIgnored;
  useEffect(() => {
    setUltracodeIgnored((ignored) => nextUltracodeIgnored(prompt, ignored));
  }, [prompt]);

  // 열릴 때마다 카탈로그를 새로 읽는다. 설정에서 모델을 켜고 끈 직후 열어도 목록이 실제와 어긋나지 않는다.
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void fetchOperationCatalog(abort.signal)
      .then((next) => { if (!abort.signal.aborted) setCatalog(next); })
      .catch(() => {});
    return () => abort.abort();
  }, [open]);

  // 열림 전이에서만 좌표를 기억에서 되읽는다. 쓰던 문장·칩은 이 컴포넌트 상태에 그대로 남아 이어진다.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!opening) return;
    epochRef.current += 1;
    const remembered = readNewSessionSelection();
    setTheaterId(resolveNewSessionTheaterId());
    setModel(remembered.model ?? LAUNCH_DEFAULT_MODEL);
    setEffort(remembered.effort);
    setSubmitting(false);
    setMentionToken(null);
    setMentionPick(null);
    setMentionErrorKey(null);
    setPluginAddressUnavailable(false);
    setAttachmentErrorKey(null);
    setRejection(null);
  }, [open]);

  // composer.open이 건넨 시드. 초안은 문면을 갈아치우고(남은 칩도 거둔다), 행선지는 '@'로 고른 것과 같다.
  useEffect(() => {
    if (!open || state.newSessionSeed === null) return;
    const seed = consumeNewSessionSeed();
    if (seed === null) return;
    epochRef.current += 1;
    if (seed.draft !== null || seed.mentionOperationId !== null) {
      attachmentStore.discardAll();
      setPrompt(seed.draft ?? "");
    }
    setMentionToken(null);
    setMentionErrorKey(null);
    setPluginAddressUnavailable(false);
    if (seed.mentionOperationId !== null) {
      const entry = resolveMentionEntry(getState(), messageableTypesByPlugin, seed.mentionOperationId);
      setMentionPick(entry ? { kind: "operation", entry } : null);
    } else if (seed.mentionTarget !== null) {
      const address = seed.mentionTarget;
      const row = allPluginRows.find((candidate) => candidate.pluginId === address.pluginId && candidate.targetId === address.targetId);
      setMentionPick(row ? { kind: "plugin", row } : null);
      if (!row) {
        // 사라진 행선지를 새 Operation 실행으로 조용히 바꾸지 않는다. 사용자가 주소를 다시 고른다.
        setPluginAddressUnavailable(true);
        setMentionErrorKey("chrome.launch.mentionErrorTargetGone");
      }
    }
  }, [allPluginRows, attachmentStore, messageableTypesByPlugin, open, state.newSessionSeed]);

  // 실행 거절은 이 시트로 돌아온다 — 문면·칩·사유를 되살린다.
  useEffect(() => {
    if (!open || state.newSessionRejection === null) return;
    const slot = state.newSessionRejection;
    consumeNewSessionRejection();
    if (slot.draft !== null) setPrompt(slot.draft);
    if (slot.attachments !== null) {
      if (slot.errorCode === "attachment_not_found") attachmentStore.replaceFromSlot(slot.attachments, slot.errorCode);
      else attachmentStore.restore(slot.attachments);
    }
    setRejection({ code: slot.errorCode, shortenBy: slot.shortenByChars });
    setSubmitting(false);
  }, [attachmentStore, open, state.newSessionRejection]);

  // 카탈로그가 도착하면 기억해 둔 조합을 실제 목록에 맞춘다.
  useEffect(() => {
    if (!open || groups.length === 0) return;
    const resolved = resolveSelection(groups, { model, effort });
    if (resolved.model !== model) setModel(resolved.model);
    if (resolved.effort !== effort) setEffort(resolved.effort);
  }, [open, groups, model, effort]);

  const updatePrompt = (nextPrompt: string, element: HTMLTextAreaElement) => {
    setPrompt(nextPrompt);
    setMentionErrorKey(null);
    setAttachmentErrorKey(null);
    setRejection(null);
    // 행선지를 들고 있는 동안 '@'는 리터럴로 남는다.
    if (mentionTarget) {
      setMentionToken(null);
      return;
    }
    setMentionToken(readMentionToken(nextPrompt, element.selectionStart ?? nextPrompt.length));
  };

  const pickMention = (picked: MentionTarget) => {
    if (mentionToken) setPrompt((current) => stripMentionToken(current, mentionToken));
    setMentionPick(picked);
    setPluginAddressUnavailable(false);
    setMentionErrorKey(null);
    setAttachmentErrorKey(null);
    setMentionToken(null);
    inputRef.current?.focus();
  };

  const clearMention = () => {
    setPluginAddressUnavailable(false);
    setMentionPick(null);
    setMentionErrorKey(null);
    inputRef.current?.focus();
  };

  const addAttachmentFiles = (files: readonly File[]) => {
    // 비-Operation 행선지는 첨부를 받지 않는다.
    if (mentionTargetRef.current?.kind === "plugin") {
      setAttachmentErrorKey("chrome.launch.attachmentNotSupported");
      return;
    }
    setAttachmentErrorKey(null);
    attachmentStore.add(files, (file) => file.name.trim().length > 0 ? file.name : ct("composer.attach.pasted"));
  };

  const removeAttachment = (key: string) => {
    attachmentStore.remove(key);
    setAttachmentErrorKey(null);
  };

  // 보낸 문장은 소비됐다 — 비우고 시트를 닫는다. 전달된 칩은 그 경로가 이미 정확히 걷었으면 남은 칩(전달 중 붙인 것)을 지킨다.
  const finishSubmission = (options: { readonly keepAttachments?: boolean } = {}) => {
    if (!options.keepAttachments) attachmentStore.handoff();
    setPrompt("");
    setMentionPick(null);
    setMentionToken(null);
    setMentionErrorKey(null);
    setAttachmentErrorKey(null);
    setRejection(null);
    setSubmitting(false);
    closeMobileNewSession();
  };

  const uploading = attachments.some((attachment) => attachment.uploading);
  const text = prompt.trim();
  const overLimit = text.length > LAUNCH_PROMPT_MAX_CHARS;
  // 문면이 비어도 첨부가 있으면 보낼 것이 있다 — 데스크톱 새 세션과 같은 규칙이다.
  const hasContent = text.length > 0 || attachments.length > 0;
  // 멘션 제출은 실행 좌표가 필요 없다 — 행선지가 그 자리를 대신한다.
  const canSubmit = hasContent && !overLimit && !submitting && !pluginAddressUnavailable && !deckHasRows && !uploading
    && (mentionTarget !== null || (!!theaterId && !!target && !!selectedRow));

  const submit = () => {
    if (!canSubmit) return;
    const epoch = epochRef.current;
    if (mentionTarget?.kind === "plugin") {
      const row = mentionTarget.row;
      const plugin = registry.providers.find((candidate) => candidate.id === row.pluginId);
      if (!plugin?.messageMentionTarget) return;
      if (attachments.length > 0) {
        setAttachmentErrorKey("chrome.launch.errorMentionAttachments");
        return;
      }
      setSubmitting(true);
      setMentionErrorKey(null);
      // 답은 플러그인이 자기 표면(부관 카드)에서 보여 준다.
      void plugin.messageMentionTarget(row.targetId, text)
        .then(() => { if (epochRef.current === epoch) finishSubmission(); })
        .catch((error: unknown) => {
          if (epochRef.current !== epoch) return;
          setSubmitting(false);
          const current = mentionTargetRef.current;
          if (current?.kind === "plugin" && current.row.optionId === row.optionId) {
            setMentionErrorKey(mentionErrorMessageKey(error instanceof Error ? error.message : null));
          }
        });
      return;
    }
    if (mentionTarget) {
      const entry = mentionTarget.entry;
      const plugin = registry.providers.find((candidate) => candidate.id === entry.pluginId);
      if (!plugin?.messageOperation) return;
      // 칩은 실행 대상 플러그인의 스토어에 올라갔다 — 다른 플러그인의 세션에는 실을 수 없다.
      if (attachments.length > 0 && entry.pluginId !== target?.pluginId) {
        setAttachmentErrorKey("chrome.launch.errorAttachmentUploadFailed");
        return;
      }
      setSubmitting(true);
      setMentionErrorKey(null);
      const delivered = attachments.flatMap((attachment) => attachment.id !== null ? [{ id: attachment.id, key: attachment.key }] : []);
      // 전달 성공 시 화면을 옮기지 않고 닫기만 한다. 실패는 초안·멘션·칩을 지킨 채 사유만 싣는다.
      void plugin.messageOperation(entry.operationId, text, delivered.map((attachment) => attachment.id))
        .then(() => {
          attachmentStore.releaseSent(delivered.map((attachment) => attachment.key));
          if (epochRef.current === epoch) finishSubmission({ keepAttachments: true });
        })
        .catch((error: unknown) => {
          if (epochRef.current !== epoch) return;
          setSubmitting(false);
          if (attachmentStore.noteSendFailure(error, delivered.map((attachment) => attachment.id)) === "expired") return;
          setMentionErrorKey(mentionErrorMessageKey(error instanceof Error ? error.message : null));
        });
      return;
    }
    if (!theaterId || !target || !selectedRow) return;
    const variant: Record<string, string> = { prompt: text };
    if (model) variant.model = model;
    if (effort) variant.effort = effort;
    // 폰의 새 대화는 채팅으로 연다. 채팅을 선언하지 않은 종류는 키를 생략해 터미널로 간다.
    if (chatStart) variant.viewMode = "chat";
    const launched: LaunchDraftAttachment[] = attachments.flatMap((attachment) => attachment.id !== null ? [{ id: attachment.id, name: attachment.name, previewUrl: attachment.previewUrl }] : []);
    if (launched.length > 0) variant.attachments = launched.map((attachment) => attachment.id).join(",");
    writeNewSessionTheater(theaterId);
    writeNewSessionModelEffort(model, effort);
    requestLaunch({ theaterId, pluginId: target.pluginId, kind: target.kind, variant, ...(launched.length > 0 ? { attachments: launched } : {}) });
    navigate("/operations");
    finishSubmission();
  };

  if (!open) return null;

  const attachmentNoticeText = composerAttachmentNoticeText(attachmentSnap.notice, ct);
  const rejectionKey = rejection === null || rejection.code === "attachment_not_found" ? null : launchErrorMessageKey(rejection.code, rejection.shortenBy);
  type Key = Parameters<typeof t>[0];
  // 상태 줄의 우선순위 — 상한 초과 · 첨부 · 멘션 전달 · 실행 거절.
  const message = overLimit ? t("chrome.launch.tooLong", { over: String(text.length - LAUNCH_PROMPT_MAX_CHARS) })
    : attachmentErrorKey ? t(attachmentErrorKey as Key)
    : attachmentNoticeText ? attachmentNoticeText
    : mentionErrorKey ? t(mentionErrorKey as Key)
    : rejectionKey ? t(rejectionKey as Key, rejection?.shortenBy == null ? undefined : { over: String(rejection.shortenBy) })
    : null;

  return (
    <MobileNewSessionSheet
      inputRef={inputRef}
      prompt={prompt}
      onPromptChange={updatePrompt}
      theaters={theaters}
      theaterId={theaterId}
      onTheater={(id) => { setTheaterId(id); writeNewSessionTheater(id); }}
      groups={groups}
      selectedRow={selectedRow}
      effort={effort}
      onModelRow={(row: OperationLaunchVariantRow) => {
        // 새 모델의 사다리에 없는 강도는 들고 갈 수 없다(모델 픽커와 같은 규칙).
        const rowModel = row.launch.model ?? null;
        const nextEffort = resolveRowEffort(row, effort);
        setModel(rowModel);
        setEffort(nextEffort);
        writeNewSessionModelEffort(rowModel, nextEffort);
      }}
      onEffort={(next) => { setEffort(next); writeNewSessionModelEffort(model, next); }}
      ultracodeArmed={ultracodeArmed}
      hasUltracodeWord={ultracodeTokens.length > 0}
      onUltracode={(on) => {
        // 켜기는 사람이 직접 친 것과 같다 — 문면 끝에 단어를 붙이거나, 이 초안에서 껐던 표식을 되살린다. 끄기는 단어를 남기고 무장만 푼다.
        if (!on) { setUltracodeIgnored(true); return; }
        if (ultracodeTokens.length > 0) { setUltracodeIgnored(false); return; }
        setPrompt(`${prompt}${prompt.length === 0 || /\s$/.test(prompt) ? "" : " "}ultracode`);
      }}
      attachments={attachments}
      attachmentStore={attachmentStore}
      attachmentT={ct}
      onAddFiles={addAttachmentFiles}
      onRemoveAttachment={removeAttachment}
      mentionDeckOpen={mentionDeckOpen}
      mentionEntries={mentionEntries}
      pluginMentionRows={pluginMentionRows}
      mentionTarget={mentionTarget}
      onPickMention={(picked) => { if (picked.kind === "plugin" || isMentionSelectable(picked.entry.activity)) pickMention(picked); }}
      onClearMention={clearMention}
      message={message}
      canSubmit={canSubmit}
      submitting={submitting}
      onSubmit={submit}
      onClose={closeMobileNewSession}
    />
  );
}
