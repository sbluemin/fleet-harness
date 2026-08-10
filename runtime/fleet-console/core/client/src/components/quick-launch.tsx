import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";

import type { OperationCatalogPlugin, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";

import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { readQuickLaunchSelection, writeQuickLaunchModelEffort, writeQuickLaunchSelection } from "../quick-launch-preferences.js";
import { findVariantLaunchKind, QUICK_LAUNCH_DEFAULT_MODEL, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchErrorMessageKey, resolveSelection } from "../quick-launch.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { closeQuickLaunch, consumeQuickLaunchDraft, requestQuickLaunch, setActiveTheater } from "../store.js";
import { launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph } from "./launch-provider-glyphs.js";
import { EffortTrack, isSpecialEffort, resolveRowEffort } from "./effort-track.js";

// 카드 폭은 팔레트(920px)보다 좁다 — 팔레트는 결과 목록을 담고, 여기는 한 문단을 담는다.
const CARD_WIDTH_FALLBACK = 760;
const POPOVER_GAP = 8;
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])";

type PopoverKind = "theater" | "model";

export function QuickLaunch() {
  const state = useConsoleState();
  const t = useT();
  const navigate = useNavigate();
  const registry = usePluginRegistry();

  const cardRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const theaterChipRef = useRef<HTMLButtonElement | null>(null);
  const modelChipRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

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

  const open = state.quickLaunchOpen;
  const theaters = state.theaters ?? [];
  const target = useMemo(() => findVariantLaunchKind(catalog), [catalog]);
  const groups = target?.kind.variants ?? [];

  const activeTheater = theaters.find((candidate) => candidate.id === theaterId) ?? null;
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const selectedRow = rows.find((row) => row.launch.model === model) ?? null;

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
    const remembered = readQuickLaunchSelection();
    const rememberedTheater = remembered.theaterId !== null && theaters.some((candidate) => candidate.id === remembered.theaterId)
      ? remembered.theaterId
      : null;
    // 거절된 실행이 남긴 초안이 있으면 그것으로 되살린다(store가 되열 때 실어 준다).
    setPrompt(state.quickLaunchDraft ?? "");
    consumeQuickLaunchDraft();
    setPopover(null);
    setSubmitting(false);
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

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

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
    const top = pop.getBoundingClientRect().top;
    const safePadding = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-5")) || 0;
    setPopoverMaxHeight(Math.max(0, window.innerHeight - top - safePadding));
  }, [popover, prompt, groups.length, theaters.length, viewportEpoch]);

  useEffect(() => {
    if (!popover) return;
    const handleResize = () => setViewportEpoch((epoch) => epoch + 1);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [popover]);

  const updatePrompt = useCallback((nextPrompt: string, element: HTMLTextAreaElement) => {
    setPrompt(nextPrompt);
    autoGrow(element);
  }, []);

  const closePopover = useCallback(() => setPopover(null), []);

  const submit = useCallback(() => {
    const text = prompt.trim();
    // 상한을 넘긴 요청은 서버가 반드시 400으로 거절한다. 그대로 보내면 컴포저만 닫히고 초안이
    // 사라지므로, 확실히 실패할 요청으로는 넘기지 않는다.
    if (text.length === 0 || text.length > QUICK_LAUNCH_PROMPT_MAX_CHARS || !theaterId || !target || !selectedRow || submitting) return;
    setSubmitting(true);
    const variant: Record<string, string> = { prompt: text };
    if (model) variant.model = model;
    if (effort) variant.effort = effort;
    writeQuickLaunchSelection({ theaterId, model, effort });
    // 대상 Theater로 전환한 뒤 Operations로 이동한다. 실행은 그 화면이 자기 지오메트리·포커스 규율로
    // 수행한다(pendingOperationFocus와 같은 request/consume 계약) — 컴포저는 의도만 넘긴다.
    setActiveTheater(theaterId);
    requestQuickLaunch({ theaterId, pluginId: target.pluginId, kind: target.kind, variant });
    navigate("/operations");
    closeQuickLaunch();
  }, [effort, model, navigate, prompt, selectedRow, submitting, target, theaterId]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (popover) {
        closePopover();
        (popover === "theater" ? theaterChipRef : modelChipRef).current?.focus();
        return;
      }
      closeQuickLaunch();
      return;
    }
    if (event.key === "Tab") trapFocus(event, cardRef.current);
  }, [closePopover, popover]);

  const handleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 제출 · Shift+Enter 개행 · IME 조합 중 Enter는 확정이지 제출이 아니다(Analyst 컴포저와 같은 계약).
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }, [submit]);

  if (!open) return null;

  const promptLength = prompt.trim().length;
  const overLimit = promptLength > QUICK_LAUNCH_PROMPT_MAX_CHARS;
  const canSubmit = promptLength > 0 && !overLimit && !!theaterId && !!target && !!selectedRow && !submitting;
  const modelLabel = selectedRow?.label ?? t("chrome.quickLaunch.modelUnset");
  const rejectionKey = quickLaunchErrorMessageKey(state.quickLaunchError, state.quickLaunchErrorShortenBy);
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
      className="quick-launch-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeQuickLaunch(); }}
    >
      <section
        ref={cardRef}
        className="quick-launch-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("chrome.quickLaunch.dialog")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{ maxWidth: CARD_WIDTH_FALLBACK }}
      >
        <div className="quick-launch-field">
          <textarea
            ref={inputRef}
            className="quick-launch-input"
            rows={1}
            value={prompt}
            onChange={(event) => updatePrompt(event.target.value, event.target)}
            onKeyDown={handleInputKeyDown}
            placeholder={t("chrome.quickLaunch.placeholder")}
            aria-label={t("chrome.quickLaunch.promptLabel")}
            spellCheck={false}
          />
        </div>

        <div className="quick-launch-bar" ref={barRef}>
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
                // 챔버 뒤의 단은 이 실행에만 실린다. 디스크에 남기면 다음 세션이 아무도 고르지 않은
                // 비싼 모드로 열려, 게이트를 둔 이유가 그대로 사라진다.
                writeQuickLaunchModelEffort(
                  model,
                  isSpecialEffort(selectedRow, nextEffort) ? null : nextEffort,
                );
              }}
              autoLabel={t("launchVariants.effort.auto")}
              ariaLabel={t("launchVariants.effort.track")}
              autoValueText={t("launchVariants.effort.autoValue")}
              revealLabel={t("launchVariants.effort.reveal")}
              collapseLabel={t("launchVariants.effort.collapse")}
              specialWarning={t("launchVariants.effort.specialWarning")}
              specialDescriptions={{
                max: t("launchVariants.effort.maxValue"),
                ultracode: t("launchVariants.effort.ultracodeValue"),
              }}
              className="quick-launch-effort-track"
            />
          ) : null}

          <span className="quick-launch-spacer" />
          {overLimit ? (
            <span className="quick-launch-overflow" role="status">
              {t("chrome.quickLaunch.tooLong", { over: String(promptLength - QUICK_LAUNCH_PROMPT_MAX_CHARS) })}
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
          {/* 힌트일 뿐 누를 수 있는 것이 아니다 — 테두리를 두르면 바 안에서 액션 행세를 한다. */}
          <span className="quick-launch-esc" aria-hidden="true">{t("chrome.quickLaunch.escHint")}</span>
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

function trapFocus(event: ReactKeyboardEvent<HTMLElement>, card: HTMLElement | null): void {
  if (!card) return;
  const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.offsetParent !== null);
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
