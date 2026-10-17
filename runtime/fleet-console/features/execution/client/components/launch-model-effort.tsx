import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { OperationLaunchVariantGroup, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import { isRosterFallbackGroup, RosterFallbackNotice } from "../../../ai-gateway/client/roster-fallback.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { EffortTrack, gatedEffortNames, resolveRowEffort } from "./effort-track.js";
import { launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph } from "./launch-provider-glyphs.js";
import { ComposerChip } from "./composer-blocks.js";

const POPOVER_GAP = 8;

/**
 * 새 세션의 모델 칩·216px 공급자 메뉴·강도 트랙.
 * 새 세션 화면은 같은 부품을 칩 줄 오른쪽에 두고, 게이트 펼침을 `/effort` 목록과 나눠 쥔다(apexOpen).
 * 메뉴는 잘라내는 조상 밖 — menuRoot — 으로 보낼 수 있다.
 */
export function LaunchModelEffort({
  groups,
  model,
  effort,
  onChange,
  disabled = false,
  apexPinnedOpen = false,
  apexOpen,
  onApexOpenChange,
  placement = "below",
  menuRoot = null,
  dismissSignal = 0,
  onOpenChange,
  fallbackIcon = null,
}: {
  readonly groups: readonly OperationLaunchVariantGroup[];
  readonly model: string | null;
  readonly effort: string | null;
  readonly onChange: (model: string | null, effort: string | null) => void;
  readonly disabled?: boolean;
  readonly apexPinnedOpen?: boolean;
  /** 게이트 펼침을 바깥이 쥘 때(EffortTrack `apexOpen`). */
  readonly apexOpen?: boolean;
  readonly onApexOpenChange?: (open: boolean) => void;
  readonly placement?: "above" | "below";
  readonly menuRoot?: RefObject<HTMLElement | null> | null;
  readonly dismissSignal?: number;
  readonly onOpenChange?: (open: boolean) => void;
  readonly fallbackIcon?: ReactNode;
}) {
  const t = useT();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const seenDismiss = useRef(dismissSignal);

  const rows = groups.flatMap((group) => group.rows);
  const selectedRow = rows.find((row) => (row.launch.model ?? null) === model) ?? null;
  const onFallbackRow = selectedRow !== null && groups.some((group) => isRosterFallbackGroup(group.id) && group.rows.includes(selectedRow));
  const fallbackBadge = t("settings.models.fallback");
  const modelLabel = selectedRow
    ? (onFallbackRow ? `${selectedRow.label} · ${fallbackBadge}` : selectedRow.label)
    : t("chrome.launch.modelUnset");
  const selectedProvider = selectedRow
    ? (launchProviderFromGroupId(groups.find((group) => group.rows.some((row) => row.id === selectedRow.id))?.id ?? "")
      ?? launchProviderFromModelId(selectedRow.launch.model ?? selectedRow.id))
    : null;
  const kindIcon = selectedProvider ? launchProviderGlyph(selectedProvider) : fallbackIcon;

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setOpenAndTell = (next: boolean) => {
    setOpen(next);
    onOpenChangeRef.current?.(next);
  };

  useEffect(() => {
    if (seenDismiss.current === dismissSignal) return;
    seenDismiss.current = dismissSignal;
    setOpen(false);
    onOpenChangeRef.current?.(false);
  }, [dismissSignal]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
      onOpenChangeRef.current?.(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const pop = menuRef.current;
    const checked = pop?.querySelector<HTMLElement>("[role='menuitemradio'][aria-checked='true']");
    (checked ?? pop?.querySelector<HTMLElement>("[role='menuitemradio']"))?.focus();
  }, [open, groups]);

  useLayoutEffect(() => {
    if (!open || !menuRoot?.current || !menuRef.current || !chipRef.current) return;
    const bar = menuRoot.current;
    const chip = chipRef.current;
    const pop = menuRef.current;
    const width = pop.getBoundingClientRect().width;
    pop.style.left = `${Math.max(0, Math.min(chip.offsetLeft, bar.clientWidth - width - POPOVER_GAP))}px`;
    pop.style.right = "auto";
    const safePadding = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-5")) || 0;
    if (placement === "above") {
      pop.style.top = "auto";
      pop.style.bottom = "calc(100% + var(--space-2))";
      pop.style.maxHeight = `${Math.max(0, bar.getBoundingClientRect().top - safePadding - POPOVER_GAP)}px`;
      return;
    }
    pop.style.bottom = "auto";
    pop.style.top = "calc(100% + var(--space-2))";
    const top = pop.getBoundingClientRect().top;
    pop.style.maxHeight = `${Math.max(0, window.innerHeight - top - safePadding)}px`;
  }, [open, placement, groups, menuRoot]);

  const closeToChip = () => {
    setOpenAndTell(false);
    chipRef.current?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"));
    if (items.length === 0 && event.key !== "Escape") return;
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    const focusItem = (index: number) => items[((index % items.length) + items.length) % items.length]?.focus();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeToChip();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      focusItem(activeIndex === -1 ? (delta === 1 ? 0 : items.length - 1) : activeIndex + delta);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusItem(event.key === "Home" ? 0 : items.length - 1);
      return;
    }
    if (event.key === "Tab") {
      setOpenAndTell(false);
      chipRef.current?.focus();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && /\S/.test(event.key)) {
      const query = event.key.toLowerCase();
      for (let step = 1; step <= items.length; step += 1) {
        const candidate = items[(activeIndex + step + items.length) % items.length];
        if (candidate && (candidate.dataset.menuLabel ?? "").toLowerCase().startsWith(query)) {
          event.preventDefault();
          candidate.focus();
          return;
        }
      }
    }
  };

  const pick = (row: OperationLaunchVariantRow) => {
    const nextModel = row.launch.model ?? null;
    onChange(nextModel, resolveRowEffort(row, effort));
    closeToChip();
  };

  const menu = open ? (
    <div
      ref={menuRef}
      className="launch-pop launch-pop--model theater-menu"
      role="menu"
      aria-label={t("chrome.launch.modelMenu")}
      onKeyDown={onMenuKeyDown}
    >
      {groups.map((group) => (
        <div key={group.id} className="launch-pop-group">
          {isRosterFallbackGroup(group.id) ? <RosterFallbackNotice onOpened={() => setOpenAndTell(false)} /> : (() => {
            const provider = launchProviderFromGroupId(group.id);
            return (
              <p className={`launch-pop-band${provider ? ` is-${provider}` : ""}`}>
                {provider ? (
                  <span className="operation-launch-provider-glyph" aria-hidden="true">
                    {launchProviderGlyph(provider)}
                  </span>
                ) : null}
                <span title={group.label}>{group.label}</span>
              </p>
            );
          })()}
          {group.rows.map((row) => (
            <ModelRow key={row.id} row={row} selectedModel={model} onPick={() => pick(row)} />
          ))}
        </div>
      ))}
    </div>
  ) : null;

  const hosted = menuRoot?.current;
  return (
    <span className="launch-model-effort">
      <span className="launch-model-effort-anchor" ref={anchorRef}>
        <ComposerChip
          ref={chipRef}
          className="launch-chip launch-chip--model"
          aria-expanded={open}
          disabled={disabled || groups.length === 0}
          onClick={() => setOpenAndTell(!open)}
        >
          {kindIcon ? (
            <span className={`launch-kind-icon${selectedProvider ? ` is-${selectedProvider}` : ""}`} aria-hidden="true">
              {kindIcon}
            </span>
          ) : null}
          <span className="launch-chip-label">{modelLabel}</span>
          <span className="launch-caret" aria-hidden="true">▾</span>
        </ComposerChip>
        {hosted ? null : menu}
      </span>
      {selectedRow && (selectedRow.chips?.length ?? 0) > 0 ? (
        <EffortTrack
          row={selectedRow}
          value={effort}
          apexPinnedOpen={apexPinnedOpen}
          apexOpen={apexOpen}
          onApexOpenChange={onApexOpenChange}
          onChange={(nextEffort) => onChange(model, nextEffort)}
          autoLabel={t("launchVariants.effort.auto")}
          ariaLabel={t("launchVariants.effort.track")}
          autoValueText={t("launchVariants.effort.autoValue")}
          apexToggleLabel={t("launchVariants.effort.apexToggle", { tiers: gatedEffortNames(selectedRow) })}
          apexCollapseLabel={t("launchVariants.effort.apexCollapse", { tiers: gatedEffortNames(selectedRow) })}
          className="launch-effort-track"
        />
      ) : null}
      {hosted && menu ? createPortal(menu, hosted) : null}
    </span>
  );
}

function ModelRow({ row, selectedModel, onPick }: {
  readonly row: OperationLaunchVariantRow;
  readonly selectedModel: string | null;
  readonly onPick: () => void;
}) {
  const rowModel = row.launch.model ?? null;
  return (
    <div className="launch-variant-row">
      <button
        type="button"
        className="launch-variant-name"
        role="menuitemradio"
        aria-checked={rowModel === selectedModel}
        tabIndex={-1}
        data-menu-label={row.label}
        title={row.label}
        onClick={onPick}
      >
        <span className="launch-variant-label">{row.label}</span>
        {row.starred ? <span className="launch-variant-star" aria-hidden="true">★</span> : null}
        {rowModel === selectedModel ? <span className="launch-pop-check" aria-hidden="true">✓</span> : null}
      </button>
    </div>
  );
}
