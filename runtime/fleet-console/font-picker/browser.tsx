import * as React from "react";

import { fontResolves, withFontFallback } from "./resolve.js";

export interface FontPickerBuiltIn {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
}

export interface FontPickerInstalledFont {
  readonly family: string;
  readonly monospace: boolean;
  /** 소비자가 아는 사실을 행에 싣는다(예: 이 서체가 덮는 문자 계열). 없으면 등폭 여부로 대체된다. */
  readonly description?: string;
  /* 소비자가 이미 이 서체의 존재를 확인했을 때 내부 폭 탐침을 건너뛴다. 폭 탐침은 라틴 글자로
     묻기 때문에 라틴이 없는 서체를 없는 것으로 오판하고, 그러면 유효한 선택지가 비활성 행이 된다. */
  readonly available?: boolean;
}

export type FontPickerSelection =
  | { readonly source: "builtin"; readonly id: string }
  | { readonly source: "system"; readonly familyName: string };

/** 소비자 카탈로그에서 주입하는 UI 라벨. 각 항목 optional — 기본값은 기존 영어와 바이트 동일. */
export interface FontPickerLabels {
  readonly browserAria?: string;
  readonly searchLabel?: string;
  readonly searchPlaceholder?: string;
  readonly loading?: string;
  readonly choicesAria?: string;
  readonly builtInGroup?: string;
  readonly installedGroup?: string;
  readonly noMatch?: string;
  readonly preview?: string;
  readonly available?: string;
  readonly unavailable?: string;
  readonly fontSizeAria?: string;
  readonly decreaseSizeAria?: string;
  readonly sizeValueAria?: string;
  readonly increaseSizeAria?: string;
  readonly sizeSliderAria?: string;
  readonly monospace?: string;
  readonly systemFont?: string;
  readonly savedSystemFont?: string;
}

type ResolvedFontPickerLabels = {
  readonly [K in keyof Required<FontPickerLabels>]: string;
};

const DEFAULT_LABELS: ResolvedFontPickerLabels = {
  browserAria: "Font browser",
  searchLabel: "Search fonts",
  searchPlaceholder: "Search installed fonts",
  loading: "Loading installed fonts…",
  choicesAria: "Font choices",
  builtInGroup: "Built-in",
  installedGroup: "Installed on this machine",
  noMatch: "No fonts match this search.",
  preview: "Preview",
  available: "Available",
  unavailable: "Unavailable",
  fontSizeAria: "Font size",
  decreaseSizeAria: "Decrease font size",
  sizeValueAria: "Font size value",
  increaseSizeAria: "Increase font size",
  sizeSliderAria: "Font size slider",
  monospace: "Monospace",
  systemFont: "System font",
  savedSystemFont: "Saved system font",
};

export interface FontPickerProps {
  readonly builtIns: readonly FontPickerBuiltIn[];
  readonly installedFonts: readonly FontPickerInstalledFont[];
  readonly selected: FontPickerSelection;
  readonly selectedSystemFont?: string | null;
  readonly fallbackStack: string;
  readonly previewText: string;
  /* 크기 축은 선택적이다 — 주 서체를 고르는 브라우저는 크기까지 함께 정하지만, 다른 선택을 보조하는
     브라우저(예: 폴백 서체)는 주 서체의 메트릭을 그대로 따라야 해서 독립 크기를 가질 수 없다. 셋 중
     하나라도 빠지면 크기 컨트롤 전체가 사라진다. */
  readonly size?: number;
  readonly sizeRange?: FontPickerSizeRange;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly labels?: FontPickerLabels;
  readonly onSelectionChange: (selection: FontPickerSelection) => void;
  readonly onSizeCommit?: (size: number) => void | Promise<void>;
}

export interface FontPickerSizeRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
}

interface FontPickerRow {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly previewFamily: string;
  readonly source: FontPickerSelection["source"];
  readonly selection: FontPickerSelection;
  readonly description?: string;
  readonly unavailable: boolean;
}

interface IndexedFontPickerRow {
  readonly row: FontPickerRow;
  readonly index: number;
}

function resolveLabels(labels?: FontPickerLabels): ResolvedFontPickerLabels {
  return labels ? { ...DEFAULT_LABELS, ...labels } : DEFAULT_LABELS;
}

