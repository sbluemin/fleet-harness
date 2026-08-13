import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { OperationCatalogPlugin, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";

import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import type { OperationSearchEntry } from "../operation-search.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { readQuickLaunchSelection, writeQuickLaunchModelEffort, writeQuickLaunchSelection } from "../quick-launch-preferences.js";
import { buildQuickLaunchMentionGroups, findVariantLaunchKind, isMentionSelectable, QUICK_LAUNCH_DEFAULT_MODEL, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchErrorMessageKey, quickLaunchMentionErrorMessageKey, readMentionToken, resolveSelection, stripMentionToken, type QuickLaunchMentionToken } from "../quick-launch.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { closeQuickLaunch, consumeQuickLaunchDraft, requestQuickLaunch, setActiveTheater, setQuickLaunchDockSuppressed, setQuickLaunchPinned } from "../store.js";
import { launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph } from "./launch-provider-glyphs.js";
import { EffortTrack, resolveRowEffort } from "./effort-track.js";

// 카드 폭은 팔레트(920px)보다 좁다 — 팔레트는 결과 목록을 담고, 여기는 한 문단을 담는다.
const CARD_WIDTH_FALLBACK = 760;
const POPOVER_GAP = 8;
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])";

type PopoverKind = "theater" | "model";

