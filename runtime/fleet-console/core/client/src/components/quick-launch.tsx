import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { OperationCatalogPlugin, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";

import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import type { OperationSearchEntry } from "../operation-search.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { readQuickLaunchSelection, writeQuickLaunchModelEffort, writeQuickLaunchSelection, writeQuickLaunchTheater } from "../quick-launch-preferences.js";
import { buildQuickLaunchEffortOptions, buildQuickLaunchMentionGroups, findVariantLaunchKind, isMentionSelectable, QUICK_LAUNCH_DEFAULT_MODEL, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchErrorMessageKey, quickLaunchMentionErrorMessageKey, readCommandInput, readMentionToken, resolveSelection, stripMentionToken, type QuickLaunchCommandInput, type QuickLaunchMentionToken } from "../quick-launch.js";
import { FEATURE_TOUR_LAYER_SELECTOR } from "../feature-tour-catalog.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { clearQuickLaunchRejection, closeQuickLaunch, consumeQuickLaunchDraft, getState, isQuickLaunchDocked, preserveQuickLaunchDraft, requestQuickLaunch, setActiveTheater, setQuickLaunchDockSuppressed, setQuickLaunchPinned } from "../store.js";
import { launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "./launch-provider-glyphs.js";
import { EffortTrack, resolveRowEffort } from "./effort-track.js";

// 카드 폭은 팔레트(920px)보다 좁다 — 팔레트는 결과 목록을 담고, 여기는 한 문단을 담는다.
const CARD_WIDTH_FALLBACK = 760;
const POPOVER_GAP = 8;
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])";

type PopoverKind = "theater" | "model";

interface QuickLaunchCommandRow {
  readonly id: string;
  readonly label: string;
  readonly lead?: ReactNode;
  readonly starred?: boolean;
  readonly checked?: boolean;
  /** 1레벨 명령 행이 싣는 현재 값 — 목록이 곧 발사 좌표의 현황판이 되게 한다. */
  readonly value?: string;
  /** 1레벨 명령 행의 타이핑 별칭(`/theater`) — 오른쪽 끝에서 문법을 가르친다. */
  readonly token?: string;
  readonly pick: () => void;
}

