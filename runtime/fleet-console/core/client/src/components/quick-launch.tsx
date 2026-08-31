import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { OperationCatalogPlugin, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";

import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import { resolveOperationMarkVisual } from "../operation-activity.js";
import type { OperationSearchEntry } from "../operation-search.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { readQuickLaunchSelection, writeQuickLaunchMentionFocused, writeQuickLaunchModelEffort, writeQuickLaunchSelection, writeQuickLaunchStartView, writeQuickLaunchTheater, type QuickLaunchStartView } from "../quick-launch-preferences.js";
import { buildPluginMentionCategories, buildQuickLaunchEffortDeck, buildQuickLaunchMentionGroups, findVariantLaunchKind, isMentionSelectable, isQuickLaunchAttachmentCandidate, isUltracodeDisarmCaret, mentionTargetName, nextUltracodeIgnored, QUICK_LAUNCH_ATTACHMENT_MAX_BYTES, QUICK_LAUNCH_DEFAULT_MODEL, QUICK_LAUNCH_MAX_ATTACHMENTS, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchAttachmentErrorMessageKey, quickLaunchErrorMessageKey, quickLaunchMentionErrorMessageKey, readCommandInput, readMentionToken, readUltracodeTokens, resolveFocusedMention, resolveMentionEntry, resolveSelection, shouldApplyFocusedMention, stripMentionToken, type QuickLaunchCommandInput, type QuickLaunchMentionTarget, type QuickLaunchMentionToken } from "../quick-launch.js";
import { FEATURE_TOUR_LAYER_SELECTOR } from "../feature-tour-catalog.js";
import { formatShortcutCombo, QUICK_LAUNCH_TOGGLE_COMBOS } from "../shortcuts.js";
import type { QuickLaunchDraftAttachment } from "../types.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { isTriageActive } from "../canvas/triage-store.js";
import { clearQuickLaunchRejection, closeQuickLaunch, consumeQuickLaunchDraft, consumeQuickLaunchMentionSeed, getState, isQuickLaunchDocked, preserveQuickLaunchDraft, requestQuickLaunch, setActiveTheater, setQuickLaunchDockSuppressed, setQuickLaunchPinned } from "../store.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-marks.js";
import { OperationNameMark } from "./operation-name-mark.js";
import { launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "./launch-provider-glyphs.js";
import { EffortTrack, gatedEffortNames, resolveRowEffort } from "./effort-track.js";
import { ChatBubbleIcon, TerminalViewIcon } from "./start-view-glyphs.js";
import { ComposerAttachControl, ComposerBar, ComposerChip, ComposerField, ComposerInput, ComposerRestStrip, ComposerSubmitButton, renderUltracodeHighlight, syncComposerHighlight } from "./composer-blocks.js";

// 카드 폭은 팔레트(920px)보다 좁다 — 팔레트는 결과 목록을 담고, 여기는 한 문단을 담는다.
const CARD_WIDTH_FALLBACK = 760;
const POPOVER_GAP = 8;
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])";

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

function resolveModLabel(): string {
  const userAgentDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

/**
 * War Room 무대 id. 전 Theater가 마운트되므로 지목이 Theater를 바꾸지 않고
 * (pickTriageOperation) 캔버스가 무대 Operation을 active로 세운다. 그 id는
 * leftover가 아니라 지금 보고 있는 패널이다 — 헬퍼는 Theater 불일치여도
 * 이 id만 허용한다.
 */
function visibleTriageStageOperationId(): string | null {
  return isTriageActive() ? getState().activeOperationId : null;
}

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
  /** 강도 행의 단계 톤 좌표. CSS가 이 속성 하나로 색을 읽는다(트랙과 같은 계약). */
  readonly effortLevel?: string;
  /** 게이트 뒤 티어인가 — MAX의 이글거림을 트랙과 같은 조건으로 가른다. */
  readonly apex?: boolean;
  /** 값이 아니라 게이트를 여닫는 행. 선택해도 덱이 닫히지 않는다. */
  readonly gate?: boolean;
  readonly pick: () => void;
}

interface QuickLaunchCommandSection {
  readonly key: string;
  /** 모델 레벨의 프로바이더 밴드 — 모델 픽커와 같은 문법. 다른 레벨은 밴드가 없다. */
  readonly band: { readonly label: string; readonly provider: LaunchProviderGlyphId | null } | null;
  readonly rows: readonly QuickLaunchCommandRow[];
}

/**
 * 컴포저 안의 첨부 한 장. key는 렌더·제거용 로컬 식별자이고, id는 업로드가 끝나야 도착하는
 * 서버측 불투명 토큰이다(경로는 브라우저에 오지 않는다). previewUrl은 로컬 object URL이라
 * 칩 제거·업로드 실패에서만 회수하고, 발사된 것은 거절 복원을 위해 실행 의도에 실어 보낸다.
 */
interface ComposerAttachment {
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  readonly previewUrl: string;
  readonly uploading: boolean;
}