export function QuickLaunch() {
  const state = useConsoleState();
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const registry = usePluginRegistry();

  const cardRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const theaterChipRef = useRef<HTMLButtonElement | null>(null);
  const modelChipRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  // 컴포저 세션 에포크 — 열림 전이마다 오른다. 대기 중인 멘션 전달 promise가 다음 세션을
  // 닫거나(성공 콜백) 스테일 에러로 칠하는(실패 콜백) 것을 막는 유일한 신선도 기준이다.
  const composerEpochRef = useRef(0);

  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);
  const [prompt, setPrompt] = useState("");
  const [theaterId, setTheaterId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(QUICK_LAUNCH_DEFAULT_MODEL);
  const [effort, setEffort] = useState<string | null>(null);
  const [popover, setPopover] = useState<PopoverKind | null>(null);
  const [popoverLeft, setPopoverLeft] = useState<number | null>(null);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState<number | null>(null);
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // '@' 멘션: token은 덱이 열려 있는 동안의 조회 상태, target은 확정된 행선지(최대 1개).
  const [mentionToken, setMentionToken] = useState<QuickLaunchMentionToken | null>(null);
  const [mentionTarget, setMentionTarget] = useState<OperationSearchEntry | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionErrorKey, setMentionErrorKey] = useState<string | null>(null);
  // 접힘은 상태로 소유하되 실제 포커스에서만 파생시킨다 — 포커스와 별도로 관리하면 둘이 어긋나
  // "보이는데 못 쓰는" 바가 생긴다. 고정된 채로 화면을 열면 접힌 채 상주한다(포커스를 훔치지 않는다).
  const [collapsed, setCollapsed] = useState(() => state.quickLaunchPinned);

  // 설정처럼 실행이 할 일이 아닌 화면에서는 도킹을 접어 둔다. 고정 자체는 그대로라 화면을 벗어나면
  // 바가 되돌아오고, 그동안 Mod+J는 예전처럼 모달을 여닫는다(단축키를 죽이지 않는다).
  const dockSuppressed = location.pathname.startsWith("/settings");
  useEffect(() => {
    setQuickLaunchDockSuppressed(dockSuppressed);
  }, [dockSuppressed]);

  const pinned = state.quickLaunchPinned && !dockSuppressed;
  // 고정 중에는 컴포저가 상주한다 — 열림 여부가 아니라 배치가 이 표면의 존재를 결정한다.
  const open = state.quickLaunchOpen || pinned;
  const theaters = state.theaters ?? [];
  const target = useMemo(() => findVariantLaunchKind(catalog), [catalog]);
  const groups = target?.kind.variants ?? [];

  const activeTheater = theaters.find((candidate) => candidate.id === theaterId) ?? null;
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const selectedRow = rows.find((row) => row.launch.model === model) ?? null;

  // 멘션 가능 대상은 플러그인이 messageOperation과 함께 선언한 Operation 타입으로 한정된다.
  const messageableTypesByPlugin = useMemo(() => {
    const map = new Map<string, ReadonlySet<string>>();
    for (const plugin of registry.plugins) {
      if (plugin.messageOperation && (plugin.messageableOperationTypes?.length ?? 0) > 0) {
        map.set(plugin.id, new Set(plugin.messageableOperationTypes));
      }
    }
    return map;
  }, [registry.plugins]);
  const mentionGroups = useMemo(
    () => (mentionToken === null ? [] : buildQuickLaunchMentionGroups(state, messageableTypesByPlugin, mentionToken.query)),
    [mentionToken, state, messageableTypesByPlugin],
  );
  const mentionEntries = useMemo(() => mentionGroups.flatMap((group) => group.entries), [mentionGroups]);
  const selectableMentions = useMemo(() => mentionEntries.filter((entry) => isMentionSelectable(entry.activity)), [mentionEntries]);
  const activeMention = selectableMentions.length === 0
    ? null
    : selectableMentions[Math.min(mentionActiveIndex, selectableMentions.length - 1)] ?? null;
  const mentionDeckOpen = mentionToken !== null;
  // 행이 있는 덱만 Enter/Tab/제출을 가로챈다 — 매치가 없으면 "@3pm" 같은 프로즈 토큰이므로
  // Enter는 평소처럼 제출로 흐른다. 행이 있는 동안은 마우스 제출 버튼도 같은 계약으로 잠근다.
  const deckHasRows = mentionDeckOpen && mentionEntries.length > 0;

  // 열릴 때마다 카탈로그를 새로 읽는다. 설정에서 모델을 켜고 끈 직후 열어도 목록이 실제와 어긋나지 않는다.
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void fetchOperationCatalog(abort.signal)
      .then((next) => { if (!abort.signal.aborted) setCatalog(next); })
      .catch(() => {});
    return () => abort.abort();
  }, [open]);

  // 열림 전이에서만 1회 초기화한다(팔레트 seed와 같은 wasOpen 계약). 열려 있는 동안 Theater 목록이
  // 갱신돼도 사용자가 고른 값을 덮지 않는다.
  useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!opening) return;
    composerEpochRef.current += 1;
    const remembered = readQuickLaunchSelection();
    const rememberedTheater = remembered.theaterId !== null && theaters.some((candidate) => candidate.id === remembered.theaterId)
      ? remembered.theaterId
      : null;
    // 거절된 실행이 남긴 초안이 있으면 그것으로 되살린다(store가 되열 때 실어 준다).
    setPrompt(state.quickLaunchDraft ?? "");
    consumeQuickLaunchDraft();
    setPopover(null);
    setSubmitting(false);
    setMentionToken(null);
    setMentionTarget(null);
    setMentionActiveIndex(0);
    setMentionErrorKey(null);
    setTheaterId(rememberedTheater ?? state.activeTheaterId ?? theaters[0]?.id ?? null);
    setModel(remembered.model ?? QUICK_LAUNCH_DEFAULT_MODEL);
    setEffort(remembered.effort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.activeTheaterId, theaters]);

  // 카탈로그가 도착하면 기억해 둔 조합을 실제 목록에 맞춘다.
  // model/effort도 의존성에 둔다 — 재오픈이 bare opus를 잠깐 복원해도 정규화된 값으로 다시 맞춘다.
  useEffect(() => {
    if (!open || groups.length === 0) return;
    const resolved = resolveSelection(groups, { model, effort });
    if (resolved.model !== model) setModel(resolved.model);
    if (resolved.effort !== effort) setEffort(resolved.effort);
  }, [open, groups, model, effort]);

  // 모달일 때만 화면을 잠그고 포커스를 가져온다. 고정 상태의 목적은 정반대 — 뒤 화면을 계속
  // 쓰게 두는 것이므로 스크롤 잠금도 포커스 탈취도 하지 않는다.
  useEffect(() => {
    if (!open || pinned) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open, pinned]);

  // 접힌 동안 입력은 inert라 포커스를 받지 못한다. 먼저 펼침을 커밋하고, inert가 걷힌 다음 틱에
  // 포커스를 넣는다 — 같은 틱에 부르면 focus()가 조용히 실패해 바가 열리지 않은 것처럼 보인다.
  const expandAndFocus = useCallback(() => {
    setCollapsed(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // 고정 중 Mod+J: 접혀 있으면 펼쳐 포커스하고, 펼쳐져 있으면 물러난다. 접힘 자체는 포커스에서
  // 파생되므로 여기서는 포커스만 움직인다(에포크 0은 최초 마운트라 아무 일도 하지 않는다).
  const focusToggle = state.quickLaunchFocusToggle;
  const lastFocusToggleRef = useRef(focusToggle);
  useEffect(() => {
    if (focusToggle === lastFocusToggleRef.current) return;
    lastFocusToggleRef.current = focusToggle;
    if (!pinned) return;
    if (collapsed) expandAndFocus();
    else blurWithin(cardRef.current);
  }, [collapsed, expandAndFocus, focusToggle, pinned]);

  // 거절이 초안과 함께 돌아왔을 때, 고정 상태에는 "열림 전이"가 없어 초안 복원 경로가 없다.
  // 상주하는 컴포저는 초안이 도착하는 즉시 그것을 싣고 펼쳐야 한다.
  useEffect(() => {
    if (!pinned || state.quickLaunchDraft === null) return;
    setPrompt(state.quickLaunchDraft);
    consumeQuickLaunchDraft();
    expandAndFocus();
  }, [expandAndFocus, pinned, state.quickLaunchDraft]);

  // 팝오버는 자기 칩 아래에 선다. 바 기준 고정 좌표로 두면 두 칩이 같은 자리를 써서, 모델 목록이
  // Theater 칩 아래에 열린다 — 화면이 어느 칩을 눌렀는지 부정하는 셈이다.
  useLayoutEffect(() => {
    if (!popover) {
      setPopoverLeft(null);
      setPopoverMaxHeight(null);
      return;
    }
    const chip = (popover === "theater" ? theaterChipRef : modelChipRef).current;
    const bar = barRef.current;
    const pop = bar?.querySelector<HTMLElement>(".quick-launch-pop");
    if (!chip || !bar || !pop) return;
    const width = pop.getBoundingClientRect().width;
    // 칩이 오른쪽으로 밀려 있어도 팝오버는 카드 안에 머문다.
    setPopoverLeft(Math.max(0, Math.min(chip.offsetLeft, bar.clientWidth - width - POPOVER_GAP)));
    const safePadding = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-5")) || 0;
    // 도킹된 바에서 아래로 열면 남는 높이가 0에 수렴한다(바가 이미 화면 바닥에 있다). 고정 중에는
    // 멘션 덱과 같은 방향으로 위로 열고, 상한도 바 위쪽 여백으로 잰다.
    if (pinned) {
      setPopoverMaxHeight(Math.max(0, bar.getBoundingClientRect().top - safePadding - POPOVER_GAP));
      return;
    }
    const top = pop.getBoundingClientRect().top;
    setPopoverMaxHeight(Math.max(0, window.innerHeight - top - safePadding));
  }, [popover, prompt, groups.length, theaters.length, viewportEpoch, pinned]);

  useEffect(() => {
    if (!popover) return;
    const handleResize = () => setViewportEpoch((epoch) => epoch + 1);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [popover]);

  const updatePrompt = useCallback((nextPrompt: string, element: HTMLTextAreaElement) => {
    setPrompt(nextPrompt);
    autoGrow(element);
    setMentionErrorKey(null);
    // 멘션 보유 중 '@'는 리터럴로 남는다 — 행선지는 최대 1개(제품 계약). 해제 후에만 다시 깨어난다.
    if (mentionTarget) {
      setMentionToken(null);
      return;
    }
    setMentionToken(readMentionToken(nextPrompt, element.selectionStart ?? nextPrompt.length));
    setMentionActiveIndex(0);
  }, [mentionTarget]);

  const pickMention = useCallback((entry: OperationSearchEntry) => {
    const element = inputRef.current;
    if (mentionToken) {
      setPrompt((current) => stripMentionToken(current, mentionToken));
      // 제어 컴포넌트라 값 반영 뒤에야 높이를 잴 수 있다 — 다음 프레임에 줄어든 값으로 다시 잰다.
      if (element) requestAnimationFrame(() => autoGrow(element));
    }
    setMentionTarget(entry);
    setMentionToken(null);
    element?.focus();
  }, [mentionToken]);

  const clearMention = useCallback(() => {
    setMentionTarget(null);
    setMentionErrorKey(null);
    inputRef.current?.focus();
  }, []);

  const closePopover = useCallback(() => setPopover(null), []);

  // 제출이 끝나면 모달은 사라진다. 고정된 바는 남으므로 초안을 비우고 물러나야 다음 지시를 받는
  // 상태가 된다 — 비우지 않으면 방금 보낸 문장이 그대로 남아 아직 못 보낸 것처럼 읽힌다.
  const finishSubmission = useCallback(() => {
    if (!pinned) {
      closeQuickLaunch();
      return;
    }
    setPrompt("");
    setMentionTarget(null);
    setMentionErrorKey(null);
    setSubmitting(false);
    const element = inputRef.current;
    if (element) {
      element.style.height = "auto";
      element.blur();
    }
  }, [pinned]);

  const submit = useCallback(() => {
    const text = prompt.trim();
    // 상한을 넘긴 요청은 서버가 반드시 400으로 거절한다. 그대로 보내면 컴포저만 닫히고 초안이
    // 사라지므로, 확실히 실패할 요청으로는 넘기지 않는다.
    if (text.length === 0 || text.length > QUICK_LAUNCH_PROMPT_MAX_CHARS || submitting) return;
    // 행이 있는 덱이 열려 있는 동안은 어떤 경로(Enter·버튼 클릭)로도 제출하지 않는다 —
    // '@token' 리터럴이 프롬프트로 발사되는 것을 키보드 가로채기만으로는 못 막는다.
    if (deckHasRows) return;
    if (mentionTarget) {
      const plugin = registry.plugins.find((candidate) => candidate.id === mentionTarget.pluginId);
      if (!plugin?.messageOperation) return;
      setSubmitting(true);
      setMentionErrorKey(null);
      // 전달 성공 시 화면 전환 없이 닫기만 한다(제품 결정: 지금 보던 것을 떠나지 않는다).
      // 실패는 초안·멘션을 그대로 지킨 채 거절 사유만 바에 싣는다. 콜백은 세션 에포크를 검사한다 —
      // 느린 재기동 중 Escape로 닫고 다시 연 컴포저를 옛 promise가 닫거나 스테일 에러로 칠하면 안 된다.
      const epoch = composerEpochRef.current;
      void plugin.messageOperation(mentionTarget.operationId, text)
        .then(() => {
          if (composerEpochRef.current !== epoch) return;
          finishSubmission();
        })
        .catch((error: unknown) => {
          if (composerEpochRef.current !== epoch) return;
          setSubmitting(false);
          setMentionErrorKey(quickLaunchMentionErrorMessageKey(error instanceof Error ? error.message : null));
        });
      return;
    }
    if (!theaterId || !target || !selectedRow) return;
    setSubmitting(true);
    const variant: Record<string, string> = { prompt: text };
    if (model) variant.model = model;
    if (effort) variant.effort = effort;
    writeQuickLaunchSelection({ theaterId, model, effort, pinned });
    // 대상 Theater로 전환한 뒤 Operations로 이동한다. 실행은 그 화면이 자기 지오메트리·포커스 규율로
    // 수행한다(pendingOperationFocus와 같은 request/consume 계약) — 컴포저는 의도만 넘긴다.
    setActiveTheater(theaterId);
    requestQuickLaunch({ theaterId, pluginId: target.pluginId, kind: target.kind, variant });
    navigate("/operations");
    finishSubmission();
  }, [deckHasRows, effort, finishSubmission, mentionTarget, model, navigate, pinned, prompt, registry.plugins, selectedRow, submitting, target, theaterId]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (popover) {
        closePopover();
        (popover === "theater" ? theaterChipRef : modelChipRef).current?.focus();
        return;
      }
      // 고정 중 Escape는 닫기가 아니라 물러남이다 — 상주하기로 한 바를 Escape가 없애면, 사용자가
      // 방금 켠 배치를 스스로 부순 것처럼 읽힌다.
      if (pinned) {
        blurWithin(cardRef.current);
        return;
      }
      closeQuickLaunch();
      return;
    }
    if (event.key === "Tab" && !pinned) trapFocus(event, cardRef.current);
  }, [closePopover, pinned, popover]);

  // 접힘은 실제 포커스에서만 파생된다. 카드 안에서 카드 안으로 옮겨가는 포커스는 이탈이 아니다.
  const handleFocusIn = useCallback(() => {
    if (pinned) setCollapsed(false);
  }, [pinned]);

  const handleFocusOut = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (!pinned) return;
    const next = event.relatedTarget;
    if (next instanceof Node && cardRef.current?.contains(next)) return;
    // 접히면서 열린 팝오버를 남기면, 잘라내기가 돌아온 바 안에서 목록만 사라진 채 상태가 남는다.
    setPopover(null);
    setCollapsed(true);
  }, [pinned]);

  // 고정을 켜고 끄는 순간에도 쓰던 자리를 잃지 않는다 — 전환이 끝나면 입력은 그대로 이어진다.
  const togglePinned = useCallback(() => {
    setQuickLaunchPinned(!pinned);
    expandAndFocus();
  }, [expandAndFocus, pinned]);

  // 고정을 풀면 접힘이라는 상태 자체가 없어진다(모달은 접히지 않는다).
  useEffect(() => {
    if (!pinned) setCollapsed(false);
  }, [pinned]);

  const handleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionDeckOpen) {
      // 방향키는 선택 가능한 행만 순환한다 — awaiting은 dim이자 스킵 대상(제품 결정).
      if (deckHasRows && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        if (selectableMentions.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMentionActiveIndex((index) => {
          const bounded = Math.min(index, selectableMentions.length - 1);
          return (bounded + delta + selectableMentions.length) % selectableMentions.length;
        });
        return;
      }
      // 행이 있는 덱에서 Enter는 제출이 아니라 선택이다 — '@token'이 리터럴로 실려 나가는 오발사를 막는다.
      // Tab은 카드 포커스 트랩보다 먼저 소비하되, Shift+Tab(역방향 이동)은 트랩에 넘긴다.
      if (deckHasRows && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (activeMention) pickMention(activeMention);
        return;
      }
      if (event.key === "Escape") {
        // 카드의 Escape(컴포저 닫기)보다 먼저 덱만 닫는다.
        event.preventDefault();
        event.stopPropagation();
        setMentionToken(null);
        return;
      }
    }
    if (event.key === "Backspace" && mentionTarget && prompt.length === 0) {
      // 입력이 빈 상태의 Backspace가 멘션 해제를 전담한다 — 닫기 버튼은 없다(제품 결정).
      event.preventDefault();
      clearMention();
      return;
    }
    // Enter 제출 · Shift+Enter 개행 · IME 조합 중 Enter는 확정이지 제출이 아니다(Analyst 컴포저와 같은 계약).
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }, [activeMention, clearMention, deckHasRows, mentionDeckOpen, mentionTarget, pickMention, prompt.length, selectableMentions.length, submit]);

  if (!open) return null;

  const promptLength = prompt.trim().length;
  const overLimit = promptLength > QUICK_LAUNCH_PROMPT_MAX_CHARS;
  // 멘션 제출은 런치 좌표(theater/model/effort)가 필요 없다 — 행선지가 그 자리를 대신한다.
  // 행이 있는 덱이 열린 동안은 버튼도 잠근다(submit의 deckHasRows 가드와 같은 계약).
  const canSubmit = promptLength > 0 && !overLimit && !submitting && !deckHasRows
    && (mentionTarget !== null || (!!theaterId && !!target && !!selectedRow));
  const modelLabel = selectedRow?.label ?? t("chrome.quickLaunch.modelUnset");
  const rejectionKey = quickLaunchErrorMessageKey(state.quickLaunchError, state.quickLaunchErrorShortenBy);
  // 거절은 접힘보다 우선한다 — 사유를 실은 바가 시선을 뗐다고 접히면, 클릭 한 번으로 사라지는
  // 에러가 된다. 상한 초과 경고도 같은 이유로 바를 펼친 채 붙잡는다.
  const holdsMessage = rejectionKey !== null || mentionErrorKey !== null || overLimit;
  const showStrip = pinned && collapsed && !holdsMessage;
  const draftTrace = prompt.trim();
  // Prefer the selected model\'s provider mark. Falling back to the launch-kind
  // icon would keep showing Claude even when a Cursor/Codex/Kimi model is chosen.
  const selectedProvider = selectedRow
    ? (launchProviderFromGroupId(groups.find((group) => group.rows.some((row) => row.id === selectedRow.id))?.id ?? "")
      ?? launchProviderFromModelId(selectedRow.launch.model ?? selectedRow.id))
    : null;
  const kindIcon = selectedProvider
    ? launchProviderGlyph(selectedProvider)
    : (target
      ? registry.plugins.find((plugin) => plugin.id === target.pluginId)?.renderLaunchIcon?.(target.kind) ?? null
      : null);

  return (
    <div
      className={`quick-launch-overlay${pinned ? " is-pinned" : ""}`}
      onMouseDown={pinned ? undefined : (event) => { if (event.target === event.currentTarget) closeQuickLaunch(); }}
    >
      {/* 고정 상태는 모달이 아니다 — aria-modal을 벗어야 isBlockingDialogOpen이 이 표면을 차단으로
          읽지 않고, 뒤 화면의 단축키가 살아 있는 채로 공존한다(그것이 고정의 목적이다). */}
      <section
        ref={cardRef}
        className={`quick-launch-card${pinned ? " is-pinned" : ""}${showStrip ? " is-collapsed" : ""}${popover ? " has-popover" : ""}`}
        role={pinned ? "region" : "dialog"}
        aria-modal={pinned ? undefined : true}
        aria-label={t(pinned ? "chrome.quickLaunch.dockedRegion" : "chrome.quickLaunch.dialog")}
        tabIndex={pinned ? undefined : -1}
        onKeyDown={handleKeyDown}
        onFocus={handleFocusIn}
        onBlur={handleFocusOut}
        style={{ maxWidth: CARD_WIDTH_FALLBACK }}
      >
        {/* 접힌 한 줄 — 물러난 바가 남기는 유일한 컨트롤이다. 초안 자취를 싣고, 누르면 펼쳐진다.
            접힌 동안 아래 컨트롤은 inert라 Tab이 닿지 않으므로 이 버튼이 되돌아오는 통로다. */}
        {pinned ? (
          <button
            type="button"
            className="quick-launch-strip"
            onClick={expandAndFocus}
            aria-label={t("chrome.quickLaunch.expand")}
          >
            <span className="quick-launch-mark" aria-hidden="true">{activeTheater ? theaterInitials(activeTheater.label) : "—"}</span>
            {kindIcon ? (
              <span className={`quick-launch-kind-icon${selectedProvider ? ` is-${selectedProvider}` : ""}`} aria-hidden="true">
                {kindIcon}
              </span>
            ) : null}
            <span className={`quick-launch-strip-trace${draftTrace.length === 0 ? " is-idle" : ""}`}>
              {draftTrace.length === 0 ? t("chrome.quickLaunch.stripIdle") : draftTrace}
            </span>
            <kbd className="quick-launch-strip-key" aria-hidden="true">⌘J</kbd>
          </button>
        ) : null}

        {mentionDeckOpen ? (
          <div className="quick-launch-mention-deck theater-menu" role="listbox" id="quick-launch-mention-deck" aria-label={t("chrome.quickLaunch.mentionDeck")}>
            <p className="quick-launch-mention-category">
              <span>{t("chrome.quickLaunch.mentionCategoryOperations")}</span>
              <span className="quick-launch-mention-category-rule" aria-hidden="true" />
            </p>
            {mentionEntries.length === 0 ? (
              <p className="quick-launch-mention-empty">{t("chrome.quickLaunch.mentionNoMatch")}</p>
            ) : mentionGroups.map((group) => (
              <div key={group.theaterId ?? "__unassigned__"}>
                <p className="quick-launch-pop-band">{group.theaterLabel}</p>
                {group.entries.map((entry) => {
                  const selectable = isMentionSelectable(entry.activity);
                  const active = selectable && entry === activeMention;
                  return (
                    <button
                      key={entry.operationId}
                      id={`quick-launch-mention-${entry.operationId}`}
                      type="button"
                      className={`quick-launch-mention-row${selectable ? "" : " is-dim"}${active ? " is-active" : ""}`}
                      role="option"
                      aria-selected={active}
                      aria-disabled={selectable ? undefined : true}
                      tabIndex={-1}
                      // 클릭이 textarea 포커스를 뺏지 않아야 선택 직후 바로 타이핑이 이어진다.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { if (selectable) pickMention(entry); }}
                    >
                      <span className="quick-launch-mark" aria-hidden="true">{theaterInitials(entry.theaterLabel)}</span>
                      {entry.launchProvider ? (
                        <span className={`quick-launch-kind-icon is-${entry.launchProvider}`} aria-hidden="true">
                          {launchProviderGlyph(entry.launchProvider)}
                        </span>
                      ) : null}
                      <span className="quick-launch-mention-name">{entry.operationName}</span>
                      {entry.activity !== "idle" ? (
                        <span className={`operation-search-status operation-search-status--${entry.activity}`}>{entry.activity}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}

        {/* 접힌 동안 입력과 컨트롤은 inert다 — max-height:0만으로는 Tab이 보이지 않는 컨트롤에 닿는다
            (멘션 접힘이 쓰는 계약과 같다). */}
        <div className="quick-launch-field" inert={showStrip || undefined}>
          {mentionTarget ? (
            <span className="quick-launch-mention" title={mentionTarget.operationName}>
              {mentionTarget.launchProvider ? (
                <span className={`quick-launch-kind-icon is-${mentionTarget.launchProvider}`} aria-hidden="true">
                  {launchProviderGlyph(mentionTarget.launchProvider)}
                </span>
              ) : null}
              <span className="quick-launch-mention-label">{mentionTarget.operationName}</span>
            </span>
          ) : null}
          <textarea
            ref={inputRef}
            className="quick-launch-input"
            rows={1}
            value={prompt}
            onChange={(event) => updatePrompt(event.target.value, event.target)}
            onKeyDown={handleInputKeyDown}
            placeholder={mentionTarget
              ? t("chrome.quickLaunch.mentionPlaceholder", { name: mentionTarget.operationName })
              : t("chrome.quickLaunch.placeholder")}
            aria-label={t("chrome.quickLaunch.promptLabel")}
            aria-controls={mentionDeckOpen ? "quick-launch-mention-deck" : undefined}
            aria-activedescendant={mentionDeckOpen && activeMention ? `quick-launch-mention-${activeMention.operationId}` : undefined}
            spellCheck={false}
          />
        </div>

        <div className="quick-launch-bar" ref={barRef} inert={showStrip || undefined}>
          {/* 멘션이 확정되면 런치 3종(theater/model/effort)은 접히고 행선지 태그가 그 자리를 잇는다 —
              한 입력의 행선지는 하나라는 사실을 바가 배타적으로 말한다. */}
          {/* inert는 접힘 전환(360ms) 동안에도 하위 컨트롤을 포커스 대상에서 즉시 제외한다 —
              visibility는 전환이 끝나야 뒤집혀 그 창 동안 Tab이 보이지 않는 칩에 닿는다. */}
          <span className={`quick-launch-launch-sel${mentionTarget ? " is-hidden" : ""}`} inert={mentionTarget !== null || undefined}>
          <button
            ref={theaterChipRef}
            type="button"
            className="quick-launch-chip quick-launch-chip--theater"
            aria-haspopup="menu"
            aria-expanded={popover === "theater"}
            onClick={() => setPopover(popover === "theater" ? null : "theater")}
          >
            <span className="quick-launch-mark" aria-hidden="true">{activeTheater ? theaterInitials(activeTheater.label) : "—"}</span>
            <span className="quick-launch-chip-label">{activeTheater?.label ?? t("chrome.quickLaunch.theaterUnset")}</span>
            <span className="quick-launch-caret" aria-hidden="true">▾</span>
          </button>

          <button
            ref={modelChipRef}
            type="button"
            className="quick-launch-chip quick-launch-chip--model"
            aria-haspopup="menu"
            aria-expanded={popover === "model"}
            disabled={groups.length === 0}
            onClick={() => setPopover(popover === "model" ? null : "model")}
          >
            {/* 아이콘은 플러그인 소유다 — console-core는 어느 플러그인인지 모른 채 렌더만 위임한다
                (캔버스 우클릭 메뉴의 renderKindIcon과 같은 계약). */}
            {kindIcon ? (
              <span
                className={`quick-launch-kind-icon${selectedProvider ? ` is-${selectedProvider}` : ""}`}
                aria-hidden="true"
              >
                {kindIcon}
              </span>
            ) : null}
            <span className="quick-launch-chip-label">{modelLabel}</span>
            <span className="quick-launch-caret" aria-hidden="true">▾</span>
          </button>

          {/* 강도는 고른 모델에 딸린 값이라 그 칩 바로 옆에 산다. 사다리가 없는 모델에서는
              접는다 — 조작할 수 없는 컨트롤이 자리를 지키면 바가 고장 난 것처럼 읽힌다. */}
          {selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? (
            <EffortTrack
              row={selectedRow}
              value={effort}
              onChange={(nextEffort) => {
                setEffort(nextEffort);
                writeQuickLaunchModelEffort(model, nextEffort);
              }}
              autoLabel={t("launchVariants.effort.auto")}
              ariaLabel={t("launchVariants.effort.track")}
              autoValueText={t("launchVariants.effort.autoValue")}
              apexToggleLabel={t("launchVariants.effort.apexToggle")}
              apexCollapseLabel={t("launchVariants.effort.apexCollapse")}
              className="quick-launch-effort-track"
            />
          ) : null}
          </span>

          {mentionTarget ? (
            <span className="quick-launch-target-tag">
              <span className="quick-launch-target-dot" aria-hidden="true" />
              <span>{t("chrome.quickLaunch.mentionTarget", { theater: mentionTarget.theaterLabel })}</span>
            </span>
          ) : null}

          <span className="quick-launch-spacer" />
          {overLimit ? (
            <span className="quick-launch-overflow" role="status">
              {t("chrome.quickLaunch.tooLong", { over: String(promptLength - QUICK_LAUNCH_PROMPT_MAX_CHARS) })}
            </span>
          ) : mentionErrorKey ? (
            // 전달이 거절됐다. 초안·멘션은 그대로 남았고, 무엇이 문제인지 여기서 말한다.
            <span className="quick-launch-rejection" role="alert">
              {t(mentionErrorKey as Parameters<typeof t>[0])}
            </span>
          ) : rejectionKey ? (
            // 거절된 실행이 초안과 함께 돌아왔다. 무엇을 고쳐야 하는지 말하지 않으면 같은 Run이 반복된다.
            <span className="quick-launch-rejection" role="alert">
              {t(
                rejectionKey as Parameters<typeof t>[0],
                state.quickLaunchErrorShortenBy === null
                  ? undefined
                  : { over: String(state.quickLaunchErrorShortenBy) },
              )}
            </span>
          ) : null}
          {/* 고정 토글 — 옵트인 진입점. 켜진 상태는 brass로 말한다(위치 채널).
              도킹이 접힌 화면에서는 눌러도 이 화면에 설 자리가 없으므로 아예 내놓지 않는다. */}
          {dockSuppressed ? null : (
            <button
              type="button"
              className="quick-launch-pin"
              aria-pressed={pinned}
              onClick={togglePinned}
              aria-label={t(pinned ? "chrome.quickLaunch.unpin" : "chrome.quickLaunch.pin")}
              title={t(pinned ? "chrome.quickLaunch.unpin" : "chrome.quickLaunch.pin")}
            >
              <PinIcon />
            </button>
          )}
          <button
            type="button"
            className="quick-launch-submit"
            disabled={!canSubmit}
            onClick={submit}
            // 시각 레이블이 없으므로 이름과 단축키를 여기서 싣는다.
            aria-label={t("chrome.quickLaunch.runWithKey")}
            title={t("chrome.quickLaunch.runWithKey")}
          >
            <SubmitArrowIcon />
          </button>

          {popover === "theater" ? (
            <div
              className="quick-launch-pop quick-launch-pop--theater theater-menu"
              role="menu"
              aria-label={t("chrome.quickLaunch.theaterMenu")}
              style={{ ...(popoverLeft === null ? {} : { left: popoverLeft }), ...(popoverMaxHeight === null ? {} : { "--quick-launch-pop-max-height": `${popoverMaxHeight}px` }) }}
            >
              {theaters.map((theater) => (
                <button
                  key={theater.id}
                  type="button"
                  className="quick-launch-pop-item"
                  role="menuitemradio"
                  aria-checked={theater.id === theaterId}
                  onClick={() => {
                    setTheaterId(theater.id);
                    closePopover();
                    inputRef.current?.focus();
                  }}
                >
                  <span className="quick-launch-mark" aria-hidden="true">{theaterInitials(theater.label)}</span>
                  <span className="quick-launch-pop-item-label">{theater.label}</span>
                  {theater.id === theaterId ? <span className="quick-launch-pop-check" aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}

          {popover === "model" ? (
            <div
              className="quick-launch-pop quick-launch-pop--model theater-menu"
              role="menu"
              aria-label={t("chrome.quickLaunch.modelMenu")}
              style={{ ...(popoverLeft === null ? {} : { left: popoverLeft }), ...(popoverMaxHeight === null ? {} : { "--quick-launch-pop-max-height": `${popoverMaxHeight}px` }) }}
            >
              {groups.map((group) => (
                <div key={group.id} className="quick-launch-pop-group">
                  {(() => {
                    const provider = launchProviderFromGroupId(group.id);
                    return (
                      <p className={`quick-launch-pop-band${provider ? ` is-${provider}` : ""}`}>
                        {provider ? (
                          <span className="operation-launch-provider-glyph" aria-hidden="true">
                            {launchProviderGlyph(provider)}
                          </span>
                        ) : null}
                        <span>{group.label}</span>
                      </p>
                    );
                  })()}
                  {group.rows.map((row) => (
                    <QuickLaunchVariantRow
                      key={row.id}
                      row={row}
                      selectedModel={model}
                      onPick={(nextModel) => {
                        // 새 모델의 사다리에 없는 강도는 들고 갈 수 없다 — 비운 상태로 떨어진다.
                        const nextEffort = resolveRowEffort(row, effort);
                        setModel(nextModel);
                        setEffort(nextEffort);
                        writeQuickLaunchModelEffort(nextModel, nextEffort);
                        closePopover();
                        inputRef.current?.focus();
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function QuickLaunchVariantRow({ row, selectedModel, onPick }: {
  readonly row: OperationLaunchVariantRow;
  readonly selectedModel: string | null;
  readonly onPick: (model: string | null) => void;
}) {
  const rowModel = row.launch.model ?? null;
  return (
    <div className="quick-launch-variant-row">
      <button
        type="button"
        className="quick-launch-variant-name"
        role="menuitemradio"
        aria-checked={rowModel === selectedModel}
        onClick={() => onPick(rowModel)}
      >
        {/* ★는 라벨 뒤에 선다 — 앞에 두고 오른쪽으로 밀면 그 행만 통째로 우측 정렬돼 목록의 좌측 기준선이 끊긴다. */}
        <span className="quick-launch-variant-label">{row.label}</span>
        {row.starred ? <span className="quick-launch-variant-star" aria-hidden="true">★</span> : null}
        {rowModel === selectedModel ? <span className="quick-launch-pop-check" aria-hidden="true">✓</span> : null}
      </button>
    </div>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10.4 1.6 14.4 5.6M11 9.1l.6 3.1-2.1-.6L4 6.1l-.6-2.1 3.1.6ZM6 10l-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SubmitArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 12.75V4.25M4.5 7.75 8 4.25l3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function autoGrow(element: HTMLTextAreaElement): void {
  // 6줄까지 자라고 그 뒤로는 스크롤한다(Analyst 컴포저와 같은 clamp 정책). max-height는 CSS가 소유하므로
  // 여기서는 scrollHeight만 반영하고 상한은 CSS가 자른다.
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

// 카드 안에 포커스가 있을 때만 놓는다. 밖에 있는 포커스를 건드리면 사용자가 옮겨 간 자리를 뺏는다.
function blurWithin(card: HTMLElement | null): void {
  const active = document.activeElement;
  if (card === null || !(active instanceof HTMLElement) || !card.contains(active)) return;
  active.blur();
}

function trapFocus(event: ReactKeyboardEvent<HTMLElement>, card: HTMLElement | null): void {
  if (!card) return;
  const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    // 멘션 전환으로 접힌 런치 3종은 visibility:hidden으로 남는다 — offsetParent만 보면 트랩이
    // 보이지 않는 칩으로 포커스를 되돌린다.
    .filter((element) => element.offsetParent !== null && getComputedStyle(element).visibility !== "hidden");
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

export const QUICK_LAUNCH_POPOVER_GAP = POPOVER_GAP;