export function FontPicker(props: FontPickerProps): React.ReactElement {
  const sizeRange = props.size !== undefined && props.onSizeCommit ? props.sizeRange ?? null : null;
  const labels = resolveLabels(props.labels);
  const [query, setQuery] = React.useState("");
  const [draftSize, setDraftSize] = React.useState(props.size ?? 0);
  const commitQueue = React.useRef(Promise.resolve());
  const listboxId = React.useId();
  const rows = React.useMemo(() => createRows(props, labels), [props, labels]);
  const filteredRows = React.useMemo(() => filterRows(rows, query), [rows, query]);
  const indexedRows = React.useMemo(() => filteredRows.map((row, index) => ({ row, index })), [filteredRows]);
  const [activeIndex, setActiveIndex] = React.useState(() => selectedRowIndex(rows, props.selected));
  const selectedRow = rows.find((row) => isSelected(row.selection, props.selected)) ?? null;
  const activeRow = indexedRows[Math.min(activeIndex, Math.max(0, indexedRows.length - 1))]?.row ?? null;
  const builtInsGroupId = `${listboxId}-built-ins`;
  const installedGroupId = `${listboxId}-installed`;

  React.useEffect(() => {
    if (props.size !== undefined) setDraftSize(props.size);
  }, [props.size]);

  React.useEffect(() => {
    if (activeIndex >= indexedRows.length) setActiveIndex(Math.max(0, indexedRows.length - 1));
  }, [activeIndex, indexedRows.length]);

  const commitSize = React.useCallback((nextSize: number) => {
    const commit = props.onSizeCommit;
    if (!sizeRange || !commit) return;
    const clamped = clampSize(nextSize, sizeRange);
    setDraftSize(clamped);
    commitQueue.current = commitQueue.current.catch(() => undefined).then(() => commit(clamped));
  }, [props.onSizeCommit, sizeRange]);

  const moveActive = React.useCallback((direction: 1 | -1) => {
    if (!filteredRows.length) return;
    setActiveIndex((current) => (current + direction + filteredRows.length) % filteredRows.length);
  }, [filteredRows.length]);

  const selectActive = React.useCallback(() => {
    if (activeRow && !activeRow.unavailable) props.onSelectionChange(activeRow.selection);
  }, [activeRow, props]);

  const handleRowSelect = React.useCallback((index: number, selection: FontPickerSelection) => {
    setActiveIndex(index);
    props.onSelectionChange(selection);
  }, [props]);

  const onListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, filteredRows.length - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectActive();
    }
  };

  return (
    <section className="fc-font-browser" aria-label={labels.browserAria} data-disabled={props.disabled ? "true" : undefined}>
      <div className="fc-font-browser__panes">
      <div className="fc-font-browser__chooser">
        <label className="fc-font-browser__search-label" htmlFor={`${listboxId}-search`}>{labels.searchLabel}</label>
        <input
          id={`${listboxId}-search`}
          className="fc-font-browser__search"
          type="search"
          value={query}
          disabled={props.disabled}
          placeholder={labels.searchPlaceholder}
          onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
        />
        {props.loading ? <p className="fc-font-browser__state" role="status">{labels.loading}</p> : null}
        {props.error ? <p className="fc-font-browser__state fc-font-browser__state--error" role="alert">{props.error}</p> : null}
        <div
          id={listboxId}
          className="fc-font-browser__listbox"
          role="listbox"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={labels.choicesAria}
          aria-activedescendant={activeRow ? optionId(listboxId, activeIndex) : undefined}
          aria-busy={props.loading || undefined}
          onKeyDown={onListboxKeyDown}
        >
          <FontGroup groupId={builtInsGroupId} label={labels.builtInGroup} unavailableLabel={labels.unavailable} rows={indexedRows.filter(({ row }) => row.source === "builtin")} activeRow={activeRow} selected={props.selected} listboxId={listboxId} disabled={props.disabled} onSelect={handleRowSelect} />
          <div className="fc-font-browser__separator" role="separator" aria-hidden="true" />
          <FontGroup groupId={installedGroupId} label={labels.installedGroup} unavailableLabel={labels.unavailable} rows={indexedRows.filter(({ row }) => row.source === "system")} activeRow={activeRow} selected={props.selected} listboxId={listboxId} disabled={props.disabled} onSelect={handleRowSelect} />
          {!props.loading && !indexedRows.length ? <p className="fc-font-browser__state">{labels.noMatch}</p> : null}
        </div>
      </div>
      <aside className="fc-font-browser__preview" aria-live="polite">
        <div className="fc-font-browser__preview-head">
          <span className="fc-font-browser__preview-label">{labels.preview}</span>
          <span className={`fc-font-browser__availability${selectedRow?.unavailable ? " fc-font-browser__availability--unavailable" : ""}`}>
            {selectedRow?.unavailable ? labels.unavailable : labels.available}
          </span>
        </div>
        <p className="fc-font-browser__preview-copy" style={{ fontFamily: selectedRow?.previewFamily ?? props.fallbackStack, fontSize: sizeRange ? `${draftSize}px` : undefined }}>
          {props.previewText}
        </p>
        {sizeRange ? (
          <>
            <div className="fc-font-browser__size-control" role="group" aria-label={labels.fontSizeAria}>
              <button type="button" className="fc-font-browser__stepper" disabled={props.disabled || draftSize <= sizeRange.min} onClick={() => commitSize(draftSize - sizeRange.step)} aria-label={labels.decreaseSizeAria}>−</button>
              <output className="fc-font-browser__size-value" aria-label={labels.sizeValueAria}>{draftSize}px</output>
              <button type="button" className="fc-font-browser__stepper" disabled={props.disabled || draftSize >= sizeRange.max} onClick={() => commitSize(draftSize + sizeRange.step)} aria-label={labels.increaseSizeAria}>+</button>
            </div>
            <input
              className="fc-font-browser__range"
              type="range"
              min={sizeRange.min}
              max={sizeRange.max}
              step={sizeRange.step}
              value={draftSize}
              disabled={props.disabled}
              aria-label={labels.sizeSliderAria}
              onChange={(event) => setDraftSize(clampSize(Number(event.currentTarget.value), sizeRange))}
              onPointerUp={(event) => commitSize(Number(event.currentTarget.value))}
              onKeyUp={(event) => { if (["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp"].includes(event.key)) commitSize(Number(event.currentTarget.value)); }}
            />
          </>
        ) : null}
      </aside>
      </div>
    </section>
  );
}

