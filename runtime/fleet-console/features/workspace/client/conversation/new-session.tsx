import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind, OperationLaunchView } from "../../../execution/shared/operations/types.js";
import { fetchOperationCatalog, OPERATION_CATALOG_CHANGED_EVENT } from "../../../execution/client/operations.js";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { useMenuButtonKeyboard } from "../../../../core/client/src/chrome/components/use-menu-button-keyboard.js";
import type { ConsoleState, NewSessionTarget, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { closeNewSession, consumeNewSessionRejection, consumeNewSessionSeed, getState, openNewSession, requestLaunch } from "../../../../core/client/src/integration/store.js";
import { DirectoryBrowserModal } from "../../../../core/client/src/chrome/components/directory-browser-modal.js";
import { AttachImageIcon } from "../../../execution/client/composer-primitives/icons.js";
import { ComposerAttachmentTray, ComposerMenu, ComposerMenuItem, ComposerPlusButton } from "../../../execution/client/composer-primitives/attachment-surface.js";
import { composerAttachmentNoticeText, composerT } from "../../../execution/client/composer-primitives/messages.js";
import { composerDeckActiveIndex, composerDeckKeyDown } from "../../../execution/client/composer-primitives/deck.js";
import { createComposerAttachments } from "../../../execution/client/composer-primitives/attachment-store.js";
import { useComposerAttachmentInput, useComposerAttachmentSnapshot } from "../../../execution/client/composer-primitives/attachment-input.js";
import { launchProviderFromGroupId, launchProviderGlyph } from "../../../ai-gateway/client/components/launch-provider-glyphs.js";
import { discardLaunchAttachment, uploadLaunchAttachment } from "../../../execution/client/agent/api.js";
import { buildEffortDeck, findVariantLaunchKind, LAUNCH_PROMPT_MAX_CHARS, launchErrorMessageKey, resolveSelection } from "../../../execution/client/launch-selection.js";
import { resolveRowEffort } from "../../../execution/client/composer-primitives/effort-track.js";
import { OperationNameMark } from "../../../execution/client/components/operation-name-mark.js";
import { resolveOperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { useFeatureRegistry } from "../../../../core/client/src/integration/feature-registry.js";
import { notifyKeepOutSurfaceChanged } from "../../../../core/client/src/integration/floating-widget-layer.js";
import { readNewSessionSelection, writeNewSessionModelEffort, writeNewSessionTheater } from "./new-session-preferences.js";
import { readCommandInput, type NewSessionCommandInput } from "./new-session-commands.js";
import { deckOptionId, deckRows, markMatch, NewSessionDeck, type NewSessionDeckItem } from "./new-session-deck.js";
import { isMentionSelectable, mentionErrorMessageKey, mentionTargetName, readMentionToken, resolveMentionEntry, stripMentionToken, type MentionTarget } from "./new-session-mention.js";
import { useMentionSources } from "./new-session-mention-sources.js";
import { readLaunchStartSurface, supportsChatStart, withStartSurface, writeLaunchStartSurface } from "../../../execution/client/launch-start-surface.js";
import { ChatBubbleIcon, TerminalViewIcon } from "../../../execution/client/components/start-view-glyphs.js";
import { TheaterAvatar } from "../theater-avatar.js";
import { registerTheaterFromPath } from "../theater.js";
import { NewSessionPlayground } from "./new-session-playground.js";
import { NewSessionLaunchSlot, type NewSessionLaunchChoice } from "./new-session-launch-slot.js";
import { resolveNewSessionTheaterId } from "./new-session-entry.js";
import "./new-session.css";

/**
 * 본문 「새 세션 화면」 — 사이드바 맨 위 「+」·팔레트 「New Operation」·새 세션 단축키가 연다(승인안 ① A, v4).
 *
 * 여는 것만으로는 아무것도 만들지 않는다. 첫 메시지를 보내야 실행 의도(requestLaunch)로
 * 나가고, 실행은 Operations 화면이 맡는다 — 새 서버 계약은 없다. 가운데 「어디서」 카드와 아래 칩 줄 왼쪽은 Theater·시작 표면을,
 * 칩 줄 오른쪽은 모델·강도 칸(NewSessionLaunchSlot)을 둔다. 시작해 Operation 이 되면 그 컴포저는 지금 그대로다 — 이 칩들은 여기에만 선다.
 *
 * 컴포저는 '/'(첫 글자)로 실행 좌표 명령을, '@'로 보낼 곳(기존 Operation·사령관·부관 같은 플러그인 행선지)을 부른다. 목록은 네 컴포저가
 * 같이 쓰는 SDK 덱(퀵 런치바 문법 — 묶음 머리 옆 구분선)이고 캡슐 위에 뜬다(new-session-deck). S3 「캡슐 안 목록」은 이 덱으로
 * 대체됐다. 보낼 곳을 고르면 캡슐 앞에 알약이 서고, 그때 제출은
 * 새 Operation 실행이 아니라 그곳으로의 전달이다 — 부관의 답은 부관 자기 카드에 선다.
 *
 * Theater 가 없거나 새로 더할 때는 이 화면에서 「Theater 추가…」로 폴더를 고른다(사이드바 폴더 대화상자와 같은 등록 길). 더한 Theater 가
 * 곧 이번 세션의 Theater 다. 시작 보기의 기억은 '+' 입구의 것(launch-start-surface)을 그대로 잇는다.
 */
export function NewSessionColumn({ state, target, tools }: {
  readonly state: ConsoleState;
  readonly target: NewSessionTarget;
  readonly tools: ReactNode;
}) {
  const t = useT();
  const ct = composerT(useConsoleLocale());
  // 고른 Theater 가 사라졌거나(잊음) 처음부터 없으면 기본 규칙으로 다시 고른다 — Theater 가 하나도 없으면 null.
  const theater = state.theaters.find((candidate) => candidate.id === target.theaterId)
    ?? state.theaters.find((candidate) => candidate.id === resolveNewSessionTheaterId())
    ?? null;
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [startView, setStartView] = useState<OperationLaunchView>(readLaunchStartSurface);
  const [starting, setStarting] = useState(false);
  const [launchError, setLaunchError] = useState<{ readonly key: string; readonly shortenBy: number | null } | null>(null);
  const [theaterMenuOpen, setTheaterMenuOpen] = useState<"chip" | "card" | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [choice, setChoice] = useState<NewSessionLaunchChoice | null>(null);
  // '/'·'@' 목록 — 판정은 문면과 caret 에서 파생한다. 상태로 남는 것은 caret, 활성 행, 「이번 문면에서 Esc로 닫았다」뿐이다.
  const [caret, setCaret] = useState(0);
  const [deckActiveKey, setDeckActiveKey] = useState<string | null>(null);
  const [deckDismissed, setDeckDismissed] = useState(false);
  // 고른 보낼 곳(최대 하나). 고른 동안 '/'·'@'는 리터럴이다.
  const [mentionPick, setMentionPick] = useState<MentionTarget | null>(null);
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [targetGone, setTargetGone] = useState(false);
  const [sending, setSending] = useState(false);
  // 숨은 강도 게이트 — 트랙의 ✦와 `/effort` 목록의 문 행이 이 한 상태를 쓴다. "이번에 열었다"이지 기억되는 설정이 아니다.
  const [apexOpen, setApexOpen] = useState(false);
  const apexCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (apexCollapseTimerRef.current !== null) clearTimeout(apexCollapseTimerRef.current); }, []);
  const registry = useFeatureRegistry();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const deckId = useId();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentStore = useMemo(() => createComposerAttachments({
    upload: (file) => uploadLaunchAttachment(file),
    discard: (id) => discardLaunchAttachment(id),
  }), []);
  // 시작하지 않고 칸을 닫으면(또는 프롬프트 없는 실행으로 넘어가면) 넘기지 않은 칩의 미리보기·서버 파일을 거둔다.
  // dispose가 아니라 discardAll이다 — StrictMode의 재마운트가 같은 스토어를 다시 쓴다.
  // 아직 소비하지 않은 거절 슬롯의 칩도 같이 거둔다. 화면이 사라진 뒤 그 슬롯을 읽는 표면은 없다.
  useEffect(() => () => {
    const pending = getState().newSessionRejection;
    attachmentStore.discardAll(pending?.attachments ?? undefined);
    if (pending !== null) consumeNewSessionRejection();
  }, [attachmentStore]);
  const attachmentSnap = useComposerAttachmentSnapshot(attachmentStore);
  const attachmentInput = useComposerAttachmentInput(attachmentStore, {
    disabled: starting,
    pastedName: ct("composer.attach.pasted"),
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const plusRootRef = useRef<HTMLSpanElement | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  useMenuButtonKeyboard(plusRootRef, plusRef, menuRef, menuOpen, setMenuOpen);

  // 열 때마다, 그리고 설정에서 모델을 켜고 끄면 카탈로그를 새로 읽는다.
  useEffect(() => {
    let abort = new AbortController();
    const load = () => {
      abort.abort();
      abort = new AbortController();
      const signal = abort.signal;
      void fetchOperationCatalog(signal)
        .then((next) => { if (!signal.aborted) setCatalog(next); })
        .catch(() => { if (!signal.aborted) setCatalog((current) => current ?? []); });
    };
    load();
    window.addEventListener(OPERATION_CATALOG_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(OPERATION_CATALOG_CHANGED_EVENT, load);
      abort.abort();
    };
  }, []);

  // Theater 가 바뀌면 입력으로 돌아간다 — 다른 Theater 로 옮겨도 쓰던 문장은 그대로다.
  // 이미 열린 화면에서 새 세션 단축키를 다시 누르면(newSessionFocusRequest) 컴포저로 돌아온다.
  useEffect(() => { inputRef.current?.focus(); }, [theater?.id, state.newSessionFocusRequest]);


  // 거절은 이 화면의 컴포저로 돌아온다.
  useEffect(() => {
    const rejection = state.newSessionRejection;
    if (rejection === null) return;
    consumeNewSessionRejection();
    if (rejection.draft !== null) setPrompt(rejection.draft);
    if (rejection.attachments !== null) {
      if (rejection.errorCode === "attachment_not_found") attachmentStore.replaceFromSlot(rejection.attachments, rejection.errorCode);
      else attachmentStore.restore(rejection.attachments);
    }
    const key = rejection.errorCode === "attachment_not_found" ? null : launchErrorMessageKey(rejection.errorCode, rejection.shortenByChars);
    setLaunchError(key === null ? null : { key, shortenBy: rejection.shortenByChars });
    setStarting(false);
    inputRef.current?.focus();
  }, [attachmentStore, state.newSessionRejection]);

  const variantTarget = useMemo(() => (catalog ? findVariantLaunchKind(catalog) : null), [catalog]);
  const groups = variantTarget?.kind.variants ?? [];
  const remembered = useMemo(() => resolveSelection(groups, readNewSessionSelection()), [groups]);
  const launchChoice: NewSessionLaunchChoice = choice ?? { model: remembered.model, effort: remembered.effort };
  const chatAvailable = variantTarget !== null && supportsChatStart(variantTarget.kind);
  // 모델 밴드가 없는 실행 종류(설치 안 됨·로그인 필요 같은 사유 포함)는 「다른 시작」 카드에 선다 — 지운 '+' 메뉴의 직접 실행 칸을 잇는다.
  const directKinds = useMemo(() => (catalog ?? []).flatMap((plugin) => plugin.kinds
    .filter((kind) => !(variantTarget && plugin.id === variantTarget.pluginId && kind.id === variantTarget.kind.id))
    .filter((kind) => !kind.variants || kind.variants.length === 0)
    .map((kind) => ({ pluginId: plugin.id, kind }))), [catalog, variantTarget]);

  const text = prompt.trim();
  const tooLong = text.length > LAUNCH_PROMPT_MAX_CHARS;
  const uploading = attachmentSnap.uploading;
  // 문면이 비어도 첨부가 있으면 보낼 것이 있다 — 자식은 첨부 지시 줄만 받고, 말풍선에는 첨부만 선다.
  const hasContent = text.length > 0 || attachmentSnap.items.length > 0;
  const canStart = theater !== null && variantTarget !== null && launchChoice.model !== null && hasContent && !tooLong && !starting && !uploading;

  const pickTheater = (theaterId: string) => {
    setTheaterMenuOpen(null);
    // 고른 Theater 는 기억에 남는다 — 다음 새 세션(데스크톱·모바일)이 같은 Theater 로 시작한다.
    writeNewSessionTheater(theaterId);
    openNewSession({ theaterId });
  };

  const addTheater = () => {
    setTheaterMenuOpen(null);
    setFolderDialogOpen(true);
  };

  const confirmFolder = (path: string) => {
    setFolderDialogOpen(false);
    void registerTheaterFromPath(path).then((theaterId) => { if (theaterId !== null) pickTheater(theaterId); });
  };

  // ── '/'·'@' ────────────────────────────────────────────────────────────────
  const command: NewSessionCommandInput | null = mentionPick ? null : readCommandInput(prompt, caret);
  const mentionToken = mentionPick || command ? null : readMentionToken(prompt, caret);
  const sources = useMentionSources(state, registry.providers, mentionToken === null ? null : mentionToken.query);
  const mentionTarget = sources.latest(mentionPick);
  const rows = groups.flatMap((group) => group.rows);
  const selectedRow = rows.find((row) => (row.launch.model ?? null) === launchChoice.model) ?? null;
  const autoLabel = t("launchVariants.effort.auto");
  const viewLabelOf = (view: OperationLaunchView) => t(view === "chat" ? "conversation.newSession.viewChat" : "conversation.newSession.viewTerminal");

  const placeCaret = (next: string) => {
    setPrompt(next);
    setCaret(next.length);
    setDeckActiveKey(null);
    setDeckDismissed(false);
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.length, next.length);
    });
  };
  // 값을 골랐다 — 명령은 프롬프트가 아니므로 문면을 비운다.
  const finishCommand = () => placeCaret("");

  const setEffort = (effort: string | null) => {
    setChoice({ model: launchChoice.model, effort });
    writeNewSessionModelEffort(launchChoice.model, effort);
    if (apexCollapseTimerRef.current !== null) clearTimeout(apexCollapseTimerRef.current);
    const gated = new Set(selectedRow?.gatedEfforts ?? []);
    if (effort !== null && gated.has(effort)) {
      setApexOpen(true);
    } else if (apexOpen) {
      // 일상 단으로 내려오면 트랙과 같이 잠깐 뒤에 접는다 — 고른 단이 눈앞에서 사라지지 않게.
      apexCollapseTimerRef.current = setTimeout(() => { apexCollapseTimerRef.current = null; setApexOpen(false); }, 600);
    }
  };

  const deckItems: readonly NewSessionDeckItem[] = (() => {
    if (deckDismissed) return [];
    if (command?.kind === "commands") {
      const query = command.query.trim().toLowerCase();
      const all = [
        { id: "theater" as const, label: t("conversation.newSession.commandTheater"), value: theater ? theater.alias || theater.label : null, icon: <TheaterCommandGlyph /> },
        { id: "model" as const, label: t("conversation.newSession.commandModel"), value: selectedRow?.label ?? null, icon: <ModelCommandGlyph /> },
        { id: "effort" as const, label: t("conversation.newSession.commandEffort"), value: selectedRow ? (selectedRow.chips?.find((chip) => chip.id === launchChoice.effort)?.label ?? autoLabel) : null, icon: <EffortCommandGlyph /> },
        ...(chatAvailable ? [{ id: "view" as const, label: t("conversation.newSession.commandView"), value: viewLabelOf(startView), icon: startView === "chat" ? <ChatBubbleIcon /> : <TerminalViewIcon /> }] : []),
      ];
      const matches = all.filter((entry) => query.length === 0 || entry.id.startsWith(query) || entry.label.toLowerCase().includes(query));
      return [
        { kind: "section", key: "commands", label: t("conversation.newSession.deckCommands") },
        ...matches.map((entry): NewSessionDeckItem => ({
          kind: "row",
          key: `cmd-${entry.id}`,
          icon: entry.icon,
          name: markMatch(entry.label, entry.id.startsWith(query) ? "" : query),
          value: entry.value,
          token: `/${entry.id}`,
          pick: () => placeCaret(`/${entry.id} `),
        })),
      ];
    }
    if (command?.kind === "values") {
      const query = command.query.trim().toLowerCase();
      if (command.command === "theater") {
        return [
          { kind: "section", key: "theater", label: t("conversation.newSession.deckTheater") },
          ...state.theaters
            .filter((candidate) => (candidate.alias || candidate.label).toLowerCase().includes(query))
            .map((candidate): NewSessionDeckItem => ({
              kind: "row",
              key: `theater-${candidate.id}`,
              icon: <TheaterAvatar theaterId={candidate.id} size={16} label={candidate.alias || candidate.label} decorative />,
              name: markMatch(candidate.alias || candidate.label, query),
              checked: candidate.id === theater?.id,
              pick: () => { pickTheater(candidate.id); finishCommand(); },
            })),
        ];
      }
      if (command.command === "model") {
        return [
          { kind: "section", key: "model", label: t("conversation.newSession.deckModel") },
          ...groups.flatMap((group): NewSessionDeckItem[] => {
            const matched = group.rows.filter((row) => row.label.toLowerCase().includes(query));
            if (matched.length === 0) return [];
            // 공급자 띠는 글리프를 달고 스크롤을 따라 붙는다 — 좁힌 목록에서도 출처가 사라지지 않아 행마다 공급자 마크를 반복하지 않는다.
            const provider = launchProviderFromGroupId(group.id);
            return [
              {
                kind: "band",
                key: `band-${group.id}`,
                label: group.label,
                sticky: true,
                ...(provider ? { lead: <span className="operation-launch-provider-glyph">{launchProviderGlyph(provider)}</span>, className: `is-${provider}` } : {}),
              },
              ...matched.map((row): NewSessionDeckItem => ({
                kind: "row",
                key: `model-${group.id}-${row.id}`,
                name: <>{markMatch(row.label, query)}{row.starred ? <span className="new-session-deck-star" aria-hidden="true"> ★</span> : null}</>,
                checked: (row.launch.model ?? null) === launchChoice.model,
                pick: () => {
                  // 새 모델의 사다리에 없는 강도는 들고 갈 수 없다(모델 칩과 같은 규칙).
                  const model = row.launch.model ?? null;
                  const effort = resolveRowEffort(row, launchChoice.effort);
                  setChoice({ model, effort });
                  writeNewSessionModelEffort(model, effort);
                  finishCommand();
                },
              })),
            ];
          }),
        ];
      }
      if (command.command === "effort") {
        const deck = buildEffortDeck(selectedRow, launchChoice.effort, autoLabel, query, apexOpen);
        return [
          { kind: "section", key: "effort", label: t("conversation.newSession.deckEffort") },
          ...deck.options.map((option): NewSessionDeckItem => ({
            kind: "row",
            key: `effort-${option.id ?? "auto"}`,
            name: option.label,
            checked: option.checked,
            level: option.id ?? "auto",
            apex: option.apex,
            pick: () => { setEffort(option.id); finishCommand(); },
          })),
          // 문 행은 값이 아니라 트랙의 ✦다 — 골라도 목록과 문면이 그대로 남고, 트랙도 같이 펼쳐진다.
          ...(deck.showGateRow ? [{
            kind: "row" as const,
            key: "effort-gate",
            gate: true,
            icon: <span>{deck.gateOpen ? "‹" : "✦"}</span>,
            name: t(deck.gateOpen ? "launchVariants.effort.apexCollapse" : "launchVariants.effort.apexToggle", { tiers: deck.gatedNames }),
            pick: () => {
              if (apexCollapseTimerRef.current !== null) clearTimeout(apexCollapseTimerRef.current);
              setApexOpen(!deck.gateOpen);
              setDeckActiveKey("effort-gate");
            },
          }] : []),
        ];
      }
      if (!chatAvailable) return [];
      return [
        { kind: "section", key: "view", label: t("conversation.newSession.deckView") },
        ...(["terminal", "chat"] as const)
          .map((view) => ({ view, label: viewLabelOf(view), hint: t(view === "chat" ? "conversation.newSession.viewChatHint" : "conversation.newSession.viewTerminalHint") }))
          .filter((entry) => entry.view.startsWith(query) || entry.label.toLowerCase().includes(query))
          .map((entry): NewSessionDeckItem => ({
            kind: "row",
            key: `view-${entry.view}`,
            icon: entry.view === "chat" ? <ChatBubbleIcon /> : <TerminalViewIcon />,
            name: entry.label,
            value: entry.hint,
            checked: entry.view === startView,
            pick: () => { setStartView(entry.view); writeLaunchStartSurface(entry.view); finishCommand(); },
          })),
      ];
    }
    if (mentionToken) {
      const query = mentionToken.query;
      const pickMention = (picked: MentionTarget) => {
        const stripped = stripMentionToken(prompt, mentionToken).replace(/^\s+/, "");
        setMentionPick(picked);
        setMentionError(null);
        setTargetGone(false);
        placeCaret(stripped);
      };
      // 퀵 런치바 순서 — Operations(Theater 띠) → 시작 전(Theater 띠) → 플러그인 행선지(사령관·부관). 묶음 머리는 행이 있을 때만 선다.
      const operationRows = (groups: typeof sources.operationGroups, prefix: string) => groups.flatMap((group): NewSessionDeckItem[] => [
        { kind: "band", key: `${prefix}band-${group.theaterId ?? "none"}`, label: group.theaterLabel },
        ...group.entries.map((entry): NewSessionDeckItem => ({
          kind: "row",
          key: `op-${entry.operationId}`,
          icon: <OperationNameMark operation={{ id: entry.operationId, parentOperationId: entry.parentOperationId }} status={resolveOperationMarkVisual({ activity: entry.activity, operationId: entry.operationId, idleArrivalIds })} size={16} />,
          name: markMatch(entry.operationName, query),
          value: entry.activity === "running" ? t("conversation.newSession.mentionWorking") : null,
          // 입력을 기다리는 Operation 은 임의 문장이 그 응답을 오염시키므로 고를 수 없다(흐리게 서고 방향키가 건너뛴다).
          disabled: !isMentionSelectable(entry.activity),
          pick: () => pickMention({ kind: "operation", entry }),
        })),
      ]);
      const pluginItems = sources.pluginCategories.flatMap((category): NewSessionDeckItem[] => [
        { kind: "section", key: `plugin-${category.key}`, label: category.label, note: category.capabilityLabel },
        ...category.rows.map((row): NewSessionDeckItem => ({
          kind: "row",
          key: `plugin-${row.optionId}`,
          icon: row.renderMark?.() ?? null,
          name: markMatch(row.label, query),
          token: row.capabilityLabel,
          pick: () => pickMention({ kind: "plugin", row }),
        })),
      ]);
      return [
        { kind: "section", key: "operations", label: t("conversation.newSession.deckOperations") },
        ...operationRows(sources.operationGroups, ""),
        { kind: "section", key: "pending", label: t("conversation.newSession.deckPending") },
        ...operationRows(sources.pendingGroups, "pending-"),
        ...pluginItems,
      ];
    }
    return [];
  })();
  // 일치가 없어도 '@'·'/' 덱은 「일치 없음」 한 줄로 선다(퀵 런치바와 같다). 그때 Enter 는 막히지 않고 쓴 문장이 나간다.
  const deckOpen = !deckDismissed && (command !== null || mentionToken !== null);
  const allRows = deckRows(deckItems);
  const activeIndex = composerDeckActiveIndex(allRows, allRows.findIndex((row) => row.key === deckActiveKey));
  const activeRow = allRows[activeIndex] ?? null;
  const selectableRows = allRows.filter((row) => row.disabled !== true);
  // 목록은 떠다니는 위젯(부관)의 회피 영역이다. 화면의 로컬 상태로 여닫히므로 스토어 알림이 없다 — 열고 닫는 순간 직접 알려,
  // 위젯이 주기 재측정을 기다리는 동안 막 열린 목록 위에 서 있지 않게 한다. 칠한 뒤에 알려야 새 상자를 잰다.
  useEffect(() => { notifyKeepOutSurfaceChanged(); }, [deckOpen, deckItems.length]);
  // 행이 있는 목록만 Enter/Tab/제출을 가로챈다 — 매치가 없으면 "@3pm"·"/etc/hosts" 같은 문장이므로 Enter는 평소처럼 보낸다.
  const deckHasRows = deckOpen && selectableRows.length > 0;

  // composer.open(플러그인·부유 위젯)이 건넨 시드. 초안은 문면을 갈아치우고(보내지 않는다), 행선지는 '@'로 고른 것과 같다.
  useEffect(() => {
    if (state.newSessionSeed === null) return;
    const seed = consumeNewSessionSeed();
    if (seed === null) return;
    if (seed.draft !== null) placeCaret(seed.draft);
    setMentionError(null);
    setTargetGone(false);
    if (seed.mentionOperationId !== null) {
      const entry = resolveMentionEntry(getState(), sources.messageableTypesByPlugin, seed.mentionOperationId);
      setMentionPick(entry ? { kind: "operation", entry } : null);
    } else if (seed.mentionTarget !== null) {
      const address = seed.mentionTarget;
      const row = sources.allPluginRows.find((candidate) => candidate.pluginId === address.pluginId && candidate.targetId === address.targetId);
      setMentionPick(row ? { kind: "plugin", row } : null);
      // 사라진 행선지를 새 Operation 실행으로 조용히 바꾸지 않는다. 사람이 보낼 곳을 다시 고른다.
      if (!row) {
        setTargetGone(true);
        setMentionError("chrome.launch.mentionErrorTargetGone");
      }
    }
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.newSessionSeed]);

  const clearMention = () => {
    setMentionPick(null);
    setMentionError(null);
    setTargetGone(false);
    inputRef.current?.focus();
  };

  // 보낼 곳으로 전달한다. 성공하면 화면을 닫는다(보던 대화로 돌아간다). 실패는 문장·보낼 곳·칩을 지킨 채 사유만 싣는다.
  const deliver = (target: MentionTarget) => {
    if (sending || !hasContent || tooLong || uploading) return;
    if (target.kind === "plugin") {
      const plugin = registry.providers.find((candidate) => candidate.id === target.row.pluginId);
      if (!plugin?.messageMentionTarget) return;
      // 비-Operation 행선지는 첨부를 받지 않는다 — 조용히 빼면 그 이미지를 본다고 믿은 채 답을 읽는다.
      if (attachmentSnap.items.length > 0) {
        setMentionError("chrome.launch.errorMentionAttachments");
        return;
      }
      setSending(true);
      setMentionError(null);
      void plugin.messageMentionTarget(target.row.targetId, text)
        .then(() => {
          setSending(false);
          setPrompt("");
          setMentionPick(null);
          closeNewSession();
        })
        .catch((error: unknown) => {
          setSending(false);
          setMentionError(mentionErrorMessageKey(error instanceof Error ? error.message : null));
        });
      return;
    }
    const entry = target.entry;
    const plugin = registry.providers.find((candidate) => candidate.id === entry.pluginId);
    if (!plugin?.messageOperation) return;
    // 칩은 실행 대상 플러그인의 스토어에 올라갔다 — 다른 플러그인의 세션에는 실을 수 없다.
    if (attachmentSnap.items.length > 0 && entry.pluginId !== variantTarget?.pluginId) {
      setMentionError("chrome.launch.errorAttachmentUploadFailed");
      return;
    }
    const delivered = attachmentSnap.items.flatMap((item) => item.id !== null ? [{ id: item.id, key: item.key }] : []);
    setSending(true);
    setMentionError(null);
    void plugin.messageOperation(entry.operationId, text, delivered.map((item) => item.id))
      .then(() => {
        attachmentStore.releaseSent(delivered.map((item) => item.key));
        setSending(false);
        setPrompt("");
        setMentionPick(null);
        closeNewSession();
      })
      .catch((error: unknown) => {
        setSending(false);
        if (attachmentStore.noteSendFailure(error, delivered.map((item) => item.id)) === "expired") return;
        setMentionError(mentionErrorMessageKey(error instanceof Error ? error.message : null));
      });
  };

  const canSubmit = mentionTarget
    ? hasContent && !tooLong && !uploading && !sending && !targetGone && !deckHasRows
    : canStart && !deckHasRows;

  const submit = () => {
    if (deckHasRows) return;
    if (mentionTarget) {
      if (!targetGone) deliver(mentionTarget);
      return;
    }
    start();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    // 덱 키 문법(SDK) — ↑↓ 는 고를 수 있는 행만 돌고, Enter·Tab 은 고르기, Esc 한 번은 목록만 닫고 문면은 남긴다.
    // 목록이 없을 때의 Esc 는 화면 닫기(열의 처리기)로 올라간다.
    if (deckOpen && composerDeckKeyDown(event, {
      rows: allRows,
      activeIndex,
      setActive: (index) => setDeckActiveKey(allRows[index]?.key ?? null),
      pick: (index) => allRows[index]?.pick(),
      dismiss: () => setDeckDismissed(true),
    })) return;
    if (event.key === "Backspace" && mentionPick && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault();
      clearMention();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const start = () => {
    if (!canStart || !theater || !variantTarget) return;
    const variant: Record<string, string> = { prompt: text };
    if (launchChoice.model) variant.model = launchChoice.model;
    if (launchChoice.effort) variant.effort = launchChoice.effort;
    const launched = attachmentStore.handoff();
    if (launched.length > 0) variant.attachments = launched.map((item) => item.id).join(",");
    setLaunchError(null);
    attachmentStore.clearNotice();
    setStarting(true);
    writeNewSessionTheater(theater.id);
    requestLaunch({
      theaterId: theater.id,
      pluginId: variantTarget.pluginId,
      kind: variantTarget.kind,
      variant: withStartSurface(variant, variantTarget.kind, startView) ?? variant,
      ...(launched.length > 0 ? { attachments: launched } : {}),
    });
    // 새 Operation 이 서면 그 포커스가 이 화면을 걷는다(store 의 focusOperation). 그동안은 시작하는 중으로 선다.
  };

  const launchDirect = (pluginId: string | null, kind: OperationLaunchKind) => {
    if (!theater || kind.disabled) return;
    setLaunchError(null);
    attachmentStore.clearNotice();
    setStarting(true);
    requestLaunch({ theaterId: theater.id, pluginId, kind, variant: {} });
  };

  // 거절은 starting 을 풀어 이 타이머를 취소한다. 응답이 전혀 없을 때만 닫아, 시작하는 중에 가두지 않는다.
  useEffect(() => {
    if (!starting) return;
    const timer = window.setTimeout(() => closeNewSession(), 20_000);
    return () => window.clearTimeout(timer);
  }, [starting]);

  const toggleView = () => {
    const next: OperationLaunchView = startView === "chat" ? "terminal" : "chat";
    setStartView(next);
    writeLaunchStartSurface(next);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // 폴더 대화상자는 포털이라 그 키도 React 트리를 타고 이 열까지 올라온다 — 대화상자의 Esc 는 대화상자만 닫는다.
    if (theaterMenuOpen || folderDialogOpen) return;
    event.preventDefault();
    closeNewSession();
  };

  const theaterName = theater ? theater.alias || theater.label : "";
  const viewLabel = t(startView === "chat" ? "conversation.newSession.viewChat" : "conversation.newSession.viewTerminal");
  const adding = state.addingTheater;

  return (
    <div className="conversation-column new-session" onKeyDown={onKeyDown}>
      <div className="conversation-pill-row">
        <span className="new-session-title">{t("conversation.newSession.title")}</span>
        {tools}
      </div>
      <div className="new-session-body">
        <NewSessionPlayground />
        <div className="new-session-cards">
          <section className="new-session-section" aria-labelledby="new-session-where">
            <h2 className="new-session-heading" id="new-session-where">{t("conversation.newSession.where")}</h2>
            <div className="new-session-card">
              {theater ? (
                <div className="new-session-row is-current" aria-current="true">
                  <TheaterAvatar theaterId={theater.id} size={18} label={theaterName} decorative />
                  <span className="new-session-row-label">{theaterName}</span>
                  <span className="new-session-row-meta">{t("conversation.newSession.currentTheater")}</span>
                </div>
              ) : null}
              {state.theaters.length > 1 ? (
                <span className="new-session-anchor">
                  <button type="button" className="new-session-row" aria-haspopup="menu" aria-expanded={theaterMenuOpen === "card"} onClick={() => setTheaterMenuOpen(theaterMenuOpen === "card" ? null : "card")}>
                    <span className="new-session-row-label">{t("conversation.newSession.otherTheater")}</span>
                    <ChevronGlyph />
                  </button>
                  {theaterMenuOpen === "card" ? <TheaterMenu theaters={state.theaters} current={theater?.id ?? null} placement="below" onPick={pickTheater} onAdd={addTheater} onClose={() => setTheaterMenuOpen(null)} /> : null}
                </span>
              ) : null}
              <button type="button" className="new-session-row" onClick={addTheater} disabled={adding || starting} data-new-session-add-theater="card">
                <FolderPlusGlyph />
                <span className="new-session-row-label">{t("conversation.newSession.addTheater")}</span>
              </button>
            </div>
          </section>
          {directKinds.length > 0 ? (
            <section className="new-session-section" aria-labelledby="new-session-other">
              <h2 className="new-session-heading" id="new-session-other">{t("conversation.newSession.otherKinds")}</h2>
              <div className="new-session-card">
                {directKinds.map(({ pluginId, kind }) => (
                  <button key={`${pluginId}:${kind.id}`} type="button" className="new-session-row" disabled={kind.disabled === true || starting || theater === null} onClick={() => launchDirect(pluginId, kind)} data-operation-launch-kind={kind.id}>
                    <span className="new-session-row-label">{kind.title}</span>
                    {kind.disabledReason ? <span className="new-session-row-meta">{kind.disabledReason}</span> : null}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
      <div className="new-session-composer-zone">
        <div className={`new-session-composer${starting ? " is-starting" : ""}${attachmentInput.dragOver ? " is-dragover" : ""}`}onDragOver={attachmentInput.onDragOver} onDragLeave={attachmentInput.onDragLeave} onDrop={attachmentInput.onDrop}>
          {deckOpen ? (
            <NewSessionDeck
              id={deckId}
              label={t("conversation.newSession.deckAria")}
              items={deckItems}
              activeKey={activeRow?.key ?? null}
              emptyText={t("conversation.newSession.deckNoMatch")}
              onHover={setDeckActiveKey}
            />
          ) : null}
          <ComposerAttachmentTray store={attachmentStore} t={ct} disabled={starting} />
          <span className="new-session-plus-root" ref={plusRootRef}>
            {menuOpen ? (
              <ComposerMenu ref={menuRef} id={menuId} className="new-session-plus-menu" aria-label={ct("composer.more")}>
                <ComposerMenuItem glyph={<AttachImageIcon />} onClick={() => { setMenuOpen(false); attachmentInput.pick(); }}>{ct("composer.attach.image")}</ComposerMenuItem>
              </ComposerMenu>
            ) : null}
            <ComposerPlusButton ref={plusRef} aria-label={ct("composer.more")} title={ct("composer.more")} aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} disabled={starting} onClick={() => setMenuOpen((open) => !open)} />
            {attachmentInput.fileInput}
          </span>
          {mentionTarget ? (
            <span className="new-session-mention">
              <span className="new-session-mention-mark" aria-hidden="true">{mentionTarget.kind === "plugin"
                ? mentionTarget.row.renderMark?.() ?? "@"
                : <OperationNameMark operation={{ id: mentionTarget.entry.operationId, parentOperationId: mentionTarget.entry.parentOperationId }} status={resolveOperationMarkVisual({ activity: mentionTarget.entry.activity, operationId: mentionTarget.entry.operationId, idleArrivalIds })} size={16} />}</span>
              <span className="new-session-mention-name">{mentionTargetName(mentionTarget)}</span>
              <button type="button" className="new-session-mention-clear" onClick={clearMention} disabled={sending} aria-label={t("conversation.newSession.mentionClear")} title={t("conversation.newSession.mentionClear")}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </button>
            </span>
          ) : null}
          <textarea
            ref={inputRef}
            className="new-session-input"
            rows={1}
            value={prompt}
            disabled={starting || sending}
            onChange={(event) => {
              setPrompt(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setDeckDismissed(false);
              setDeckActiveKey(null);
              setMentionError(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onPaste={attachmentInput.onPaste}
            onKeyDown={onInputKeyDown}
            placeholder={mentionTarget ? t("conversation.newSession.mentionPlaceholder", { name: mentionTargetName(mentionTarget) }) : t("conversation.newSession.placeholder")}
            aria-label={t("conversation.newSession.promptLabel")}
            aria-autocomplete="list"
            aria-controls={deckOpen ? deckId : undefined}
            aria-expanded={deckOpen}
            aria-activedescendant={deckOpen && activeRow ? deckOptionId(deckId, activeRow) : undefined}
            spellCheck={false}
          />
          <button type="button" className="new-session-send" onClick={submit} disabled={!canSubmit} aria-label={t("conversation.newSession.start")} title={t("conversation.newSession.start")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5V3.8M4.2 7.4 8 3.6l3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        {/* 칩 줄 — 왼쪽은 어디서(Theater·시작 표면), 오른쪽은 무엇으로(모델·강도 칸). 좁은 폭 접힘은 new-session.css 의 @container 가 정한다. */}
        <div className="new-session-chips">
          <div className="new-session-chips-row">
            <span className="new-session-chips-lead">
              {theater ? (
                <span className="new-session-anchor">
                  <button type="button" className="new-session-chip" aria-haspopup="menu" aria-expanded={theaterMenuOpen === "chip"} disabled={starting} onClick={() => setTheaterMenuOpen(theaterMenuOpen === "chip" ? null : "chip")}>
                    <TheaterAvatar theaterId={theater.id} size={14} label={theaterName} decorative />
                    <span className="new-session-chip-label">{theaterName}</span>
                  </button>
                  {theaterMenuOpen === "chip" ? <TheaterMenu theaters={state.theaters} current={theater.id} placement="above" onPick={pickTheater} onAdd={addTheater} onClose={() => setTheaterMenuOpen(null)} /> : null}
                </span>
              ) : (
                <button type="button" className="new-session-chip" onClick={addTheater} disabled={adding} data-new-session-add-theater="chip">
                  <span className="new-session-chip-glyph" aria-hidden="true"><FolderPlusGlyph /></span>
                  <span className="new-session-chip-label">{t("conversation.newSession.addTheater")}</span>
                </button>
              )}
              {chatAvailable ? (
                <button type="button" className="new-session-chip" onClick={toggleView} disabled={starting} aria-label={t("conversation.newSession.viewAria", { view: viewLabel })} title={t("conversation.newSession.viewAria", { view: viewLabel })}>
                  <span className="new-session-chip-glyph" aria-hidden="true">{startView === "chat" ? <ChatBubbleIcon /> : <TerminalViewIcon />}</span>
                  <span className="new-session-chip-label">{viewLabel}</span>
                </button>
              ) : null}
            </span>
            <span className="new-session-chips-trail">
              {starting ? <span className="new-session-status" role="status">{t("conversation.newSession.starting")}</span> : null}
              {launchError ? <span className="new-session-status is-alert" role="alert">{t(launchError.key as Parameters<typeof t>[0], launchError.shortenBy === null ? undefined : { over: String(launchError.shortenBy) })}</span> : null}
              {mentionError ? <span className="new-session-status is-alert" role="alert">{t(mentionError as Parameters<typeof t>[0])}</span> : null}
              {tooLong ? <span className="new-session-status is-alert" role="alert">{t("chrome.launch.tooLong", { over: String(text.length - LAUNCH_PROMPT_MAX_CHARS) })}</span> : null}
              {composerAttachmentNoticeText(attachmentSnap.notice, ct) ? <span className="new-session-status is-alert" role="alert">{composerAttachmentNoticeText(attachmentSnap.notice, ct)}</span> : null}
              {/* 모델·강도 칸 — data-operation-launch-kind 는 실행 기능 투어(「Claude, 하나의 Gateway」)의 앵커다. */}
              <span className="new-session-launch-slot" {...(variantTarget ? { "data-operation-launch-kind": variantTarget.kind.id } : {})}>
                <NewSessionLaunchSlot groups={groups} value={launchChoice} onChange={setChoice} disabled={starting} apexOpen={apexOpen} onApexOpenChange={setApexOpen} />
              </span>
            </span>
          </div>
        </div>
      </div>
      <DirectoryBrowserModal open={folderDialogOpen} onCancel={() => setFolderDialogOpen(false)} onConfirm={confirmFolder} />
    </div>
  );
}

/** Theater 고르기 — 칩(위로)과 「다른 Theater…」 줄(아래로)이 같은 목록을 연다. 맨 아래 「Theater 추가…」. 즉시 열리고 Esc·바깥 클릭이 닫는다. */
function TheaterMenu({ theaters, current, placement, onPick, onAdd, onClose }: {
  readonly theaters: readonly TheaterInfo[];
  readonly current: string | null;
  readonly placement: "above" | "below";
  readonly onPick: (theaterId: string) => void;
  readonly onAdd: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 열릴 때 한 번만 — 닫기 콜백은 렌더마다 새로 오므로 ref 로 읽는다(의존성에 두면 렌더마다 포커스를 첫 항목으로 되돌린다).
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? ref.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
    const onDown = (event: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && event.target instanceof Node && anchor.contains(event.target)) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const anchor = ref.current?.parentElement?.querySelector<HTMLButtonElement>(":scope > button");
      onClose();
      anchor?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[at + 1] ?? items[0])?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[at - 1] ?? items[items.length - 1])?.focus();
    }
  };
  return (
    <div ref={ref} className={`new-session-menu is-${placement}`} role="menu" aria-label={t("conversation.newSession.theaterMenuAria")} onKeyDown={onKeyDown}>
      {theaters.map((theater) => (
        <button key={theater.id} type="button" role="menuitemradio" aria-checked={theater.id === current} className="new-session-menu-item" onClick={() => onPick(theater.id)}>
          <TheaterAvatar theaterId={theater.id} size={16} label={theater.alias || theater.label} decorative />
          <span className="new-session-row-label">{theater.alias || theater.label}</span>
          {theater.id === current ? <span className="new-session-menu-check" aria-hidden="true">✓</span> : null}
        </button>
      ))}
      <div className="new-session-menu-divider" role="separator" />
      <button type="button" role="menuitem" className="new-session-menu-item" onClick={onAdd} data-new-session-add-theater="menu">
        <FolderPlusGlyph />
        <span className="new-session-row-label">{t("conversation.newSession.addTheater")}</span>
      </button>
    </div>
  );
}

const ChevronGlyph = () => (
  <svg className="new-session-row-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.2 8 9.7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const FolderPlusGlyph = () => (
  <svg className="new-session-row-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.3h5.8v6.7h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M8 8v3M6.5 9.5h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
);

const TheaterCommandGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3v-5ZM8 8.5v5M2.5 5.5 8 8.5l5.5-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const ModelCommandGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /></svg>
);
const EffortCommandGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="5" cy="8" r="1.4" fill="currentColor" /><circle cx="11" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
);
