import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";

import type { OperationCatalogPlugin, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";

import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { readQuickLaunchSelection, writeQuickLaunchSelection } from "../quick-launch-preferences.js";
import { findVariantLaunchKind, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchErrorMessageKey, resolveSelection } from "../quick-launch.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { closeQuickLaunch, consumeQuickLaunchDraft, requestQuickLaunch, setActiveTheater } from "../store.js";
import { launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph } from "./launch-provider-glyphs.js";
import { QuickLaunchEffortMenu } from "./quick-launch-effort-menu.js";

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
  const theaterChipRef = useRef<HTMLButtonElement | null>(null);
  const modelChipRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);
  const [prompt, setPrompt] = useState("");
  const [theaterId, setTheaterId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [popover, setPopover] = useState<PopoverKind | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const open = state.quickLaunchOpen;
  const theaters = state.theaters ?? [];
  const target = useMemo(() => findVariantLaunchKind(catalog), [catalog]);
  const groups = target?.kind.variants ?? [];

  const activeTheater = theaters.find((candidate) => candidate.id === theaterId) ?? null;
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const selectedRow = rows.find((row) => row.launch.model === model) ?? null;
  const selectedChip = selectedRow?.chips?.find((chip) => chip.launch.effort === effort) ?? null;

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
    setModel(remembered.model);
    setEffort(remembered.effort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.activeTheaterId, theaters]);

  // 카탈로그가 도착하면 기억해 둔 조합을 실제 목록에 맞춘다.
  useEffect(() => {
    if (!open || groups.length === 0) return;
    const resolved = resolveSelection(groups, { model, effort });
    if (resolved.model !== model) setModel(resolved.model);
    if (resolved.effort !== effort) setEffort(resolved.effort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groups]);

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

  const closePopover = useCallback(() => setPopover(null), []);

  const submit = useCallback(() => {
    const text = prompt.trim();
    // 상한을 넘긴 요청은 서버가 반드시 400으로 거절한다. 그대로 보내면 컴포저만 닫히고 초안이
    // 사라지므로, 확실히 실패할 요청으로는 넘기지 않는다.
    if (text.length === 0 || text.length > QUICK_LAUNCH_PROMPT_MAX_CHARS || !theaterId || !target || submitting) return;
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
  }, [effort, model, navigate, prompt, submitting, target, theaterId]);

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
  const canSubmit = promptLength > 0 && !overLimit && !!theaterId && !!target && !submitting;
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
            onChange={(event) => {
              setPrompt(event.target.value);
              autoGrow(event.target);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={t("chrome.quickLaunch.placeholder")}
            aria-label={t("chrome.quickLaunch.promptLabel")}
            spellCheck={false}
          />
        </div>

        <div className="quick-launch-bar">
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
            {selectedChip ? <span className="quick-launch-effort">{selectedChip.label}</span> : null}
            <span className="quick-launch-caret" aria-hidden="true">▾</span>
          </button>

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
          <kbd className="quick-launch-esc">esc</kbd>
          <button
            type="button"
            className="quick-launch-submit"
            disabled={!canSubmit}
            onClick={submit}
          >
            {t("chrome.quickLaunch.run")}
            <kbd aria-hidden="true">↵</kbd>
          </button>

          {popover === "theater" ? (
            <div className="quick-launch-pop quick-launch-pop--theater theater-menu" role="menu" aria-label={t("chrome.quickLaunch.theaterMenu")}>
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
            <div className="quick-launch-pop quick-launch-pop--model theater-menu" role="menu" aria-label={t("chrome.quickLaunch.modelMenu")}>
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
                      selectedEffort={effort}
                      onPick={(nextModel, nextEffort) => {
                        setModel(nextModel);
                        setEffort(nextEffort);
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

function QuickLaunchVariantRow({ row, selectedModel, selectedEffort, onPick }: {
  readonly row: OperationLaunchVariantRow;
  readonly selectedModel: string | null;
  readonly selectedEffort: string | null;
  readonly onPick: (model: string | null, effort: string | null) => void;
}) {
  const rowModel = row.launch.model ?? null;
  const hasEffort = (row.chips?.length ?? 0) > 0;
  const [effortOpen, setEffortOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const openEffort = () => {
    cancelClose();
    if (hasEffort) setEffortOpen(true);
  };
  const closeEffort = () => setEffortOpen(false);
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      closeEffort();
    }, 160);
  };

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      ref={rowRef}
      className="quick-launch-variant-row"
      onPointerEnter={openEffort}
      onPointerLeave={scheduleClose}
      onFocus={openEffort}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && (event.currentTarget.contains(nextTarget) || effortMenuRef.current?.contains(nextTarget))) return;
        scheduleClose();
      }}
    >
      <button
        type="button"
        className={`quick-launch-variant-name${hasEffort ? " has-effort" : ""}`}
        role="menuitem"
        aria-current={rowModel === selectedModel && (selectedEffort === null || !hasEffort)}
        aria-haspopup={hasEffort ? "menu" : undefined}
        aria-expanded={hasEffort ? effortOpen : undefined}
        onClick={() => onPick(rowModel, null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" || !hasEffort) return;
          event.preventDefault();
          openEffort();
          requestAnimationFrame(() => effortMenuRef.current?.querySelector<HTMLButtonElement>(".quick-launch-effort-item")?.focus());
        }}
      >
        {row.starred ? <span className="quick-launch-variant-star" aria-hidden="true">★</span> : null}
        <span className="quick-launch-variant-label">{row.label}</span>
        {hasEffort ? <span className="quick-launch-variant-chevron" aria-hidden="true">›</span> : null}
      </button>
      <QuickLaunchEffortMenu
        anchor={rowRef.current}
        menuRef={effortMenuRef}
        open={hasEffort && effortOpen}
        onCancelClose={cancelClose}
        onScheduleClose={scheduleClose}
        onClose={closeEffort}
        onReturnFocus={() => rowRef.current?.querySelector<HTMLButtonElement>(".quick-launch-variant-name")?.focus()}
      >
        {row.chips?.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="menuitem"
            className="quick-launch-effort-item"
            data-launch-variant-chip={`${row.id}:${chip.id}`}
            aria-current={rowModel === selectedModel && chip.launch.effort === selectedEffort}
            onClick={() => onPick(chip.launch.model ?? rowModel, chip.launch.effort ?? null)}
          >
            {chip.label}
          </button>
        ))}
      </QuickLaunchEffortMenu>
    </div>
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
  const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => element.offsetParent !== null);
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