interface QuickLaunchCommandSection {
  readonly key: string;
  /** 모델 레벨의 프로바이더 밴드 — 모델 픽커와 같은 문법. 다른 레벨은 밴드가 없다. */
  readonly band: { readonly label: string; readonly provider: LaunchProviderGlyphId | null } | null;
  readonly rows: readonly QuickLaunchCommandRow[];
}

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
  // '/' 커맨드 덱: 문면("/model sol")이 레벨의 원천이라 별도 레벨 상태가 없다 — 여기는 파싱
  // 결과와 키보드 활성 행만 산다. '@' 덱과는 한 번에 하나만 선다(updatePrompt가 강제).
  const [commandInput, setCommandInput] = useState<QuickLaunchCommandInput | null>(null);
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  // 접힘은 상태로 소유하되 실제 포커스에서만 파생시킨다 — 포커스와 별도로 관리하면 둘이 어긋나
  // "보이는데 못 쓰는" 바가 생긴다. 고정된 채로 화면을 열면 접힌 채 상주한다(포커스를 훔치지 않는다).
  const [collapsed, setCollapsed] = useState(() => state.quickLaunchPinned);
  // 발사되지 않은 초안은 닫힘 경로(Escape·오버레이 클릭·Mod+J·고정 해제)와 무관하게 살아남는다.
  // 제출만이 초안을 소비하므로, 제출 경로가 이 플래그를 올려 닫힘 전이의 보존을 건너뛰게 한다.
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const submittedRef = useRef(false);

  // 설정처럼 실행이 할 일이 아닌 화면에서는 도킹을 접어 둔다. 고정 자체는 그대로라 화면을 벗어나면
  // 바가 되돌아오고, 그동안 Mod+J는 예전처럼 모달을 여닫는다(단축키를 죽이지 않는다).
  const dockSuppressed = location.pathname.startsWith("/settings");
  useEffect(() => {
    setQuickLaunchDockSuppressed(dockSuppressed);
    // 접어 두는 동안 쉬는 상태로 되돌린다 — 그러지 않으면 돌아온 바가 펼쳐진 채, 그러나 포커스는
    // 없는 상태로 서서 아무도 쓰고 있지 않은 컴포저가 자리를 차지한다.
    if (dockSuppressed) setCollapsed(true);
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
    const restoredPrompt = state.quickLaunchDraft ?? "";
    setPrompt(restoredPrompt);
    consumeQuickLaunchDraft();
    setPopover(null);
    setSubmitting(false);
    setMentionToken(null);
    setMentionTarget(null);
    setMentionActiveIndex(0);
    setMentionErrorKey(null);
    // Escape가 보존한 미완의 커맨드("/model")도 초안이다 — 비운 채 되열면 덱 없는 문면에 Enter가
    // 프로즈 발사로 흘러, 보존이 명령을 프롬프트로 둔갑시킨다. 복원 문면을 그대로 재파싱한다.
    setCommandInput(readCommandInput(restoredPrompt, restoredPrompt.length));
    setCommandActiveIndex(0);
    setTheaterId(rememberedTheater ?? state.activeTheaterId ?? theaters[0]?.id ?? null);
    setModel(remembered.model ?? QUICK_LAUNCH_DEFAULT_MODEL);
    setEffort(remembered.effort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.activeTheaterId, theaters]);

  // 닫힘 전이에서 발사되지 않은 초안을 store에 남긴다. 경로별(Escape·오버레이·Mod+J·고정 해제)로
  // 저장을 심으면 하나가 빠질 때마다 초안이 새므로, 전이 한 곳이 모든 닫힘을 대표한다.
  // 열림 전이의 초안 복원(위 효과)과 짝이며, 제출 닫힘만 submittedRef로 보존을 건너뛴다.
  const wasOpenForDraftRef = useRef(open);
  useEffect(() => {
    const was = wasOpenForDraftRef.current;
    wasOpenForDraftRef.current = open;
    if (open) {
      submittedRef.current = false;
      return;
    }
    if (!was) return;
    if (!submittedRef.current && promptRef.current.trim().length > 0) preserveQuickLaunchDraft(promptRef.current);
    submittedRef.current = false;
  }, [open]);

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

  // 명시적인 열기 요청(모바일 새 Operation 버튼 등)은 왕복이 아니라 언제나 펼침이다 — 펼쳐진 바에서
  // 열기를 누른 사용자를 물러나게 하면 버튼이 거꾸로 동작한다.
  const expandRequest = state.quickLaunchExpandRequest;
  const lastExpandRequestRef = useRef(expandRequest);
  useEffect(() => {
    if (expandRequest === lastExpandRequestRef.current) return;
    lastExpandRequestRef.current = expandRequest;
    if (pinned) expandAndFocus();
  }, [expandAndFocus, expandRequest, pinned]);

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

  // 메뉴가 열리면 포커스는 체크된 항목으로 들어간다(WAI-APG menu button 계약). 포커스가 칩에
  // 남으면 방향키·Tab이 목록 밖에서 동작해, 열린 메뉴가 화면에서 가장 도달하기 어려운 컨트롤이
  // 된다(실측: 첫 항목까지 Tab 4회).
  useLayoutEffect(() => {
    if (!popover) return;
    const pop = barRef.current?.querySelector<HTMLElement>(".quick-launch-pop");
    if (!pop) return;
    const checked = pop.querySelector<HTMLElement>("[role='menuitemradio'][aria-checked='true']");
    (checked ?? pop.querySelector<HTMLElement>("[role='menuitemradio']"))?.focus();
  }, [popover]);

  const updatePrompt = useCallback((nextPrompt: string, element: HTMLTextAreaElement) => {
    setPrompt(nextPrompt);
    autoGrow(element);
    setMentionErrorKey(null);
    const caret = element.selectionStart ?? nextPrompt.length;
    // 멘션 보유 중에는 '@'도 '/'도 리터럴로 남는다 — 행선지가 발사 좌표를 대신하는 동안 좌표
    // 커맨드는 설 자리가 없다(바가 런치 3종을 접는 것과 같은 배타).
    const command = mentionTarget ? null : readCommandInput(nextPrompt, caret);
    setCommandInput(command);
    setCommandActiveIndex(0);
    if (mentionTarget || command !== null) {
      setMentionToken(null);
      return;
    }
    setMentionToken(readMentionToken(nextPrompt, caret));
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

  // 커맨드 확정("/model ")과 값 적용(비움) 모두 프로그램 쓰기라 textarea input 이벤트가 없다 —
  // 파싱 상태를 문면과 같은 자리에서 함께 갱신해야 덱이 입력과 어긋나지 않는다.
  const applyCommandPrompt = useCallback((next: string) => {
    setPrompt(next);
    setCommandInput(readCommandInput(next, next.length));
    setCommandActiveIndex(0);
    const element = inputRef.current;
    // 제어 컴포넌트라 값 반영 뒤에야 높이를 잴 수 있다(pickMention과 같은 계약).
    if (element) requestAnimationFrame(() => autoGrow(element));
    element?.focus();
  }, []);

  const finishCommand = useCallback(() => {
    setPrompt("");
    setCommandInput(null);
    setCommandActiveIndex(0);
    const element = inputRef.current;
    if (element) {
      element.style.height = "auto";
      element.focus();
    }
  }, []);

  // '/' 커맨드 덱의 목록. 문면이 레벨을 소유하므로(commandInput.kind) 여기는 그 레벨의 행만
  // 계산한다. 값 레벨은 기존 픽커·트랙과 같은 원천(theaters·카탈로그 groups·chips)과 같은
  // 저장 계층(고르면 즉시 기억)을 쓴다 — 커맨드는 지름길이지 두 번째 진실이 아니다.
  const commandSections = useMemo<readonly QuickLaunchCommandSection[]>(() => {
    if (commandInput === null) return [];
    const query = commandInput.query.trim().toLowerCase();
    if (commandInput.kind === "commands") {
      const effortLabel = effort === null
        ? t("launchVariants.effort.auto")
        : selectedRow?.chips?.find((chip) => chip.id === effort)?.label ?? effort;
      const rows: QuickLaunchCommandRow[] = [];
      const push = (id: string, token: string, label: string, lead: ReactNode, value: string | undefined, pick: () => void) => {
        if (query.length > 0 && !token.slice(1).startsWith(query) && !label.toLowerCase().includes(query)) return;
        rows.push({ id: `cmd-${id}`, label, lead: <span className="quick-launch-command-icon" aria-hidden="true">{lead}</span>, value, token, pick });
      };
      if (theaters.length > 0) {
        push("theater", "/theater", t("chrome.quickLaunch.commandTheater"), <TheaterCommandIcon />, activeTheater?.label, () => applyCommandPrompt("/theater "));
      }
      if (groups.length > 0) {
        push("model", "/model", t("chrome.quickLaunch.commandModel"), <ModelCommandIcon />, selectedRow?.label, () => applyCommandPrompt("/model "));
      }
      if (selectedRow && (selectedRow.chips?.length ?? 0) > 0) {
        push("effort", "/effort", t("chrome.quickLaunch.commandEffort"), <EffortCommandIcon />, effortLabel, () => applyCommandPrompt("/effort "));
      }
      // 고정 버튼과 같은 조건으로만 선다 — 도킹이 접힌 화면에서 고정 커맨드는 설 자리가 없다.
      if (!dockSuppressed) {
        push("pin", "/pin", t(pinned ? "chrome.quickLaunch.unpin" : "chrome.quickLaunch.pin"), <PinIcon />, undefined, () => {
          setQuickLaunchPinned(!pinned);
          expandAndFocus();
          finishCommand();
        });
      }
      return rows.length === 0 ? [] : [{ key: "commands", band: null, rows }];
    }
    if (commandInput.command === "theater") {
      const rows = theaters
        .filter((theater) => theater.label.toLowerCase().includes(query))
        .map<QuickLaunchCommandRow>((theater) => ({
          id: `theater-${theater.id}`,
          label: theater.label,
          lead: <span className="quick-launch-mark" aria-hidden="true">{theaterInitials(theater.label)}</span>,
          checked: theater.id === theaterId,
          pick: () => {
            setTheaterId(theater.id);
            // 칩 픽커와 같은 "고르면 기억" 계층.
            writeQuickLaunchTheater(theater.id);
            finishCommand();
          },
        }));
      return rows.length === 0 ? [] : [{ key: "theaters", band: null, rows }];
    }
    if (commandInput.command === "model") {
      return groups
        .map<QuickLaunchCommandSection>((group) => {
          const provider = launchProviderFromGroupId(group.id);
          return {
            key: group.id,
            band: { label: group.label, provider },
            rows: group.rows
              .filter((row) => row.label.toLowerCase().includes(query))
              .map<QuickLaunchCommandRow>((row) => {
                const rowModel = row.launch.model ?? null;
                // 밴드가 프로바이더를 말하지 못하는 그룹에서도 행은 자기 공급자 마크를 단다 —
                // 필터로 밴드가 성기어질수록 행 스스로 출처를 말해야 한다.
                const rowProvider = provider ?? launchProviderFromModelId(rowModel ?? row.id);
                return {
                  id: `model-${row.id}`,
                  label: row.label,
                  lead: rowProvider === null ? null : (
                    <span className={`quick-launch-kind-icon is-${rowProvider}`} aria-hidden="true">
                      {launchProviderGlyph(rowProvider)}
                    </span>
                  ),
                  starred: row.starred === true,
                  checked: rowModel === model,
                  pick: () => {
                    // 새 모델의 사다리에 없는 강도는 들고 갈 수 없다(모델 픽커와 같은 규칙).
                    const nextEffort = resolveRowEffort(row, effort);
                    setModel(rowModel);
                    setEffort(nextEffort);
                    writeQuickLaunchModelEffort(rowModel, nextEffort);
                    finishCommand();
                  },
                };
              }),
          };
        })
        .filter((section) => section.rows.length > 0);
    }
    // 게이트된 apex 단은 트랙의 ✦ 펼침 계약을 미러링해 명시적 타이핑으로만 드러난다(헬퍼 주석 참조).
    const rows = buildQuickLaunchEffortOptions(selectedRow, effort, t("launchVariants.effort.auto"), commandInput.query)
      .map<QuickLaunchCommandRow>((chip) => ({
        id: `effort-${chip.id ?? "auto"}`,
        label: chip.label,
        checked: chip.checked,
        pick: () => {
          setEffort(chip.id);
          writeQuickLaunchModelEffort(model, chip.id);
          finishCommand();
        },
      }));
    return rows.length === 0 ? [] : [{ key: "efforts", band: null, rows }];
  }, [activeTheater, applyCommandPrompt, commandInput, dockSuppressed, effort, expandAndFocus, finishCommand, groups, model, pinned, selectedRow, t, theaterId, theaters]);

  const commandRowsFlat = useMemo(() => commandSections.flatMap((section) => section.rows), [commandSections]);
  const commandDeckOpen = commandInput !== null;
  // 멘션 덱과 같은 계약: 행이 있는 덱만 Enter/Tab/제출을 가로챈다 — 매치가 없으면
  // "/etc/hosts 확인해줘" 같은 프로즈이므로 Enter는 평소처럼 제출로 흐른다.
  const commandDeckHasRows = commandDeckOpen && commandRowsFlat.length > 0;
  const activeCommandRow = commandRowsFlat.length === 0
    ? null
    : commandRowsFlat[Math.min(commandActiveIndex, commandRowsFlat.length - 1)] ?? null;

  const closePopover = useCallback(() => setPopover(null), []);

  // 픽커는 자신이 선언한 role="menu" 계약을 이행한다 — 방향키 순환, Home/End, 첫 글자 typeahead.
  // 항목은 tabIndex -1(로빙)이라 Tab 정지점이 아니고, Tab은 메뉴를 닫고 칩에서 이어 간다.
  // Enter/Space는 버튼 기본 클릭에 맡긴다(onClick이 선택·닫기·입력 복귀를 이미 소유한다).
  const handlePopoverKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"));
    if (items.length === 0) return;
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    const focusItem = (index: number) => items[((index % items.length) + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      // 포커스가 아직 항목 밖이면(마우스 열림 직후 등) 방향에 맞는 끝에서 시작한다.
      focusItem(activeIndex === -1 ? (delta === 1 ? 0 : items.length - 1) : activeIndex + delta);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusItem(event.key === "Home" ? 0 : items.length - 1);
      return;
    }
    if (event.key === "Tab") {
      // 메뉴 계약: Tab은 항목 순회가 아니라 메뉴를 닫고 다음 컨트롤로 넘어간다. 칩에 포커스를
      // 되돌린 채 기본 동작을 살려 두면 브라우저가 칩의 다음(또는 이전) 정지점으로 옮긴다.
      closePopover();
      (popover === "theater" ? theaterChipRef : modelChipRef).current?.focus();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && /\S/.test(event.key)) {
      // 활성 다음 항목부터 순환 탐색 — 팔레트·'@' 덱과 같은 "치면 닿는" 문법의 최소형.
      const query = event.key.toLowerCase();
      for (let step = 1; step <= items.length; step += 1) {
        const candidate = items[(activeIndex + step + items.length) % items.length]!;
        if ((candidate.dataset.menuLabel ?? "").toLowerCase().startsWith(query)) {
          event.preventDefault();
          candidate.focus();
          return;
        }
      }
    }
  }, [closePopover, popover]);

  // 제출이 끝나면 모달은 사라진다. 고정된 바는 남으므로 초안을 비우고 물러나야 다음 지시를 받는
  // 상태가 된다 — 비우지 않으면 방금 보낸 문장이 그대로 남아 아직 못 보낸 것처럼 읽힌다.
  // 고정 여부는 호출 시점에 store에서 읽는다 — 멘션 전달은 비동기라, 넘길 때의 값을 닫아 두면
  // 전달 중에 고정을 푼 사용자에게 빈 모달이 닫히지 않은 채 남는다.
  const finishSubmission = useCallback((deliveredText: string | null = null) => {
    if (!isQuickLaunchDocked()) {
      // 제출로 닫히는 초안은 소비된 것이다 — 닫힘 전이의 보존이 이 문장을 초안으로 되살리면
      // 다음 열림이 이미 발사된 지시를 미발사처럼 싣는다.
      submittedRef.current = true;
      // 전달이 비동기(멘션)인 동안 Escape로 먼저 닫혔다면 닫힘 전이가 이 문장을 보존해 뒀다 —
      // 남기면 전달된 문장이 미발사 초안으로 되살아난다. 단, store의 초안 슬롯은 공유라 다른
      // 제출의 거절 초안(reopenQuickLaunchWithDraft)이 도착해 있을 수 있으므로, 지금 전달된
      // 문장과 일치하는 보존분만 소비한다(보존은 원문, 전달은 trim이라 trim으로 비교한다).
      if (deliveredText !== null && getState().quickLaunchDraft?.trim() === deliveredText) {
        consumeQuickLaunchDraft();
      }
      closeQuickLaunch();
      return;
    }
    setPrompt("");
    setMentionTarget(null);
    // 열려 있던 덱도 함께 접는다 — 매치 없는 '@'·'/' 토큰은 제출을 막지 않으므로(프로즈 토큰),
    // 토큰을 남기면 비운 컴포저 위로 빈 덱만 떠 있는다.
    setMentionToken(null);
    setCommandInput(null);
    setMentionErrorKey(null);
    // 지난 거절은 성공한 재시도와 함께 내려간다. 모달은 닫히며 버리지만 고정된 바는 닫히지 않아,
    // 사유가 남으면 이미 발사된 지시 위에 옛 실패가 붙어 있고 그동안 바가 접히지도 않는다.
    clearQuickLaunchRejection();
    setSubmitting(false);
    const element = inputRef.current;
    if (element) {
      element.style.height = "auto";
      element.blur();
    }
  }, []);

  const submit = useCallback(() => {
    const text = prompt.trim();
    // 상한을 넘긴 요청은 서버가 반드시 400으로 거절한다. 그대로 보내면 컴포저만 닫히고 초안이
    // 사라지므로, 확실히 실패할 요청으로는 넘기지 않는다.
    if (text.length === 0 || text.length > QUICK_LAUNCH_PROMPT_MAX_CHARS || submitting) return;
    // 행이 있는 덱이 열려 있는 동안은 어떤 경로(Enter·버튼 클릭)로도 제출하지 않는다 —
    // '@token'·'/token' 리터럴이 프롬프트로 발사되는 것을 키보드 가로채기만으로는 못 막는다.
    if (deckHasRows || commandDeckHasRows) return;
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
          // 전달된 문장을 넘겨 이 제출이 보존한 초안만 소비하게 한다.
          finishSubmission(text);
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
    // 고정은 저장된 값을 그대로 다시 쓴다 — 화면별 실효값(설정에서는 접어 두므로 거짓)을 저장하면
    // 그 화면에서 한 번 실행한 것만으로 사용자의 고정 설정이 조용히 꺼진다.
    writeQuickLaunchSelection({ theaterId, model, effort, pinned: state.quickLaunchPinned });
    // 대상 Theater로 전환한 뒤 Operations로 이동한다. 실행은 그 화면이 자기 지오메트리·포커스 규율로
    // 수행한다(pendingOperationFocus와 같은 request/consume 계약) — 컴포저는 의도만 넘긴다.
    setActiveTheater(theaterId);
    requestQuickLaunch({ theaterId, pluginId: target.pluginId, kind: target.kind, variant });
    navigate("/operations");
    finishSubmission();
  }, [commandDeckHasRows, deckHasRows, effort, finishSubmission, mentionTarget, model, navigate, prompt, registry.plugins, selectedRow, state.quickLaunchPinned, submitting, target, theaterId]);

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
  }, [closePopover, pinned, popover]);

  // 모달일 때의 Tab 가둠은 문서 수준에서 건다 — 안내 카드는 이 컴포저 밖에 렌더되므로 카드에만
  // 건 핸들러로는 카드에서 나가는 Tab을 잡지 못해, 열려 있는 모달 뒤로 포커스가 샌다.
  useEffect(() => {
    if (!open || pinned) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      trapFocus(event, cardRef.current);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, pinned]);

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
    // 멘션·커맨드 덱은 카드 직속이라 접힘에도 inert에도 걸리지 않는다 — 남겨 두면 물러난 바 위로
    // 목록이 떠서, 도킹이 되돌려 준 그 화면을 도로 가린다.
    setMentionToken(null);
    setCommandInput(null);
    setCollapsed(true);
  }, [pinned]);

  // 고정을 켜고 끄는 순간에도 쓰던 자리를 잃지 않는다 — 전환이 끝나면 입력은 그대로 이어진다.
  const togglePinned = useCallback(() => {
    setQuickLaunchPinned(!pinned);
    expandAndFocus();
  }, [expandAndFocus, pinned]);

  // 고정을 풀면 접힘이라는 상태 자체가 없어진다(모달은 접히지 않는다). 판정은 실효값이 아니라
  // 저장된 고정값으로 한다 — 설정 화면의 일시 억제까지 해제로 읽으면, 잠시 접어 둔 바가 돌아올 때
  // 쉬는 상태를 잃고 펼쳐진 채 선다.
  useEffect(() => {
    if (!state.quickLaunchPinned) setCollapsed(false);
  }, [state.quickLaunchPinned]);

  const handleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (commandDeckOpen) {
      if (commandDeckHasRows && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setCommandActiveIndex((index) => {
          const bounded = Math.min(index, commandRowsFlat.length - 1);
          return (bounded + delta + commandRowsFlat.length) % commandRowsFlat.length;
        });
        return;
      }
      // 행이 있는 덱에서 Enter는 제출이 아니라 선택이다 — '/token' 리터럴 오발사를 막는다.
      // IME 조합 중 Enter는 확정이지 선택이 아니다(멘션 덱과 같은 계약).
      if (commandDeckHasRows && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        activeCommandRow?.pick();
        return;
      }
      if (event.key === "Escape") {
        // 카드의 Escape(컴포저 닫기)보다 먼저, 값 레벨은 명령 목록으로 한 단계만 물러난다 —
        // 두 단계를 한 번에 무너뜨리면 방금 고른 명령까지 잃는다.
        event.preventDefault();
        event.stopPropagation();
        if (commandInput?.kind === "values") {
          applyCommandPrompt("/");
          return;
        }
        setCommandInput(null);
        return;
      }
    }
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
  }, [activeCommandRow, activeMention, applyCommandPrompt, clearMention, commandDeckHasRows, commandDeckOpen, commandInput, commandRowsFlat.length, deckHasRows, mentionDeckOpen, mentionTarget, pickMention, prompt.length, selectableMentions.length, submit]);

  if (!open) return null;

  const promptLength = prompt.trim().length;
  const overLimit = promptLength > QUICK_LAUNCH_PROMPT_MAX_CHARS;
  // 멘션 제출은 런치 좌표(theater/model/effort)가 필요 없다 — 행선지가 그 자리를 대신한다.
  // 행이 있는 덱이 열린 동안은 버튼도 잠근다(submit의 deckHasRows 가드와 같은 계약).
  const canSubmit = promptLength > 0 && !overLimit && !submitting && !deckHasRows && !commandDeckHasRows
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
              {draftTrace.length === 0 ? t("chrome.quickLaunch.placeholder") : draftTrace}
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

        {/* '/' 커맨드 덱 — 멘션 덱과 같은 표면 문법(위로 열림·카테고리 밴드·행 어휘)을 공유하고,
            내용만 레벨(명령 목록 ↔ 값 목록)이 갈아 끼운다. */}
        {commandDeckOpen ? (
          <div className="quick-launch-mention-deck quick-launch-command-deck theater-menu" role="listbox" id="quick-launch-command-deck" aria-label={t("chrome.quickLaunch.commandDeck")}>
            <p className="quick-launch-mention-category">
              <span>
                {commandInput?.kind === "commands"
                  ? t("chrome.quickLaunch.commandCategory")
                  : commandInput?.command === "theater"
                    ? t("chrome.quickLaunch.theaterMenu")
                    : commandInput?.command === "model"
                      ? t("chrome.quickLaunch.modelMenu")
                      : t("launchVariants.effort.track")}
              </span>
              <span className="quick-launch-mention-category-rule" aria-hidden="true" />
            </p>
            {commandRowsFlat.length === 0 ? (
              <p className="quick-launch-mention-empty">{t("chrome.quickLaunch.commandNoMatch")}</p>
            ) : commandSections.map((section) => (
              <div key={section.key}>
                {section.band ? (
                  <p className={`quick-launch-pop-band${section.band.provider ? ` is-${section.band.provider}` : ""}`}>
                    {section.band.provider ? (
                      <span className="operation-launch-provider-glyph" aria-hidden="true">
                        {launchProviderGlyph(section.band.provider)}
                      </span>
                    ) : null}
                    <span>{section.band.label}</span>
                  </p>
                ) : null}
                {section.rows.map((row) => {
                  const active = row === activeCommandRow;
                  return (
                    <button
                      key={row.id}
                      id={`quick-launch-command-${row.id}`}
                      type="button"
                      className={`quick-launch-mention-row quick-launch-command-row${active ? " is-active" : ""}`}
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      // 클릭이 textarea 포커스를 뺏지 않아야 선택 직후 바로 타이핑이 이어진다.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={row.pick}
                    >
                      {row.lead}
                      <span className="quick-launch-mention-name">{row.label}</span>
                      {row.starred ? <span className="quick-launch-variant-star" aria-hidden="true">★</span> : null}
                      {row.value === undefined ? null : <span className="quick-launch-command-value">{row.value}</span>}
                      {row.token === undefined ? null : <span className="quick-launch-command-token" aria-hidden="true">{row.token}</span>}
                      {row.checked ? <span className="quick-launch-pop-check" aria-hidden="true">✓</span> : null}
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
            aria-controls={mentionDeckOpen ? "quick-launch-mention-deck" : commandDeckOpen ? "quick-launch-command-deck" : undefined}
            aria-activedescendant={mentionDeckOpen && activeMention
              ? `quick-launch-mention-${activeMention.operationId}`
              : commandDeckOpen && activeCommandRow
                ? `quick-launch-command-${activeCommandRow.id}`
                : undefined}
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
              도킹이 접힌 화면에서는 눌러도 설 자리가 없고, 물러난 바에서는 높이 0 + inert라 누를 수
              없다 — 둘 다 아예 내놓지 않아, 이 버튼의 존재가 곧 "지금 누를 수 있다"가 되게 한다
              (화면 안내가 이 버튼을 앵커로 삼으므로, 존재만으로 판정이 서야 한다). */}
          {dockSuppressed || showStrip ? null : (
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
              onKeyDown={handlePopoverKeyDown}
              style={{ ...(popoverLeft === null ? {} : { left: popoverLeft }), ...(popoverMaxHeight === null ? {} : { "--quick-launch-pop-max-height": `${popoverMaxHeight}px` }) }}
            >
              {theaters.map((theater) => (
                <button
                  key={theater.id}
                  type="button"
                  className="quick-launch-pop-item"
                  role="menuitemradio"
                  aria-checked={theater.id === theaterId}
                  tabIndex={-1}
                  data-menu-label={theater.label}
                  onClick={() => {
                    setTheaterId(theater.id);
                    // 모델·강도와 같은 "고르면 기억" 계층 — 실행까지 미루면 보존된 초안이
                    // 재오픈에서 옛 Theater로 돌아간 채 발사 좌표만 어긋난다.
                    writeQuickLaunchTheater(theater.id);
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
              onKeyDown={handlePopoverKeyDown}
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
        tabIndex={-1}
        data-menu-label={row.label}
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

// 커맨드 덱 1레벨의 리드 아이콘 3종 — Pin·SubmitArrow와 같은 16 viewBox·1.5px stroke 문법.
// 값 레벨은 기존 어휘(이니셜 마크·프로바이더 글리프)를 그대로 쓰므로 여기서 끝난다.
function TheaterCommandIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3v-5ZM8 8.5v5M2.5 5.5 8 8.5l5.5-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ModelCommandIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

function EffortCommandIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="5" cy="8" r="1.4" fill="currentColor" />
      <circle cx="11" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
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

function trapFocus(event: KeyboardEvent, card: HTMLElement | null): void {
  if (!card) return;
  // 화면 안내가 이 컴포저 안을 가리키고 있으면 그 카드도 이 대화의 포커스 범위다 — 안내 카드는
  // 스스로 포커스를 가져가지 않으므로, 트랩이 카드를 빼면 키보드로는 안내를 닫을 방법이 없다.
  const scopes = [card, ...Array.from(document.querySelectorAll<HTMLElement>(FEATURE_TOUR_LAYER_SELECTOR))];
  const focusable = scopes.flatMap((scope) => Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)))
    // 멘션 전환으로 접힌 런치 3종은 visibility:hidden으로 남는다 — offsetParent만 보면 트랩이
    // 보이지 않는 칩으로 포커스를 되돌린다. 로빙(tabIndex -1) 항목 — 픽커·멘션 덱의 행 — 은
    // Tab 정지점이 아니므로 트랩의 양 끝 계산에서도 빠져야 한다(버튼 셀렉터가 다시 주워 담는다).
    .filter((element) => element.tabIndex >= 0 && element.offsetParent !== null && getComputedStyle(element).visibility !== "hidden");
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
