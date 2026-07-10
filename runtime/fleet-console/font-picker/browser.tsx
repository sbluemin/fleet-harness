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
}

export type FontPickerSelection =
  | { readonly source: "builtin"; readonly id: string }
  | { readonly source: "system"; readonly familyName: string };

export interface FontPickerProps {
  readonly builtIns: readonly FontPickerBuiltIn[];
  readonly installedFonts: readonly FontPickerInstalledFont[];
  readonly selected: FontPickerSelection;
  readonly selectedSystemFont?: string | null;
  readonly fallbackStack: string;
  readonly previewText: string;
  readonly size: number;
  readonly sizeRange: { readonly min: number; readonly max: number; readonly step: number; readonly defaultValue: number };
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly onSelectionChange: (selection: FontPickerSelection) => void;
  readonly onSizeCommit: (size: number) => void | Promise<void>;
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

export function FontPicker(props: FontPickerProps): React.ReactElement {
  const { sizeRange } = props;
  const [query, setQuery] = React.useState("");
  const [draftSize, setDraftSize] = React.useState(props.size);
  const commitQueue = React.useRef(Promise.resolve());
  const listboxId = React.useId();
  const rows = React.useMemo(() => createRows(props), [props]);
  const filteredRows = React.useMemo(() => filterRows(rows, query), [rows, query]);
  const indexedRows = React.useMemo(() => filteredRows.map((row, index) => ({ row, index })), [filteredRows]);
  const [activeIndex, setActiveIndex] = React.useState(() => selectedRowIndex(rows, props.selected));
  const selectedRow = rows.find((row) => isSelected(row.selection, props.selected)) ?? null;
  const activeRow = indexedRows[Math.min(activeIndex, Math.max(0, indexedRows.length - 1))]?.row ?? null;
  const builtInsGroupId = `${listboxId}-built-ins`;
  const installedGroupId = `${listboxId}-installed`;

  React.useEffect(() => {
    setDraftSize(props.size);
  }, [props.size]);

  React.useEffect(() => {
    if (activeIndex >= indexedRows.length) setActiveIndex(Math.max(0, indexedRows.length - 1));
  }, [activeIndex, indexedRows.length]);

  const commitSize = React.useCallback((nextSize: number) => {
    const clamped = clampSize(nextSize, sizeRange);
    setDraftSize(clamped);
    commitQueue.current = commitQueue.current.catch(() => undefined).then(() => props.onSizeCommit(clamped));
  }, [props.onSizeCommit, sizeRange]);

  const moveActive = React.useCallback((direction: 1 | -1) => {
    if (!filteredRows.length) return;
    setActiveIndex((current) => (current + direction + filteredRows.length) % filteredRows.length);
  }, [filteredRows.length]);

  const selectActive = React.useCallback(() => {
    if (activeRow && !activeRow.unavailable) props.onSelectionChange(activeRow.selection);
  }, [activeRow, props]);

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
    <section className="fc-font-browser" aria-label="Font browser" data-disabled={props.disabled ? "true" : undefined}>
      <div className="fc-font-browser__panes">
      <div className="fc-font-browser__chooser">
        <label className="fc-font-browser__search-label" htmlFor={`${listboxId}-search`}>Search fonts</label>
        <input
          id={`${listboxId}-search`}
          className="fc-font-browser__search"
          type="search"
          value={query}
          disabled={props.disabled}
          placeholder="Search installed fonts"
          onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
        />
        {props.loading ? <p className="fc-font-browser__state" role="status">Loading installed fonts…</p> : null}
        {props.error ? <p className="fc-font-browser__state fc-font-browser__state--error" role="alert">{props.error}</p> : null}
        <div
          id={listboxId}
          className="fc-font-browser__listbox"
          role="listbox"
          tabIndex={props.disabled ? -1 : 0}
          aria-label="Font choices"
          aria-activedescendant={activeRow ? optionId(listboxId, activeIndex) : undefined}
          aria-busy={props.loading || undefined}
          onKeyDown={onListboxKeyDown}
        >
          <FontGroup groupId={builtInsGroupId} label="Built-in" rows={indexedRows.filter(({ row }) => row.source === "builtin")} activeRow={activeRow} selected={props.selected} listboxId={listboxId} disabled={props.disabled} onSelect={props.onSelectionChange} />
          <div className="fc-font-browser__separator" role="separator" aria-hidden="true" />
          <FontGroup groupId={installedGroupId} label="Installed on this machine" rows={indexedRows.filter(({ row }) => row.source === "system")} activeRow={activeRow} selected={props.selected} listboxId={listboxId} disabled={props.disabled} onSelect={props.onSelectionChange} />
          {!props.loading && !indexedRows.length ? <p className="fc-font-browser__state">No fonts match this search.</p> : null}
        </div>
      </div>
      <aside className="fc-font-browser__preview" aria-live="polite">
        <div className="fc-font-browser__preview-head">
          <span className="fc-font-browser__preview-label">Preview</span>
          <span className={`fc-font-browser__availability${selectedRow?.unavailable ? " fc-font-browser__availability--unavailable" : ""}`}>
            {selectedRow?.unavailable ? "Unavailable" : "Available"}
          </span>
        </div>
        <p className="fc-font-browser__preview-copy" style={{ fontFamily: withFontFallback(selectedRow?.family ?? "", props.fallbackStack), fontSize: `${draftSize}px` }}>
          {props.previewText}
        </p>
        <div className="fc-font-browser__size-control" role="group" aria-label="Font size">
          <button type="button" className="fc-font-browser__stepper" disabled={props.disabled || draftSize <= sizeRange.min} onClick={() => commitSize(draftSize - sizeRange.step)} aria-label="Decrease font size">−</button>
          <output className="fc-font-browser__size-value" aria-label="Font size value">{draftSize}px</output>
          <button type="button" className="fc-font-browser__stepper" disabled={props.disabled || draftSize >= sizeRange.max} onClick={() => commitSize(draftSize + sizeRange.step)} aria-label="Increase font size">+</button>
        </div>
        <input
          className="fc-font-browser__range"
          type="range"
          min={sizeRange.min}
          max={sizeRange.max}
          step={sizeRange.step}
          value={draftSize}
          disabled={props.disabled}
          aria-label="Font size slider"
          onChange={(event) => setDraftSize(clampSize(Number(event.currentTarget.value), sizeRange))}
          onPointerUp={(event) => commitSize(Number(event.currentTarget.value))}
          onKeyUp={(event) => { if (["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp"].includes(event.key)) commitSize(Number(event.currentTarget.value)); }}
        />
      </aside>
      </div>
    </section>
  );
}