export function QuickLaunch() {
  const state = useConsoleState();
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const registry = usePluginRegistry();
  // Cmd+K·사이드바·커맨드 밴드와 같은 마크 축. 미확인 완료도 어느 Operation을 고르는
  // 표면인가에 따라 사라지지 않아야 하므로 멘션 덱이 같은 외부 원장을 구독한다.
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);

  const cardRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // `ultracode` 하이라이트를 그리는 미러 레이어. textarea가 스크롤하면 같은 만큼 따라가야 글자가
  // 어긋나지 않는다(6줄 클램프 뒤로는 실제로 스크롤한다).
  const highlightRef = useRef<HTMLDivElement | null>(null);
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
  const [mentionTarget, setMentionTarget] = useState<QuickLaunchMentionTarget | null>(null);
  const [mentionFocused, setMentionFocused] = useState(() => readQuickLaunchSelection().mentionFocused);
  // 시작 표면. 모델·강도와 같은 "고르면 기억" 계층에서 초기값을 읽는다 — 무장이 안내줄과
  // 카드 외곽선으로 상시 보이므로 기억이 숨은 모드를 만들지 않는다.
  const [startView, setStartView] = useState<QuickLaunchStartView>(() => readQuickLaunchSelection().view);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionErrorKey, setMentionErrorKey] = useState<string | null>(null);
  // '/' 커맨드 덱: 문면("/model sol")이 레벨의 원천이라 별도 레벨 상태가 없다 — 여기는 파싱
  // 결과와 키보드 활성 행만 산다. '@' 덱과는 한 번에 하나만 선다(updatePrompt가 강제).
  const [commandInput, setCommandInput] = useState<QuickLaunchCommandInput | null>(null);
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  // `/effort` 게이트의 열림. 트랙의 ✦ 토글과 같은 자리를 덱에서는 문 행이 맡는다. 덱을 떠나면
  // 접힌 상태로 돌아간다 — 게이트는 "이번에 열었다"이지 기억되는 설정이 아니다(트랙도 그렇다).
  const [commandGateOpen, setCommandGateOpen] = useState(false);
  // 이미지 첨부: 붙여넣기·드롭 즉시 업로드가 시작되고, 칩은 업로드가 끝나야 발사 가능해진다.
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [attachmentErrorKey, setAttachmentErrorKey] = useState<string | null>(null);
  // `ultracode` 인식은 단어의 존재에서 파생하고, 상태로 남는 것은 "이 초안에서 껐다"뿐이다 —
  // 무장을 상태로 들면 문면과 어긋난 무장이 남는다.
  const [ultracodeIgnored, setUltracodeIgnored] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 확대 보기 중인 칩의 key. 파생(zoomedAttachment)이 칩 소멸을 스스로 따라간다.
  const [zoomedKey, setZoomedKey] = useState<string | null>(null);
  // 접힘은 상태로 소유하되 실제 포커스에서만 파생시킨다 — 포커스와 별도로 관리하면 둘이 어긋나
  // "보이는데 못 쓰는" 바가 생긴다. 고정된 채로 화면을 열면 접힌 채 상주한다(포커스를 훔치지 않는다).
  const [collapsed, setCollapsed] = useState(() => state.quickLaunchPinned);
  // 발사되지 않은 초안은 닫힘 경로(Escape·오버레이 클릭·Mod+J·고정 해제)와 무관하게 살아남는다.
  // 제출만이 초안을 소비하므로, 제출 경로가 이 플래그를 올려 닫힘 전이의 보존을 건너뛰게 한다.
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 업로드가 끝나기 전에 칩이 사라진 key들. 완료 콜백이 여기서 자신을 발견하면 방금 받은 id를
  // 서버에서 도로 거둔다 — 안 거두면 보이지 않는 파일이 미발사 슬롯을 30분간 차지한다.
  const canceledUploadKeysRef = useRef(new Set<string>());
  // 실제로 떠 있는 확대 레이어 — 칩이 사라지면 스스로 null이 된다(Escape 판정의 원천).
  const zoomedAttachment = zoomedKey === null ? null : attachments.find((attachment) => attachment.key === zoomedKey) ?? null;
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
  // 시작 뷰 선택은 실행 종류가 스스로 채팅을 지원한다고 선언했을 때만 선다 — core는 어느
  // 플러그인이 채팅을 아는지 몰라야 한다. 능력이 없으면 기억이 무엇이라 말하든 무장은
  // 성립하지 않고 발사는 터미널로 정규화된다(카탈로그가 늦게 오는 첫 프레임도 같은 계약).
  const chatStartAvailable = target?.kind.launchViews?.includes("chat") === true;
  const chatStart = chatStartAvailable && startView === "chat";

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
  const messageableTypesByPluginRef = useRef(messageableTypesByPlugin);
  messageableTypesByPluginRef.current = messageableTypesByPlugin;
  const mentionFocusedRef = useRef(mentionFocused);
  mentionFocusedRef.current = mentionFocused;
  const mentionTargetRef = useRef(mentionTarget);
  mentionTargetRef.current = mentionTarget;
  const mentionGroups = useMemo(
    () => (mentionToken === null ? [] : buildQuickLaunchMentionGroups(state, messageableTypesByPlugin, mentionToken.query)),
    [mentionToken, state, messageableTypesByPlugin],
  );
  const mentionEntries = useMemo(() => mentionGroups.flatMap((group) => group.entries), [mentionGroups]);
  // 플러그인 기여 행선지는 덱이 열릴 때마다 다시 읽는다 — 설정에서 켜고 끈 결과가 그대로 반영된다.
  // 로스터가 마운트 시점에 굳으면 "껐는데 아직 보인다"가 바로 나온다.
  const pluginMentionCategories = useMemo(
    () => (mentionToken === null ? [] : buildPluginMentionCategories(registry.plugins, mentionToken.query)),
    [mentionToken, registry.plugins],
  );
  const pluginMentionRows = useMemo(
    () => pluginMentionCategories.flatMap((category) => category.rows),
    [pluginMentionCategories],
  );
  // 방향키는 한 listbox를 돈다 — 카테고리 경계는 시각 밴드일 뿐 키보드 문법을 가르지 않는다.
  const selectableMentions = useMemo<readonly QuickLaunchMentionTarget[]>(() => [
    ...mentionEntries
      .filter((entry) => isMentionSelectable(entry.activity))
      .map((entry) => ({ kind: "operation" as const, entry })),
    ...pluginMentionRows.map((row) => ({ kind: "plugin" as const, row })),
  ], [mentionEntries, pluginMentionRows]);
  const activeMention = selectableMentions.length === 0
    ? null
    : selectableMentions[Math.min(mentionActiveIndex, selectableMentions.length - 1)] ?? null;
  const mentionDeckOpen = mentionToken !== null;
  // 행이 있는 덱만 Enter/Tab/제출을 가로챈다 — 매치가 없으면 "@3pm" 같은 프로즈 토큰이므로
  // Enter는 평소처럼 제출로 흐른다. 행이 있는 동안은 마우스 제출 버튼도 같은 계약으로 잠근다.
  const deckHasRows = mentionDeckOpen && (mentionEntries.length + pluginMentionRows.length) > 0;

  // 컴포저가 열리는 순간의 행선지를 한 곳에서 정한다. 진입점은 둘이고 우선순위가 있다:
  // 명시 행선지(패널 회신 버튼이 store에 건넨 시드)가 먼저고, 없을 때만 바의 포커스 옵트인이
  // 말한다 — 그 패널의 버튼을 직접 누른 지시가 상시 규칙보다 구체적이다. 시드는 옵트인 여부를
  // 묻지 않는다(버튼이 곧 그 회차의 동의다). 시드는 남은 초안을 지키지 않는다 — 회신 버튼은
  // 이전 문장을 이어 쓰는 자리가 아니라 그 Operation에게 새로 보내는 자리다. 이미 붙은
  // 멘션·쓰고 있던 문면 가드는 포커스 옵트인에만 산다. 시드는 읽는 즉시 비운다: 남기면
  // 다음 열림이 지난 행선지를 되쓴다.
  const mentionSeedRef = useRef(state.quickLaunchMentionSeed);
  mentionSeedRef.current = state.quickLaunchMentionSeed;
  // 회신 시드가 열면 남은 초안·첨부를 거둔다. 미리보기 URL과 서버 미발사분은 슬롯을 비우기
  // 전에 회수한다 — store에서 먼저 지우면 회수할 자취가 사라진다.
  const discardComposerContents = useCallback(() => {
    const slot = getState().quickLaunchDraftAttachments ?? [];
    const discarded: readonly ComposerAttachment[] = [
      ...slot.map((attachment) => ({
        key: attachment.id,
        id: attachment.id,
        name: attachment.name,
        previewUrl: attachment.previewUrl,
        uploading: false,
      })),
      ...attachmentsRef.current.filter((attachment) => !slot.some((kept) => kept.previewUrl === attachment.previewUrl)),
    ];
    for (const attachment of discarded) {
      URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.id !== null) void attachmentPluginRef.current?.discardLaunchAttachment?.(attachment.id).catch(() => {});
      else canceledUploadKeysRef.current.add(attachment.key);
    }
    attachmentsRef.current = [];
    promptRef.current = "";
    setAttachments([]);
    setPrompt("");
    consumeQuickLaunchDraft();
    // 시드 오픈은 새 회차다 — 이전 전달의 성공 콜백이 방금 비운 자리를 finishSubmission으로
    // 닫지 못하게 에포크를 올린다(모달 열림 전이·거절 복원과 같은 계약).
    composerEpochRef.current += 1;
  }, []);
  const resolveOpeningMention = useCallback((input: {
    readonly addressFocused: boolean;
    readonly leftoverDraft: boolean;
    readonly mentionAlreadySet: boolean;
    readonly promptOccupied: boolean;
  }): OperationSearchEntry | null => {
    const seed = mentionSeedRef.current;
    if (seed !== null) {
      mentionSeedRef.current = null;
      consumeQuickLaunchMentionSeed();
      discardComposerContents();
      return resolveMentionEntry(getState(), messageableTypesByPluginRef.current, seed);
    }
    if (input.addressFocused && shouldApplyFocusedMention({
      prefOn: mentionFocusedRef.current,
      leftoverDraft: input.leftoverDraft,
      mentionAlreadySet: input.mentionAlreadySet,
      promptOccupied: input.promptOccupied,
    })) {
      return resolveFocusedMention(getState(), messageableTypesByPluginRef.current, visibleTriageStageOperationId());
    }
    return null;
  }, [discardComposerContents]);

  // ── `ultracode` 인식 ────────────────────────────────────────────────────────
  // 무장은 문면에서 파생한다. 멘션 행선지가 있어도 그대로 성립한다 — 이 단어는 실행 좌표가 아니라
  // 프롬프트가 실려 가는 곳이면 어디든 함께 가는 원문의 일부다.
  const ultracodeTokens = useMemo(() => readUltracodeTokens(prompt), [prompt]);
  const ultracodeArmed = ultracodeTokens.length > 0 && !ultracodeIgnored;
  // 해제는 단어가 문면에서 전부 사라질 때 만료한다. 프로그램 쓰기(초안 복원·커맨드 확정)도 같은
  // 경로를 지나야 하므로 입력 핸들러가 아니라 문면 자체에 붙인다.
  useEffect(() => {
    setUltracodeIgnored((ignored) => nextUltracodeIgnored(prompt, ignored));
  }, [prompt]);


  // 미러를 textarea의 client 박스에 맞추는 동작 문법은 컴포저 블록이 소유한다(채팅 컴포저와 공유).
  const syncUltracodeHighlight = useCallback(() => {
    syncComposerHighlight(inputRef.current, highlightRef.current);
  }, []);

  // 문면·자동 높이가 바뀐 프레임에서 바로 맞춘다(그려진 뒤 맞추면 한 프레임 어긋난 채 보인다).
  useLayoutEffect(() => {
    syncUltracodeHighlight();
  }, [prompt, syncUltracodeHighlight, ultracodeArmed]);

  // 카드 폭은 첨부 트레이·뷰포트·멘션 칩으로도 바뀐다 — textarea 자신을 관찰하는 것이 유일하게
  // 빠짐없는 기준이다.
  useEffect(() => {
    const input = inputRef.current;
    if (!ultracodeArmed || !input || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncUltracodeHighlight());
    observer.observe(input);
    return () => observer.disconnect();
  }, [syncUltracodeHighlight, ultracodeArmed]);

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
    // 회신 말풍선이 행선지를 들고 오면 남은 초안은 이 회차의 문면이 아니다 — 복원하면 시드가
    // 주소를 못 받고, 이전 문장이 다른 Operation으로 실려 간다. 일반 재오픈만 초안을 되살린다.
    // 폐기는 resolveOpeningMention이 시드를 읽는 자리에서 한다. 여기서 복원하면 그 폐기가
    // 방금 살린 문장을 다시 거둔다.
    const discardDraft = mentionSeedRef.current !== null;
    const restoredPrompt = discardDraft ? "" : (state.quickLaunchDraft ?? "");
    setPrompt(restoredPrompt);
    // 지난 세션이 남긴 칩 중 초안 슬롯으로 돌아오지 않는 것을 먼저 거둔다 — 미리보기 URL과
    // 첨부 칩은 초안 슬롯의 보존분과, 컴포저가 닫힌 동안에도 상태에 남아 있던 미보존분(닫힘
    // 시점에 업로드 중이던 칩과 그 뒤 완료된 칩)을 병합해 되살린다 — 텍스트 초안은 살아남는데
    // 늦게 끝난 이미지만 조용히 사라지면 보존 계약이 반쪽이 된다. 제출은 finishSubmission이
    // 상태를 비우므로 여기로 이월되지 않는다. 시드 오픈은 복원하지 않는다.
    const restoredPreviews = new Set((discardDraft ? [] : (state.quickLaunchDraftAttachments ?? [])).map((attachment) => attachment.previewUrl));
    const carried = discardDraft ? [] : attachmentsRef.current.filter((attachment) => !restoredPreviews.has(attachment.previewUrl));
    setAttachments(discardDraft ? [] : [
      ...(state.quickLaunchDraftAttachments ?? []).map((attachment) => ({
        key: attachment.id,
        id: attachment.id,
        name: attachment.name,
        previewUrl: attachment.previewUrl,
        uploading: false,
      })),
      ...carried,
    ]);
    if (!discardDraft) consumeQuickLaunchDraft();
    setPopover(null);
    setSubmitting(false);
    setMentionToken(null);
    setMentionActiveIndex(0);
    setMentionErrorKey(null);
    // 모달 열림만 여기서 주소한다. 도킹 첫 마운트·설정에서 돌아온 재마운트는 invoke가 아니다.
    // 접힌 바에 칩을 미리 심으면 펼치기도 전에 행선지가 바뀐다. 도킹은 expandAndFocus가 맡는다.
    const leftoverDraft = restoredPrompt.trim().length > 0
      || (discardDraft ? 0 : (state.quickLaunchDraftAttachments?.length ?? 0)) > 0
      || carried.length > 0;
    const openingMention = pinned ? null : resolveOpeningMention({
      addressFocused: true,
      leftoverDraft,
      mentionAlreadySet: false,
      promptOccupied: false,
    });
    setMentionTarget(openingMention === null ? null : { kind: "operation", entry: openingMention });
    // Escape가 보존한 미완의 커맨드("/model")도 초안이다 — 비운 채 되열면 덱 없는 문면에 Enter가
    // 프로즈 발사로 흘러, 보존이 명령을 프롬프트로 둔갑시킨다. 복원 문면을 그대로 재파싱한다.
    setCommandInput(readCommandInput(restoredPrompt, restoredPrompt.length));
    setCommandActiveIndex(0);
    setAttachmentErrorKey(null);
    setDragOver(false);
    setZoomedKey(null);
    setTheaterId(rememberedTheater ?? state.activeTheaterId ?? theaters[0]?.id ?? null);
    setModel(remembered.model ?? QUICK_LAUNCH_DEFAULT_MODEL);
    setEffort(remembered.effort);
    // 모델·강도와 같은 계층이므로 열림마다 기억에서 되읽는다 — 마운트 초기값만 읽으면 다른 표면이
    // 바꾼 값이 이 컴포저에만 반영되지 않는다.
    setStartView(remembered.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.activeTheaterId, theaters]);

  // 이미 열린 모달에 시드가 도착하면 열림 전이가 없다. 회신 버튼은 그 회차의 주소이므로
  // 쓰고 있던 문면도 버리고 행선지를 심는다. 시드는 resolveOpeningMention이 읽는 즉시
  // 비우므로, 열림 전이가 같은 틱에 소비한 뒤에는 여기가 다시 주소하지 않는다.
  // 도킹은 접힌 바에 칩을 미리 심지 않는다 — expandAndFocus가 펼침에서 맡는다.
  useEffect(() => {
    if (!open || pinned || !wasOpenRef.current || mentionSeedRef.current === null) return;
    const addressed = resolveOpeningMention({
      addressFocused: true,
      leftoverDraft: false,
      mentionAlreadySet: false,
      promptOccupied: false,
    });
    setMentionTarget(addressed === null ? null : { kind: "operation", entry: addressed });
    setMentionToken(null);
    setMentionErrorKey(null);
    setCommandInput(readCommandInput(promptRef.current, promptRef.current.length));
    setCommandActiveIndex(0);
  }, [open, pinned, resolveOpeningMention, state.quickLaunchMentionSeed]);

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
    // 업로드가 끝난 첨부는 초안 슬롯으로 보존한다. 진행 중이던 칩은 id가 없어 슬롯에 실을 수
    // 없지만 버려지지 않는다 — 컴포저 상태에 남아 완료 콜백이 ready로 승급시키고, 다음 열림
    // 전이가 슬롯 보존분과 병합해 되살린다.
    const preservedAttachments = attachmentsRef.current
      .filter((attachment) => attachment.id !== null)
      .map((attachment) => ({ id: attachment.id as string, name: attachment.name, previewUrl: attachment.previewUrl }));
    if (!submittedRef.current && (promptRef.current.trim().length > 0 || preservedAttachments.length > 0)) {
      preserveQuickLaunchDraft(promptRef.current, preservedAttachments.length > 0 ? preservedAttachments : null);
    }
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
  // 포커스 멘션은 invoke에서만 붙인다. 핀 전환·거절 초안 복원은 이미 열린 자리를 이어 쓰는
  // 것이라 주소하지 않는다 — 비운 멘션을 핀이 도로 심거나, 방금 켠 옵트인이 현재 문면을 덮지 않는다.
  const expandAndFocus = useCallback((input: { readonly addressFocused?: boolean } = {}) => {
    setCollapsed(false);
    const seeded = mentionSeedRef.current !== null;
    if (input.addressFocused === true) {
      const addressed = resolveOpeningMention({
        addressFocused: true,
        leftoverDraft: false,
        mentionAlreadySet: seeded ? false : mentionTargetRef.current !== null,
        promptOccupied: seeded ? false : (promptRef.current.trim().length > 0 || attachmentsRef.current.length > 0),
      });
      if (addressed) {
        setMentionTarget({ kind: "operation", entry: addressed });
        setMentionToken(null);
        setMentionErrorKey(null);
      } else if (seeded) {
        setMentionTarget(null);
      }
    }
    // 시드가 초안을 비운 뒤에는 빈 문면을 재파싱한다. 접힘/펼침 왕복은 유지된 문면에서
    // 커맨드를 되살린다 — "/model"을 프로즈로 둔갑시키지 않는다.
    setCommandInput(readCommandInput(promptRef.current, promptRef.current.length));
    setCommandActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [resolveOpeningMention]);

  // 고정 중 Mod+J: 접혀 있으면 펼쳐 포커스하고, 펼쳐져 있으면 물러난다. 접힘 자체는 포커스에서
  // 파생되므로 여기서는 포커스만 움직인다(에포크 0은 최초 마운트라 아무 일도 하지 않는다).
  const focusToggle = state.quickLaunchFocusToggle;
  const lastFocusToggleRef = useRef(focusToggle);
  useEffect(() => {
    if (focusToggle === lastFocusToggleRef.current) return;
    lastFocusToggleRef.current = focusToggle;
    if (!pinned) return;
    if (collapsed) expandAndFocus({ addressFocused: true });
    else blurWithin(cardRef.current);
  }, [collapsed, expandAndFocus, focusToggle, pinned]);

  // 명시적인 열기 요청(모바일 새 Operation 버튼 등)은 왕복이 아니라 언제나 펼침이다 — 펼쳐진 바에서
  // 열기를 누른 사용자를 물러나게 하면 버튼이 거꾸로 동작한다.
  const expandRequest = state.quickLaunchExpandRequest;
  const lastExpandRequestRef = useRef(expandRequest);
  useEffect(() => {
    if (expandRequest === lastExpandRequestRef.current) return;
    lastExpandRequestRef.current = expandRequest;
    if (pinned) expandAndFocus({ addressFocused: true });
  }, [expandAndFocus, expandRequest, pinned]);

  // 거절이 초안과 함께 돌아왔을 때, 고정 상태에는 "열림 전이"가 없어 초안 복원 경로가 없다.
  // 상주하는 컴포저는 초안이 도착하는 즉시 그것을 싣고 펼쳐야 한다.
  useEffect(() => {
    if (!pinned || state.quickLaunchDraft === null) return;
    // 복원은 고정 컴포저의 세션 경계다 — 에포크를 올리지 않으면 진행 중이던 멘션 성공이
    // 방금 복원된 초안을 finishSubmission으로 지워 버린다(모달의 열림 전이와 같은 계약).
    composerEpochRef.current += 1;
    setPrompt(state.quickLaunchDraft);
    // 복원은 교체다(텍스트와 같은 의미론) — 발사 후 새로 붙인 칩은 물러나되, 그 URL·서버 파일을
    // 조용히 버리지 않고 거둔다. 고정 컴포저는 열림 전이(에포크 승급)가 없어 진행 중 업로드는
    // 취소 집합으로만 회수된다.
    const restoredPreviews = new Set((state.quickLaunchDraftAttachments ?? []).map((attachment) => attachment.previewUrl));
    for (const attachment of attachmentsRef.current) {
      if (restoredPreviews.has(attachment.previewUrl)) continue;
      if (attachment.uploading) {
        canceledUploadKeysRef.current.add(attachment.key);
        continue;
      }
      URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.id !== null) void attachmentPluginRef.current?.discardLaunchAttachment?.(attachment.id).catch(() => {});
    }
    // 거절과 함께 돌아온 첨부 칩도 같은 슬롯에서 되살린다(열림 전이 복원과 같은 계약).
    setAttachments((state.quickLaunchDraftAttachments ?? []).map((attachment) => ({
      key: attachment.id,
      id: attachment.id,
      name: attachment.name,
      previewUrl: attachment.previewUrl,
      uploading: false,
    })));
    consumeQuickLaunchDraft();
    expandAndFocus();
  }, [expandAndFocus, pinned, state.quickLaunchDraft, state.quickLaunchDraftAttachments]);

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
    setAttachmentErrorKey(null);
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

  const pickMention = useCallback((target: QuickLaunchMentionTarget) => {
    const element = inputRef.current;
    if (mentionToken) {
      setPrompt((current) => stripMentionToken(current, mentionToken));
      // 제어 컴포넌트라 값 반영 뒤에야 높이를 잴 수 있다 — 다음 프레임에 줄어든 값으로 다시 잰다.
      if (element) requestAnimationFrame(() => autoGrow(element));
    }
    setMentionTarget(target);
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

  // 게이트는 이 덱을 보는 동안만 열려 있다. `/effort` 값 레벨을 떠나면(명령 목록으로 돌아가든,
  // 다른 커맨드로 가든, 덱을 닫든) 접힌 상태로 복귀한다 — 트랙이 apex 아닌 단으로 내려오면
  // 스스로 접히는 것과 같은 계약이고, 다음 방문이 열린 채로 시작하는 놀라움을 없앤다.
  // 컴포저가 닫히는 것도 떠나는 것이다: 컴포넌트는 언마운트되지 않고 렌더만 접으므로(`if (!open)
  // return null`), 문면이 `/effort `인 채 보존된 초안으로 돌아오면 commandInput이 그대로라
  // open을 조건에 넣지 않으면 게이트가 펼쳐진 채 되살아난다.
  useEffect(() => {
    if (open && commandInput?.kind === "values" && commandInput.command === "effort") return;
    setCommandGateOpen(false);
  }, [commandInput, open]);

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
      // 실행 종류가 채팅으로 태어날 수 있다고 선언했을 때만 선다.
      if (chatStartAvailable) {
        push("view", "/view", t("chrome.quickLaunch.commandStartView"), <ChatBubbleIcon />,
          t(chatStart ? "chrome.quickLaunch.startViewChat" : "chrome.quickLaunch.startViewTerminal"),
          () => applyCommandPrompt("/view "));
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
                // 행은 공급자 마크를 달지 않는다. 섹션은 행이 남을 때만 렌더되므로(아래 filter)
                // 밴드 없는 행은 존재할 수 없고, 밴드가 스크롤을 따라 붙어 있어(CSS sticky)
                // 좁힌 목록에서도 출처가 사라지지 않는다 — 행 마크는 순전한 중복이었다.
                return {
                  id: `model-${row.id}`,
                  label: row.label,
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
    if (commandInput.command === "view") {
      // 능력이 사라진 뒤 남은 문면("/view ")은 빈 덱이 된다 — 매치 없는 덱이 Enter를 막지 않는
      // 계약이 회복을 보장하므로 여기서 따로 되돌리지 않는다.
      if (!chatStartAvailable) return [];
      const rows = ([
        { id: "terminal", label: t("chrome.quickLaunch.startViewTerminal"), hint: t("chrome.quickLaunch.startViewTerminalHint") },
        { id: "chat", label: t("chrome.quickLaunch.startViewChat"), hint: t("chrome.quickLaunch.startViewChatHint") },
      ] as const)
        .filter((option) => option.label.toLowerCase().includes(query) || option.id.startsWith(query))
        .map<QuickLaunchCommandRow>((option) => ({
          id: `view-${option.id}`,
          label: option.label,
          value: option.hint,
          lead: <span className="quick-launch-command-icon" aria-hidden="true">{option.id === "chat" ? <ChatBubbleIcon /> : <TerminalViewIcon />}</span>,
          checked: option.id === (chatStart ? "chat" : "terminal"),
          pick: () => {
            setStartView(option.id);
            // 칩 픽커와 같은 "고르면 기억" 계층.
            writeQuickLaunchStartView(option.id);
            finishCommand();
          },
        }));
      return rows.length === 0 ? [] : [{ key: "views", band: null, rows }];
    }
    // 게이트된 apex 단은 트랙의 ✦ 계약을 미러링한다 — 덱에서는 맨 아래 문 행이 그 토글이다.
    const effortQuery = commandInput.query;
    const autoLabel = t("launchVariants.effort.auto");
    const deck = buildQuickLaunchEffortDeck(selectedRow, effort, autoLabel, effortQuery, commandGateOpen);
    const rows = deck.options.map<QuickLaunchCommandRow>((chip) => ({
      id: `effort-${chip.id ?? "auto"}`,
      label: chip.label,
      checked: chip.checked,
      effortLevel: chip.id ?? "auto",
      apex: chip.apex,
      pick: () => {
        setEffort(chip.id);
        writeQuickLaunchModelEffort(model, chip.id);
        finishCommand();
      },
    }));
    // 문 행은 값이 아니라 문이다. 골라도 덱은 열려 있고 문면도 그대로 — 트랙의 ✦을 눌렀을 때
    // 트랙이 그 자리에 남아 있는 것과 같다. 게이트 단을 하나도 내놓지 않는 모델에서는 서지 않아,
    // "이 모델엔 없다"가 "접혀 있다"와 처음으로 갈린다.
    if (deck.showGateRow) {
      // 이름은 이 덱이 실제로 열 단에서만 나온다(deck.gatedNames). 트랙의 사다리 기준을 빌려 오면
      // 축에만 오른 단까지 이름에 실려, 열었을 때 없는 단을 약속하게 된다.
      rows.push({
        id: "effort-gate",
        label: t(
          deck.gateOpen ? "launchVariants.effort.apexCollapse" : "launchVariants.effort.apexToggle",
          { tiers: deck.gatedNames },
        ),
        lead: <span className="quick-launch-command-gate-glyph" aria-hidden="true">{deck.gateOpen ? "‹" : "✦"}</span>,
        gate: true,
        pick: () => {
          const nextOpen = !deck.gateOpen;
          // 문 행은 늘 목록의 마지막이다. 게이트를 열면 단 둘이 그 앞에 끼어드는데 활성 인덱스를
          // 그대로 두면 같은 자리가 MAX를 가리켜, 접으려고 누른 두 번째 Enter가 MAX를 확정하고
          // 저장까지 한다 — 게이트가 막으려던 바로 그 실수다. 다음 목록에서 문 행이 설 자리로
          // 옮겨 둔다(값 행 뒤가 언제나 그 자리다).
          setCommandActiveIndex(
            buildQuickLaunchEffortDeck(selectedRow, effort, autoLabel, effortQuery, nextOpen).options.length,
          );
          setCommandGateOpen(nextOpen);
        },
      });
    }
    return rows.length === 0 ? [] : [{ key: "efforts", band: null, rows }];
  }, [activeTheater, applyCommandPrompt, chatStart, chatStartAvailable, commandGateOpen, commandInput, dockSuppressed, effort, expandAndFocus, finishCommand, groups, model, pinned, selectedRow, t, theaterId, theaters]);

  const commandRowsFlat = useMemo(() => commandSections.flatMap((section) => section.rows), [commandSections]);
  const commandDeckOpen = commandInput !== null;
  // 멘션 덱과 같은 계약: 행이 있는 덱만 Enter/Tab/제출을 가로챈다 — 매치가 없으면
  // "/etc/hosts 확인해줘" 같은 프로즈이므로 Enter는 평소처럼 제출로 흐른다.
  const commandDeckHasRows = commandDeckOpen && commandRowsFlat.length > 0;
  const activeCommandRow = commandRowsFlat.length === 0
    ? null
    : commandRowsFlat[Math.min(commandActiveIndex, commandRowsFlat.length - 1)] ?? null;
  const activeCommandOptionId = commandDeckOpen && activeCommandRow
    ? `quick-launch-command-${activeCommandRow.id}`
    : undefined;
  const activeMentionOptionId = mentionDeckOpen && activeMention
    ? `quick-launch-mention-${activeMention.kind === "operation" ? activeMention.entry.operationId : activeMention.row.optionId}`
    : undefined;

  // 잘린 덱에서 하이라이트만 움직이면 활성 행이 화면 밖으로 나간다 — 팔레트·useSelect와
  // 같은 nearest 스크롤을 방향키 인덱스와 짝으로 둔다. 옵션 id는 aria-activedescendant와 공유한다.
  useEffect(() => {
    const optionId = activeCommandOptionId ?? activeMentionOptionId;
    if (!optionId) return;
    document.getElementById(optionId)?.scrollIntoView({ block: "nearest" });
  }, [activeCommandOptionId, activeMentionOptionId]);

  // 첨부 능력은 실행 대상 플러그인이 선언한다 — console-core는 어느 플러그인인지 모른 채
  // 능력의 존재로만 붙여넣기를 받는다(messageOperation과 같은 계약). 능력이 없으면 기존처럼 무반응.
  const attachmentPlugin = useMemo(
    () => (target ? registry.plugins.find((plugin) => plugin.id === target.pluginId) : undefined),
    [registry.plugins, target],
  );
  // 열림 전이 효과는 의존성에 플러그인을 올리지 않는다(열림에만 반응하는 계약) — 회수 호출은 ref로 읽는다.
  const attachmentPluginRef = useRef(attachmentPlugin);
  attachmentPluginRef.current = attachmentPlugin;

  const addAttachmentFiles = useCallback((files: readonly File[]) => {
    const images = files.filter((file) => isQuickLaunchAttachmentCandidate(file));
    // 이미지가 하나도 없으면 어떤 사유도 말하지 않는다 — 텍스트 붙여넣기·비이미지 드롭은 조용히 지나간다.
    if (images.length === 0) return;
    const upload = attachmentPlugin?.uploadLaunchAttachment;
    if (!upload) {
      // 카탈로그가 아직 도착하지 않은 창(또는 능력 미선언 대상) — 삼키지 않고 재시도를 청한다.
      setAttachmentErrorKey("chrome.quickLaunch.errorAttachmentUploadFailed");
      return;
    }
    setAttachmentErrorKey(null);
    // 상태 갱신은 배치되므로 상한은 로컬 카운터로 센다 — ref만 보면 같은 드롭의 앞 장이 안 보인다.
    let count = attachmentsRef.current.length;
    for (const file of images) {
      if (count >= QUICK_LAUNCH_MAX_ATTACHMENTS) {
        setAttachmentErrorKey("chrome.quickLaunch.errorAttachmentLimit");
        break;
      }
      if (file.size > QUICK_LAUNCH_ATTACHMENT_MAX_BYTES) {
        setAttachmentErrorKey("chrome.quickLaunch.errorAttachmentTooLarge");
        continue;
      }
      count += 1;
      const key = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      const name = file.name.length > 0 ? file.name : "pasted image";
      setAttachments((current) => [...current, { key, id: null, name, previewUrl, uploading: true }]);
      void upload(file)
        .then(({ id }) => {
          // 칩의 생사는 key로 판정한다 — 컴포저가 닫혀 있어도 칩은 상태에 살아 있으므로(초안
          // 보존 계약) 완료를 그대로 승급시키고, 명시 취소(× 클릭·거절 복원 교체)나 칩이
          // 사라진 완료만 방금 받은 id를 서버에서 도로 거둔다.
          if (canceledUploadKeysRef.current.delete(key) || !attachmentsRef.current.some((attachment) => attachment.key === key)) {
            URL.revokeObjectURL(previewUrl);
            void attachmentPluginRef.current?.discardLaunchAttachment?.(id).catch(() => {});
            return;
          }
          setAttachments((current) => current.map((attachment) => (attachment.key === key ? { ...attachment, id, uploading: false } : attachment)));
        })
        .catch((error: unknown) => {
          URL.revokeObjectURL(previewUrl);
          if (canceledUploadKeysRef.current.delete(key)) return;
          if (!attachmentsRef.current.some((attachment) => attachment.key === key)) return;
          setAttachments((current) => current.filter((attachment) => attachment.key !== key));
          // 플러그인이 서버 거절 코드를 message로 실어 던진다(멘션 전달과 같은 형태).
          setAttachmentErrorKey(quickLaunchAttachmentErrorMessageKey(error instanceof Error ? error.message : null));
        });
    }
  }, [attachmentPlugin, mentionTarget]);

  const removeAttachment = useCallback((key: string) => {
    const found = attachmentsRef.current.find((attachment) => attachment.key === key);
    if (found) {
      URL.revokeObjectURL(found.previewUrl);
      // 서버의 미발사분도 함께 거둔다 — best-effort라 실패해도 TTL이 회수한다. 아직 업로드 중이면
      // id가 없으므로 취소 집합에 남겨, 완료 콜백이 도착하는 id를 그 자리에서 거두게 한다.
      if (found.id !== null) void attachmentPlugin?.discardLaunchAttachment?.(found.id).catch(() => {});
      else canceledUploadKeysRef.current.add(key);
    }
    setAttachments((current) => current.filter((attachment) => attachment.key !== key));
    setZoomedKey((current) => (current === key ? null : current));
    setAttachmentErrorKey(null);
    inputRef.current?.focus();
  }, [attachmentPlugin]);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => isQuickLaunchAttachmentCandidate(file));
    if (files.length === 0) return;
    // 이미지가 실린 붙여넣기만 가로챈다 — 텍스트 붙여넣기는 브라우저 기본 동작 그대로 흐른다.
    // 능력·멘션 판정은 addAttachmentFiles가 사유와 함께 말한다(조건 없는 삼킴을 만들지 않는다).
    event.preventDefault();
    addAttachmentFiles(files);
  }, [addAttachmentFiles]);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // 자식 사이를 오가는 이동은 이탈이 아니다 — 카드 밖으로 나갈 때만 하이라이트를 내린다.
    const next = event.relatedTarget;
    if (next instanceof Node && cardRef.current?.contains(next)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    // 파일이 실린 드롭은 이미지가 아니어도, 능력 판정이 끝나기 전이어도 기본 동작을 막는다 —
    // 막지 않으면 브라우저가 그 파일로 내비게이션해 SPA째로 떠난다(카탈로그 로딩 창 포함).
    event.preventDefault();
    addAttachmentFiles(files);
  }, [addAttachmentFiles]);

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
  const finishSubmission = useCallback((deliveredText: string | null = null, options: { readonly keepAttachments?: boolean } = {}) => {
    // 발사된 칩은 두 경로 모두에서 즉시 내려놓는다 — 모달 경로에서 남기면 다음 열림 전이의
    // 회수 루프가, 진행 중인 실행이 거절 복원용으로 들고 있는 previewUrl을 revoke해 버린다.
    // revoke는 하지 않는다: 그 URL의 소유권은 실행 의도(성공 시 Operations 화면이 회수)로 넘어갔다.
    // 멘션 전달은 전달된 칩을 스스로 정확히 걷어냈다 — 남은 칩(전달 중 새로 붙은 것)은 산 초안이다.
    if (!options.keepAttachments) setAttachments([]);
    setAttachmentErrorKey(null);
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
    // 업로드가 끝나지 않은 첨부가 있는 발사는 그 이미지를 조용히 빼고 나간다 — 끝날 때까지 잠근다.
    if (attachments.some((attachment) => attachment.uploading)) return;
    if (mentionTarget?.kind === "plugin") {
      const row = mentionTarget.row;
      const plugin = registry.plugins.find((candidate) => candidate.id === row.pluginId);
      if (!plugin?.messageMentionTarget) return;
      // 비-Operation 행선지는 첨부를 받지 않는다 — 조용히 빼면 그 이미지를 본다고 믿은 채 답을 읽는다.
      if (attachments.length > 0) {
        setAttachmentErrorKey("chrome.quickLaunch.errorMentionAttachments");
        return;
      }
      setSubmitting(true);
      setMentionErrorKey(null);
      const epoch = composerEpochRef.current;
      void plugin.messageMentionTarget(row.targetId, text)
        .then(() => {
          if (composerEpochRef.current !== epoch) return;
          finishSubmission(text);
        })
        .catch((error: unknown) => {
          if (composerEpochRef.current !== epoch) return;
          setSubmitting(false);
          setMentionErrorKey(quickLaunchMentionErrorMessageKey(error instanceof Error ? error.message : null));
        });
      return;
    }
    if (mentionTarget) {
      const entry = mentionTarget.entry;
      const plugin = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
      if (!plugin?.messageOperation) return;
      // 칩은 실행 대상 플러그인의 스토어에 업로드됐다 — id는 그 스토어의 불투명 토큰이라 다른
      // 플러그인의 세션에는 실을 수 없다(오늘은 단일 플러그인이라 도달 불가한 가드).
      if (attachments.length > 0 && entry.pluginId !== target?.pluginId) {
        setAttachmentErrorKey("chrome.quickLaunch.errorAttachmentUploadFailed");
        return;
      }
      setSubmitting(true);
      setMentionErrorKey(null);
      // 첨부는 런치와 같은 불투명 id로 동승한다 — 서버가 세션의 PTY(또는 chat 턴)에 경로 지시를
      // 합성하고, 전달 성공 시에만 그 세션에 묶는다.
      const deliveredAttachments = attachments
        .filter((attachment) => attachment.id !== null)
        .map((attachment) => ({ id: attachment.id as string, previewUrl: attachment.previewUrl }));
      // 전달 성공 시 화면 전환 없이 닫기만 한다(제품 결정: 지금 보던 것을 떠나지 않는다).
      // 실패는 초안·멘션·칩을 그대로 지킨 채 거절 사유만 바에 싣는다. 콜백은 세션 에포크를 검사한다 —
      // 느린 재기동 중 Escape로 닫고 다시 연 컴포저를 옛 promise가 닫거나 스테일 에러로 칠하면 안 된다.
      const epoch = composerEpochRef.current;
      void plugin.messageOperation(entry.operationId, text, deliveredAttachments.map((attachment) => attachment.id))
        .then(() => {
          // 전달이 확정된 순간, 같은 id를 단 칩은 어느 세션에 복원돼 있든 이미 발사된 것이다 —
          // 남기면 재제출 전체가 attachment_not_found로 굳는다. 상태에서 그 칩만 정확히 걷어내고
          // 미리보기를 거둔다(전달 중 새로 붙은 칩은 건드리지 않는다).
          const deliveredIds = new Set(deliveredAttachments.map((attachment) => attachment.id));
          setAttachments((current) => current.filter((attachment) => attachment.id === null || !deliveredIds.has(attachment.id)));
          for (const attachment of deliveredAttachments) URL.revokeObjectURL(attachment.previewUrl);
          // 에포크가 지났으면(닫고 재연 세션) 여기까지만 — 텍스트 초안은 건드리지 않는다
          // (전달된 문장이 초안으로 남는 것은 텍스트 멘션의 기존 계약과 같다).
          if (composerEpochRef.current !== epoch) return;
          // 전달된 문장을 넘겨 이 제출이 보존한 초안만 소비하게 한다. 전달 중 붙인 칩은
          // finishSubmission이 지우지 않는다(keepAttachments) — 조용한 소멸이 초안 보존 계약을 깬다.
          finishSubmission(text, { keepAttachments: true });
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
    // 터미널은 키를 생략한다 — 기본이 곧 계약이라, 이 키를 모르는 구버전 플러그인도 같은 길을 탄다.
    if (chatStart) variant.viewMode = "chat";
    // 첨부는 서버가 만든 불투명 id의 CSV로 실린다(variant는 flat string 레코드 계약).
    // 이름·미리보기는 거절 복원용 자취로 실행 의도에 따로 실린다 — 경로는 어느 쪽에도 없다.
    const launchedAttachments: QuickLaunchDraftAttachment[] = attachments
      .filter((attachment) => attachment.id !== null)
      .map((attachment) => ({ id: attachment.id as string, name: attachment.name, previewUrl: attachment.previewUrl }));
    if (launchedAttachments.length > 0) variant.attachments = launchedAttachments.map((attachment) => attachment.id).join(",");
    // 고정은 저장된 값을 그대로 다시 쓴다 — 화면별 실효값(설정에서는 접어 두므로 거짓)을 저장하면
    // 그 화면에서 한 번 실행한 것만으로 사용자의 고정 설정이 조용히 꺼진다.
    // 시작 표면도 같은 전체 되쓰기에 실린다 — 한 필드라도 빠지면 그 옵트인이 조용히 꺼진다.
    writeQuickLaunchSelection({ theaterId, model, effort, pinned: state.quickLaunchPinned, mentionFocused, view: startView });
    // 대상 Theater로 전환한 뒤 Operations로 이동한다. 실행은 그 화면이 자기 지오메트리·포커스 규율로
    // 수행한다(pendingOperationFocus와 같은 request/consume 계약) — 컴포저는 의도만 넘긴다.
    setActiveTheater(theaterId);
    requestQuickLaunch({
      theaterId,
      pluginId: target.pluginId,
      kind: target.kind,
      variant,
      ...(launchedAttachments.length > 0 ? { attachments: launchedAttachments } : {}),
    });
    navigate("/operations");
    finishSubmission();
  }, [attachments, chatStart, commandDeckHasRows, deckHasRows, effort, finishSubmission, mentionFocused, mentionTarget, model, navigate, prompt, registry.plugins, selectedRow, startView, state.quickLaunchPinned, submitting, target, theaterId]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // 확대 보기가 최상단 레이어다 — 컴포저를 닫기 전에 그것부터 접는다. 판정은 실제로 떠 있는
      // 파생값으로 한다: 칩이 사라져 스테일해진 key가 Escape 한 번을 조용히 삼키면 안 된다.
      if (zoomedAttachment !== null) {
        setZoomedKey(null);
        return;
      }
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
  }, [closePopover, pinned, popover, zoomedAttachment]);

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

  const toggleMentionFocused = useCallback(() => {
    const next = !mentionFocused;
    setMentionFocused(next);
    writeQuickLaunchMentionFocused(next);
  }, [mentionFocused]);

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
    // caret이 인식된 `ultracode` 바로 뒤일 때의 **수식 없는** Backspace 한 번은 글자가 아니라 무장을
    // 지운다 — 그 다음 Backspace는 평소대로 'e'를 지운다. 눌러 두어(repeat) 지우는 사람에게서는 이
    // 한 번을 빼앗지 않는다: 삭제가 한 글자 늦게 시작되는 것으로 읽힌다.
    // 수식 키가 붙은 Backspace는 OS의 단어 삭제(⌥/Ctrl)·줄 삭제(⌘)라 손대지 않는다. 가로채면 방금
    // 친 단어를 지우려던 사람의 키가 아무것도 지우지 않는다(실측: ⌥+Backspace가 문면을 그대로 둠).
    if (event.key === "Backspace" && !event.repeat && ultracodeArmed
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && isUltracodeDisarmCaret(prompt, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)) {
      event.preventDefault();
      setUltracodeIgnored(true);
      return;
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
  }, [activeCommandRow, activeMention, applyCommandPrompt, clearMention, commandDeckHasRows, commandDeckOpen, commandInput, commandRowsFlat.length, deckHasRows, mentionDeckOpen, mentionTarget, pickMention, prompt, selectableMentions.length, submit, ultracodeArmed]);

  if (!open) return null;

  const promptLength = prompt.trim().length;
  const overLimit = promptLength > QUICK_LAUNCH_PROMPT_MAX_CHARS;
  const attachmentsUploading = attachments.some((attachment) => attachment.uploading);
  // 멘션 제출은 런치 좌표(theater/model/effort)가 필요 없다 — 행선지가 그 자리를 대신한다.
  // 행이 있는 덱이 열린 동안은 버튼도 잠근다(submit의 deckHasRows 가드와 같은 계약).
  // 업로드 중인 첨부도 같은 계약으로 잠근다(submit의 가드와 짝).
  const canSubmit = promptLength > 0 && !overLimit && !submitting && !deckHasRows && !commandDeckHasRows && !attachmentsUploading
    && (mentionTarget !== null || (!!theaterId && !!target && !!selectedRow));
  const modelLabel = selectedRow?.label ?? t("chrome.quickLaunch.modelUnset");
  const rejectionKey = quickLaunchErrorMessageKey(state.quickLaunchError, state.quickLaunchErrorShortenBy);
  // 거절은 접힘보다 우선한다 — 사유를 실은 바가 시선을 뗐다고 접히면, 클릭 한 번으로 사라지는
  // 에러가 된다. 상한 초과 경고도 같은 이유로 바를 펼친 채 붙잡는다.
  const holdsMessage = rejectionKey !== null || mentionErrorKey !== null || attachmentErrorKey !== null || overLimit;
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
  const modLabel = resolveModLabel();

  return (
    <div
      className={`quick-launch-overlay${pinned ? " is-pinned" : ""}`}
      onMouseDown={pinned ? undefined : (event) => { if (event.target === event.currentTarget) closeQuickLaunch(); }}
    >
      {/* 고정 상태는 모달이 아니다 — aria-modal을 벗어야 isBlockingDialogOpen이 이 표면을 차단으로
          읽지 않고, 뒤 화면의 단축키가 살아 있는 채로 공존한다(그것이 고정의 목적이다). */}
      <section
        ref={cardRef}
        className={`quick-launch-card${pinned ? " is-pinned" : ""}${showStrip ? " is-collapsed" : ""}${popover || zoomedAttachment ? " has-popover" : ""}${dragOver ? " is-dragover" : ""}${ultracodeArmed ? " is-ultracode" : ""}${chatStart ? " is-chat-start" : ""}`}
        role={pinned ? "region" : "dialog"}
        aria-modal={pinned ? undefined : true}
        aria-label={t(pinned ? "chrome.quickLaunch.dockedRegion" : "chrome.quickLaunch.dialog")}
        tabIndex={pinned ? undefined : -1}
        onKeyDown={handleKeyDown}
        onFocus={handleFocusIn}
        onBlur={handleFocusOut}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{ maxWidth: CARD_WIDTH_FALLBACK }}
      >
        {/* 접힌 한 줄 — 물러난 바가 남기는 유일한 컨트롤이다. 초안 자취를 싣고, 누르면 펼쳐진다.
            접힌 동안 아래 컨트롤은 inert라 Tab이 닿지 않으므로 이 버튼이 되돌아오는 통로다. */}
        {pinned ? (
          <ComposerRestStrip
            className="quick-launch-strip"
            onClick={() => expandAndFocus({ addressFocused: true })}
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
            <span className="quick-launch-strip-keys" aria-hidden="true">
              {QUICK_LAUNCH_TOGGLE_COMBOS.map((combo, index) => (
                <span key={combo.join("+")}>
                  {index > 0 ? <span className="quick-launch-strip-or">{t("chrome.shortcuts.or")}</span> : null}
                  <kbd className="quick-launch-strip-key">{formatShortcutCombo(combo, modLabel)}</kbd>
                </span>
              ))}
            </span>
          </ComposerRestStrip>
        ) : null}

        {mentionDeckOpen ? (
          <div className="quick-launch-mention-deck theater-menu" role="listbox" id="quick-launch-mention-deck" aria-label={t("chrome.quickLaunch.mentionDeck")}>
            {/* Operations 밴드는 행이 있을 때만, 그리고 아무 카테고리도 없을 때만 선다 — 두 번째
                카테고리가 서 있는데 빈 Operations 머리만 남기면 덱에 죽은 줄이 생긴다. */}
            {mentionEntries.length > 0 || pluginMentionRows.length === 0 ? (
              <p className="quick-launch-mention-category">
                <span>{t("chrome.quickLaunch.mentionCategoryOperations")}</span>
                <span className="quick-launch-mention-category-rule" aria-hidden="true" />
              </p>
            ) : null}
            {mentionEntries.length === 0 ? (
              pluginMentionRows.length === 0
                ? <p className="quick-launch-mention-empty">{t("chrome.quickLaunch.mentionNoMatch")}</p>
                : null
            ) : mentionGroups.map((group) => (
              <div key={group.theaterId ?? "__unassigned__"}>
                <p className="quick-launch-pop-band">{group.theaterLabel}</p>
                {group.entries.map((entry) => {
                  const selectable = isMentionSelectable(entry.activity);
                  const active = selectable && activeMention?.kind === "operation" && activeMention.entry === entry;
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
                      onClick={() => { if (selectable) pickMention({ kind: "operation", entry }); }}
                    >
                      <span className="quick-launch-mark" aria-hidden="true">{theaterInitials(entry.theaterLabel)}</span>
                      <span className="quick-launch-mention-operation-mark">
                        <OperationNameMark
                          operation={entry}
                          status={resolveOperationMarkVisual({
                            activity: entry.activity,
                            operationId: entry.operationId,
                            idleArrivalIds,
                          })}
                        />
                      </span>
                      <span className="quick-launch-mention-name">{entry.operationName}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {/* 플러그인이 기여한 행선지. Theater 밴드도 활동 배지도 없다 — 대신 능력 문구가
                카테고리 머리와 행 배지에 서서, 고르기 전에 무엇을 할 수 있는 대상인지 말한다. */}
            {pluginMentionCategories.map((category) => (
              <div key={category.key}>
                <p className="quick-launch-mention-category">
                  <span>{category.label}</span>
                  {category.capabilityLabel ? (
                    <span className="quick-launch-mention-category-note">{category.capabilityLabel}</span>
                  ) : null}
                  <span className="quick-launch-mention-category-rule" aria-hidden="true" />
                </p>
                {category.rows.map((row) => {
                  const active = activeMention?.kind === "plugin" && activeMention.row.optionId === row.optionId;
                  return (
                    <button
                      key={row.optionId}
                      id={`quick-launch-mention-${row.optionId}`}
                      type="button"
                      className={`quick-launch-mention-row${active ? " is-active" : ""}`}
                      role="option"
                      aria-selected={active}
                      aria-description={row.description ?? undefined}
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pickMention({ kind: "plugin", row })}
                    >
                      {row.renderMark ? (
                        <span className="quick-launch-mention-mark" aria-hidden="true">{row.renderMark()}</span>
                      ) : null}
                      <span className="quick-launch-mention-name">{row.label}</span>
                      {row.capabilityLabel ? (
                        <span className="quick-launch-mention-capability">{row.capabilityLabel}</span>
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
                      : commandInput?.command === "view"
                        ? t("chrome.quickLaunch.startViewMenu")
                        : t("launchVariants.effort.track")}
              </span>
              <span className="quick-launch-mention-category-rule" aria-hidden="true" />
            </p>
            {commandRowsFlat.length === 0 ? (
              <p className="quick-launch-mention-empty">{t("chrome.quickLaunch.commandNoMatch")}</p>
            ) : commandSections.map((section) => (
              // 밴드가 선 섹션의 행은 밴드 라벨 자리까지 들여쓴다(CSS). 행이 밴드보다 바깥에서
              // 시작하면 항목이 자기 머리글보다 앞에 서서 소속이 역전돼 읽힌다.
              <div key={section.key} className={section.band ? "quick-launch-command-group is-banded" : "quick-launch-command-group"}>
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
                      className={`quick-launch-mention-row quick-launch-command-row${active ? " is-active" : ""}${row.gate ? " is-gate" : ""}`}
                      role="option"
                      aria-selected={active}
                      // 문 행에 aria-expanded를 달지 않는다 — option role이 지원하는 상태가 아니라
                      // 무시되거나 무효로 읽힌다. 여는지 접는지는 라벨 자체가 말한다("… 펼치기" ↔
                      // "… 접기"). 이 행을 listbox 밖으로 빼면 유효한 토글 role을 쓸 수 있지만,
                      // aria-activedescendant 순회에서 빠져 키보드 문법이 값 행과 갈라진다.
                      tabIndex={-1}
                      data-effort-level={row.effortLevel}
                      data-apex={row.apex ? true : undefined}
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

        {/* 무장 중에 카드 외곽을 도는 apex 링(CSS)과 짝을 이루는 문장. 바에는 칩을 두지 않는다 —
            칩이 실행 버튼을 둘째 줄로 떨어뜨렸고, 상태는 이 줄과 단어 하이라이트가 말한다.
            물러난 바(showStrip)에서는 내린다: 이 줄은 접히는 field·bar 밖에 있어, 남겨 두면 한 줄로
            물러났다는 도킹이 그 위에 상태 줄 하나를 더 이고 선다(실측 45px 스트립 + 27px 고지). */}
        {ultracodeArmed && !showStrip ? (
          <p className="quick-launch-ultracode-notice" role="status">
            <span className="quick-launch-ultracode-glyph" aria-hidden="true">✦</span>
            <span>{t("chrome.quickLaunch.ultracodeNotice")}</span>
            <span className="quick-launch-ultracode-notice-hint">{t("chrome.quickLaunch.ultracodeNoticeHint")}</span>
          </p>
        ) : null}

        {/* 시작 표면 무장 줄. `ultracode` 고지와 달리 횟수로 물러나지 않는다 — 저건 한 번 배우면
            칩이 대신 말하는 문장이지만, 이 상태에는 바에 설 칩이 없다(바 첫 줄 여유가 0이라 배지를
            두지 않기로 한 결정). 이 줄과 카드 외곽선이 무장의 **유일한** 표식이므로, 기억된 선택이
            숨은 모드가 되지 않으려면 무장한 동안 항상 서 있어야 한다.
            멘션 중에도 남는다: 행선지가 있으면 발사 좌표는 접히지만, 그때는 이 값이 실려 가지
            않으므로 문구 자체가 "이번엔 적용되지 않는다"고 말한다. */}
        {chatStart && !showStrip ? (
          <p className="quick-launch-start-view-notice" role="status">
            <span className="quick-launch-start-view-glyph" aria-hidden="true"><ChatBubbleIcon /></span>
            <span>{t(mentionTarget ? "chrome.quickLaunch.startViewNoticeMuted" : "chrome.quickLaunch.startViewNotice")}</span>
            <button
              type="button"
              className="quick-launch-start-view-undo"
              onClick={() => { setStartView("terminal"); writeQuickLaunchStartView("terminal"); expandAndFocus(); }}
            >
              {t("chrome.quickLaunch.startViewUndo")}
            </button>
          </p>
        ) : null}

        {/* 접힌 동안 입력과 컨트롤은 inert다 — max-height:0만으로는 Tab이 보이지 않는 컨트롤에 닿는다
            (멘션 접힘이 쓰는 계약과 같다). */}
        <ComposerField className="quick-launch-field" inert={showStrip || undefined}>
          {mentionTarget ? (
            <span className="quick-launch-mention" title={mentionTargetName(mentionTarget)}>
              {/* Operation은 선택 뒤에도 공급자 출처를 되살리지 않는다 — 이름과 하단 행선지 태그가
                  대상을 말한다. 플러그인 대상의 mark는 공급자가 아니라 그 대상 자체의 정체성이다. */}
              {mentionTarget.kind === "plugin" && mentionTarget.row.renderMark ? (
                <span className="quick-launch-mention-mark" aria-hidden="true">{mentionTarget.row.renderMark()}</span>
              ) : null}
              <span className="quick-launch-mention-label">{mentionTargetName(mentionTarget)}</span>
            </span>
          ) : null}
          {/* textarea와 미러를 한 flex 아이템으로 묶는다 — 미러를 필드에 직접 붙이면 멘션 칩이 선
              줄에서 시작점이 어긋난다. 묶으면 정렬 기준이 textarea의 박스 하나로 줄어든다. */}
          <span className="quick-launch-input-wrap">
            {ultracodeArmed ? (
              <div className="quick-launch-highlight" ref={highlightRef} aria-hidden="true">
                {renderUltracodeHighlight(prompt, ultracodeTokens, "quick-launch-ultracode-token")}
              </div>
            ) : null}
          <ComposerInput
            ref={inputRef}
            className="quick-launch-input"
            rows={1}
            value={prompt}
            onChange={(event) => updatePrompt(event.target.value, event.target)}
            onKeyDown={handleInputKeyDown}
            onPaste={handlePaste}
            onScroll={syncUltracodeHighlight}
            placeholder={mentionTarget
              ? t(mentionTarget.kind === "operation"
                ? "chrome.quickLaunch.mentionPlaceholder"
                : "chrome.quickLaunch.mentionPlaceholderOther", { name: mentionTargetName(mentionTarget) })
              : chatStart
                ? t("chrome.quickLaunch.startViewChatPlaceholder")
                : t("chrome.quickLaunch.placeholder")}
            aria-label={t("chrome.quickLaunch.promptLabel")}
            aria-controls={mentionDeckOpen ? "quick-launch-mention-deck" : commandDeckOpen ? "quick-launch-command-deck" : undefined}
            aria-activedescendant={activeMentionOptionId ?? activeCommandOptionId}
            spellCheck={false}
          />
          </span>
          {attachments.length > 0 ? (
            <div className="quick-launch-attachments" role="group" aria-label={t("chrome.quickLaunch.attachments")}>
              {attachments.map((attachment) => (
                <span key={attachment.key} className={`quick-launch-attachment${attachment.uploading ? " is-uploading" : ""}`}>
                  {/* 썸네일 클릭은 확대 보기 토글이다 — 52px 칩만으로는 무엇을 붙였는지 확신할 수 없다. */}
                  <button
                    type="button"
                    className="quick-launch-attachment-thumb-button"
                    onClick={() => setZoomedKey((current) => (current === attachment.key ? null : attachment.key))}
                    aria-pressed={zoomedKey === attachment.key}
                    aria-label={t("chrome.quickLaunch.attachmentZoom", { name: attachment.name })}
                    title={t("chrome.quickLaunch.attachmentZoom", { name: attachment.name })}
                  >
                    <img className="quick-launch-attachment-thumb" src={attachment.previewUrl} alt={attachment.name} />
                  </button>
                  {attachment.uploading ? (
                    <span className="quick-launch-attachment-wait" role="status" aria-label={t("chrome.quickLaunch.attachmentUploading", { name: attachment.name })} />
                  ) : null}
                  <button
                    type="button"
                    className="quick-launch-attachment-remove"
                    onClick={() => removeAttachment(attachment.key)}
                    aria-label={t("chrome.quickLaunch.attachmentRemove", { name: attachment.name })}
                    title={t("chrome.quickLaunch.attachmentRemove", { name: attachment.name })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {zoomedAttachment ? (
            // 클릭·Escape로 닫히는 확대 레이어. 칩이 제거·소비되면 파생이 스스로 사라진다.
            <div
              className="quick-launch-attachment-zoom"
              role="img"
              aria-label={zoomedAttachment.name}
              onClick={() => setZoomedKey(null)}
            >
              <img src={zoomedAttachment.previewUrl} alt={zoomedAttachment.name} />
            </div>
          ) : null}
        </ComposerField>

        <ComposerBar className="quick-launch-bar" ref={barRef} inert={showStrip || undefined}>
          {/* 멘션이 확정되면 런치 3종(theater/model/effort)은 접히고 행선지 태그가 그 자리를 잇는다 —
              한 입력의 행선지는 하나라는 사실을 바가 배타적으로 말한다. */}
          {/* inert는 접힘 전환(360ms) 동안에도 하위 컨트롤을 포커스 대상에서 즉시 제외한다 —
              visibility는 전환이 끝나야 뒤집혀 그 창 동안 Tab이 보이지 않는 칩에 닿는다. */}
          <span className={`quick-launch-launch-sel${mentionTarget ? " is-hidden" : ""}`} inert={mentionTarget !== null || undefined}>
          <ComposerChip
            ref={theaterChipRef}
            className="quick-launch-chip quick-launch-chip--theater"
            aria-expanded={popover === "theater"}
            onClick={() => setPopover(popover === "theater" ? null : "theater")}
          >
            <span className="quick-launch-mark" aria-hidden="true">{activeTheater ? theaterInitials(activeTheater.label) : "—"}</span>
            <span className="quick-launch-chip-label">{activeTheater?.label ?? t("chrome.quickLaunch.theaterUnset")}</span>
            <span className="quick-launch-caret" aria-hidden="true">▾</span>
          </ComposerChip>

          <ComposerChip
            ref={modelChipRef}
            className="quick-launch-chip quick-launch-chip--model"
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
          </ComposerChip>

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
              apexToggleLabel={t("launchVariants.effort.apexToggle", { tiers: gatedEffortNames(selectedRow) })}
              apexCollapseLabel={t("launchVariants.effort.apexCollapse", { tiers: gatedEffortNames(selectedRow) })}
              className="quick-launch-effort-track"
            />
          ) : null}
          </span>

          {mentionTarget ? (
            <span className="quick-launch-target-tag">
              <span className="quick-launch-target-dot" aria-hidden="true" />
              {/* 태그는 "종류 · 무엇"이다. 플러그인 대상은 Theater가 없으므로 그 자리에 이름이 선다 —
                  카테고리만 적으면 같은 카테고리의 어느 대상을 골랐는지 확인할 수 없다. */}
              <span>{mentionTarget.kind === "operation"
                ? t("chrome.quickLaunch.mentionTarget", { theater: mentionTarget.entry.theaterLabel })
                : t("chrome.quickLaunch.mentionTargetOther", { category: mentionTarget.row.categoryLabel, name: mentionTarget.row.label })}</span>
              {mentionTarget.kind === "plugin" && mentionTarget.row.capabilityLabel ? (
                <span className="quick-launch-target-capability">{mentionTarget.row.capabilityLabel}</span>
              ) : null}
            </span>
          ) : null}

          <span className="quick-launch-spacer" />
          {overLimit ? (
            <span className="quick-launch-overflow" role="status">
              {t("chrome.quickLaunch.tooLong", { over: String(promptLength - QUICK_LAUNCH_PROMPT_MAX_CHARS) })}
            </span>
          ) : attachmentErrorKey ? (
            // 첨부가 거절됐거나 지금 조합으로는 실을 수 없다. 칩·초안은 그대로 남았다.
            <span className="quick-launch-rejection" role="alert">
              {t(attachmentErrorKey as Parameters<typeof t>[0])}
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
          {/* 파일 픽커 — 붙여넣기·드롭과 같은 입구의 명시적 형태. 능력 있는 대상에서만 선다. */}
          {attachmentPlugin?.uploadLaunchAttachment ? (
            // 입구 폭은 paste·드롭과 같다(image/*, 블록 기본값) — 형식의 최종 판정자는 서버 매직 바이트 스니퍼다.
            <ComposerAttachControl
              className="quick-launch-attach"
              label={t("chrome.quickLaunch.attachmentAdd")}
              onFiles={(files) => addAttachmentFiles([...files])}
            />
          ) : null}
          {dockSuppressed || showStrip ? null : (
            <>
              <button
                type="button"
                className="quick-launch-mention-focus"
                aria-pressed={mentionFocused}
                onClick={toggleMentionFocused}
                aria-label={t(mentionFocused ? "chrome.quickLaunch.mentionFocusOff" : "chrome.quickLaunch.mentionFocusOn")}
                title={t(mentionFocused ? "chrome.quickLaunch.mentionFocusOff" : "chrome.quickLaunch.mentionFocusOn")}
              >
                <MentionFocusIcon />
              </button>
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
            </>
          )}
          <ComposerSubmitButton
            className="quick-launch-submit"
            disabled={!canSubmit}
            onClick={submit}
            // 시각 레이블이 없으므로 이름과 단축키를 여기서 싣는다. 무장 중에는 이 버튼이 무엇을
            // 하는지가 달라지므로 이름도 함께 바뀐다 — 안내줄을 못 읽는 사람에게는 여기가 유일한
            // 결과 재확인이다(멘션 중에는 이 값이 실려 가지 않으므로 평소 이름으로 돌아간다).
            aria-label={t(chatStart && !mentionTarget ? "chrome.quickLaunch.runChatWithKey" : "chrome.quickLaunch.runWithKey")}
            title={t(chatStart && !mentionTarget ? "chrome.quickLaunch.runChatWithKey" : "chrome.quickLaunch.runWithKey")}
          />

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
        </ComposerBar>
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

function MentionFocusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10.6 10.2A3.4 3.4 0 1 1 8 4.6c.7 0 1.3.2 1.8.6v.4A1.6 1.6 0 0 0 13 7.2V8A5 5 0 1 0 8 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
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