function FontGroup({ groupId, label, unavailableLabel, rows, activeRow, selected, listboxId, disabled, onSelect }: { readonly groupId: string; readonly label: string; readonly unavailableLabel: string; readonly rows: readonly IndexedFontPickerRow[]; readonly activeRow: FontPickerRow | null; readonly selected: FontPickerSelection; readonly listboxId: string; readonly disabled?: boolean; readonly onSelect: (index: number, selection: FontPickerSelection) => void }): React.ReactElement {
  return (
    <div className="fc-font-browser__group" role="group" aria-labelledby={groupId}>
      <h3 id={groupId} className="fc-font-browser__group-label">{label}</h3>
      {rows.map(({ row, index }) => (
        <button
          key={row.id}
          id={optionId(listboxId, index)}
          type="button"
          className={`fc-font-browser__row${isSelected(row.selection, activeRow?.selection ?? null) ? " is-active" : ""}${row.unavailable ? " is-unavailable" : ""}`}
          role="option"
          tabIndex={-1}
          aria-selected={isSelected(row.selection, selected)}
          disabled={disabled || row.unavailable}
          onClick={() => onSelect(index, row.selection)}
        >
          <span className="fc-font-browser__row-name" style={{ fontFamily: row.previewFamily }}>{row.label}</span>
          {row.description ? <span className="fc-font-browser__row-meta">{row.description}</span> : null}
          {row.unavailable ? <span className="fc-font-browser__row-status">{unavailableLabel}</span> : null}
        </button>
      ))}
    </div>
  );
}

function createRows(props: FontPickerProps, labels: ResolvedFontPickerLabels): readonly FontPickerRow[] {
  const builtInAliases = new Set<string>();
  const builtIns = props.builtIns.flatMap((font) => {
    const keys = [font.id, font.label, ...(font.aliases ?? [])].map(normalizeFontKey);
    if (keys.some((key) => builtInAliases.has(key))) return [];
    keys.forEach((key) => builtInAliases.add(key));
    return [{ id: `builtin-${font.id}`, label: font.label, family: font.family, previewFamily: font.family, source: "builtin" as const, selection: { source: "builtin" as const, id: font.id }, description: font.description, unavailable: false }];
  });
  const installed = props.installedFonts.map((font) => ({ id: `system-${normalizeFontKey(font.family)}`, label: font.family, family: font.family, previewFamily: withFontFallback(font.family, props.fallbackStack), source: "system" as const, selection: { source: "system" as const, familyName: font.family }, description: font.description ?? (font.monospace ? labels.monospace : labels.systemFont), unavailable: !(font.available ?? fontResolves(font.family)) }));
  const persistedSystemName = props.selected.source === "system" ? props.selected.familyName : null;
  if (persistedSystemName !== null && !installed.some((font) => font.family === persistedSystemName)) {
    installed.unshift({ id: `system-${normalizeFontKey(persistedSystemName)}`, label: props.selectedSystemFont ?? persistedSystemName, family: persistedSystemName, previewFamily: withFontFallback(persistedSystemName, props.fallbackStack), source: "system", selection: { source: "system", familyName: persistedSystemName }, description: labels.savedSystemFont, unavailable: true });
  }
  return [...builtIns, ...installed];
}

function filterRows(rows: readonly FontPickerRow[], query: string): readonly FontPickerRow[] {
  const normalizedQuery = normalizeFontKey(query);
  return normalizedQuery ? rows.filter((row) => normalizeFontKey(`${row.label} ${row.description ?? ""}`).includes(normalizedQuery)) : rows;
}

function normalizeFontKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

function selectedRowIndex(rows: readonly FontPickerRow[], selected: FontPickerSelection): number {
  const index = rows.findIndex((row) => isSelected(row.selection, selected));
  return index >= 0 ? index : 0;
}

function isSelected(left: FontPickerSelection, right: FontPickerSelection | null): boolean {
  if (!right) return false;
  if (left.source === "builtin") return right.source === "builtin" && left.id === right.id;
  return right.source === "system" && left.familyName === right.familyName;
}

function clampSize(size: number, range: FontPickerSizeRange): number {
  if (!Number.isFinite(size)) return range.defaultValue;
  const rounded = Math.round((size - range.min) / range.step) * range.step + range.min;
  return Math.min(range.max, Math.max(range.min, rounded));
}