function FontGroup({ groupId, label, rows, activeRow, selected, listboxId, disabled, onSelect }: { readonly groupId: string; readonly label: string; readonly rows: readonly IndexedFontPickerRow[]; readonly activeRow: FontPickerRow | null; readonly selected: FontPickerSelection; readonly listboxId: string; readonly disabled?: boolean; readonly onSelect: (selection: FontPickerSelection) => void }): React.ReactElement {
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
          onClick={() => onSelect(row.selection)}
        >
          <span className="fc-font-browser__row-name" style={{ fontFamily: row.previewFamily }}>{row.label}</span>
          {row.description ? <span className="fc-font-browser__row-meta">{row.description}</span> : null}
          {row.unavailable ? <span className="fc-font-browser__row-status">Unavailable</span> : null}
        </button>
      ))}
    </div>
  );
}

function createRows(props: FontPickerProps): readonly FontPickerRow[] {
  const builtInAliases = new Set<string>();
  const builtIns = props.builtIns.flatMap((font) => {
    const keys = [font.id, font.label, ...(font.aliases ?? [])].map(normalizeFontKey);
    if (keys.some((key) => builtInAliases.has(key))) return [];
    keys.forEach((key) => builtInAliases.add(key));
    return [{ id: `builtin-${font.id}`, label: font.label, family: font.family, previewFamily: font.family, source: "builtin" as const, selection: { source: "builtin" as const, id: font.id }, description: font.description, unavailable: false }];
  });
  const installed = props.installedFonts.map((font) => ({ id: `system-${normalizeFontKey(font.family)}`, label: font.family, family: font.family, previewFamily: withFontFallback(font.family, props.fallbackStack), source: "system" as const, selection: { source: "system" as const, familyName: font.family }, description: font.monospace ? "Monospace" : "System font", unavailable: !fontResolves(font.family) }));
  const persistedSystemName = props.selected.source === "system" ? props.selected.familyName : null;
  if (persistedSystemName !== null && !installed.some((font) => font.family === persistedSystemName)) {
    installed.unshift({ id: `system-${normalizeFontKey(persistedSystemName)}`, label: props.selectedSystemFont ?? persistedSystemName, family: persistedSystemName, previewFamily: withFontFallback(persistedSystemName, props.fallbackStack), source: "system", selection: { source: "system", familyName: persistedSystemName }, description: "Saved system font", unavailable: true });
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

function clampSize(size: number, range: FontPickerProps["sizeRange"]): number {
  if (!Number.isFinite(size)) return range.defaultValue;
  const rounded = Math.round((size - range.min) / range.step) * range.step + range.min;
  return Math.min(range.max, Math.max(range.min, rounded));
}
