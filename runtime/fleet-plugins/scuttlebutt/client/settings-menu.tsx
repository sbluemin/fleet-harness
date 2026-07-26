import { React } from "@fleet-console/sdk/plugin/browser";

export type SettingsRowKey = "cli" | "model" | "reasoning";

export interface SettingsOption {
  readonly value: string;
  readonly label: string;
}

export interface SettingsRow {
  readonly key: SettingsRowKey;
  readonly label: "Agent CLI" | "Model" | "Reasoning";
  readonly value: string;
  readonly valueLabel: string;
  readonly options: readonly SettingsOption[];
}

export interface SettingsMenuState {
  readonly open: boolean;
  readonly activeRow: number;
  readonly openRow: SettingsRowKey | null;
  readonly activeOption: number;
}

export type SettingsMenuEvent =
  | { readonly type: "open" }
  | { readonly type: "close" }
  | { readonly type: "move-row"; readonly delta: -1 | 1 }
  | { readonly type: "open-row"; readonly selectedIndex: number }
  | { readonly type: "move-option"; readonly delta: -1 | 1 }
  | { readonly type: "back" }
  | { readonly type: "escape" };

export interface MenuTransition {
  readonly state: SettingsMenuState;
  readonly consumed: boolean;
}

export interface SettingsMenuPlacement {
  readonly menu: { readonly left: number; readonly top: number };
  readonly submenu: {
    readonly left: number;
    readonly top: number;
    readonly side: "left" | "right";
  };
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const CLOSED_SETTINGS_MENU: SettingsMenuState = {
  open: false,
  activeRow: 0,
  openRow: null,
  activeOption: 0,
};

const PANEL_GAP = 4;
const PANEL_MARGIN = 4;

export function getSettingsRows({
  cliLabel,
  cliValue,
  cliOptions,
  modelLabel,
  modelValue,
  modelOptions,
  effort,
  effortOptions,
}: {
  readonly cliLabel: string;
  readonly cliValue: string;
  readonly cliOptions: readonly SettingsOption[];
  readonly modelLabel: string;
  readonly modelValue: string;
  readonly modelOptions: readonly SettingsOption[];
  readonly effort: string;
  readonly effortOptions: readonly SettingsOption[];
}): readonly SettingsRow[] {
  const rows: SettingsRow[] = [
    { key: "cli", label: "Agent CLI", value: cliValue, valueLabel: cliLabel, options: cliOptions },
    { key: "model", label: "Model", value: modelValue, valueLabel: modelLabel, options: modelOptions },
  ];
  if (effortOptions.length > 0) {
    rows.push({ key: "reasoning", label: "Reasoning", value: effort, valueLabel: effort, options: effortOptions });
  }
  return rows;
}

export function transitionSettingsMenu(
  state: SettingsMenuState,
  event: SettingsMenuEvent,
  rows: readonly SettingsRow[],
): MenuTransition {
  if (event.type === "open") {
    return {
      state: { ...CLOSED_SETTINGS_MENU, open: true, activeRow: clampIndex(state.activeRow, rows.length) },
      consumed: true,
    };
  }
  if (event.type === "close") return { state: CLOSED_SETTINGS_MENU, consumed: state.open };
  if (event.type === "escape") {
    if (!state.open) return { state, consumed: false };
    if (state.openRow) return { state: { ...state, openRow: null }, consumed: true };
    return { state: CLOSED_SETTINGS_MENU, consumed: true };
  }
  if (!state.open) return { state, consumed: false };
  if (event.type === "move-row") {
    return {
      state: {
        ...state,
        activeRow: wrapIndex(state.activeRow + event.delta, rows.length),
        openRow: null,
      },
      consumed: true,
    };
  }
  if (event.type === "open-row") {
    const row = rows[state.activeRow];
    if (!row || row.options.length === 0) return { state, consumed: true };
    return {
      state: {
        ...state,
        openRow: row.key,
        activeOption: clampIndex(event.selectedIndex, row.options.length),
      },
      consumed: true,
    };
  }
  if (event.type === "move-option") {
    const row = rows.find((item) => item.key === state.openRow);
    if (!row) return { state, consumed: true };
    return {
      state: { ...state, activeOption: wrapIndex(state.activeOption + event.delta, row.options.length) },
      consumed: true,
    };
  }
  if (event.type === "back") {
    return { state: { ...state, openRow: null }, consumed: state.openRow !== null };
  }
  return { state, consumed: false };
}

export function selectSettingsOption(
  state: SettingsMenuState,
  row: SettingsRowKey,
  value: string,
  onSelect: (row: SettingsRowKey, value: string) => void,
): SettingsMenuState {
  onSelect(row, value);
  return { ...CLOSED_SETTINGS_MENU, activeRow: state.activeRow };
}

export function calculateSettingsMenuPlacement({
  trigger,
  card,
  viewport,
  menu,
  row,
  submenu,
}: {
  readonly trigger: Rect;
  readonly card: Rect;
  readonly viewport: Rect;
  readonly menu: Rect;
  readonly row: Rect;
  readonly submenu: Rect;
}): SettingsMenuPlacement {
  const bounds = intersectBounds(card, viewport);
  const menuLeft = clamp(trigger.left, bounds.left, bounds.right - menu.width);
  const menuTop = clamp(trigger.top - PANEL_GAP - menu.height, bounds.top, bounds.bottom - menu.height);
  const rightLeft = menuLeft + menu.width + PANEL_GAP;
  const leftLeft = menuLeft - PANEL_GAP - submenu.width;
  const side = rightLeft + submenu.width <= bounds.right || leftLeft < bounds.left ? "right" : "left";
  const submenuLeft = clamp(side === "right" ? rightLeft : leftLeft, bounds.left, bounds.right - submenu.width);
  const submenuTop = clamp(menuTop + row.top - menu.top, bounds.top, bounds.bottom - submenu.height);
  return {
    menu: { left: menuLeft - trigger.left, top: menuTop - trigger.top },
    submenu: { left: submenuLeft - trigger.left, top: submenuTop - trigger.top, side },
  };
}

export function SettingsMenu({
  modelLabel,
  effort,
  rows,
  disabled,
  cardRef,
  onSelect,
}: {
  readonly modelLabel: string;
  readonly effort: string;
  readonly rows: readonly SettingsRow[];
  readonly disabled: boolean;
  readonly cardRef: React.RefObject<HTMLDivElement | null>;
  readonly onSelect: (row: SettingsRowKey, value: string) => void;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const submenuRef = React.useRef<HTMLDivElement>(null);
  const rowRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [state, setState] = React.useState(CLOSED_SETTINGS_MENU);
  const [placement, setPlacement] = React.useState<SettingsMenuPlacement | null>(null);
  const openRowIndex = rows.findIndex((row) => row.key === state.openRow);
  const openRow = rows[openRowIndex];

  const dispatch = React.useCallback((event: SettingsMenuEvent) => {
    setState((current) => {
      return transitionSettingsMenu(current, event, rows).state;
    });
  }, [rows]);

  const updatePlacement = React.useCallback(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    const menuElement = menuRef.current;
    const rowElement = rowRefs.current[openRowIndex >= 0 ? openRowIndex : 0];
    const submenuElement = submenuRef.current;
    if (!root || !card || !menuElement || !rowElement) return;
    const rootRect = toRect(root.getBoundingClientRect());
    const menuRect = toRect(menuElement.getBoundingClientRect());
    const rowRect = toRect(rowElement.getBoundingClientRect());
    const submenuRect = submenuElement
      ? toRect(submenuElement.getBoundingClientRect())
      : { left: 0, top: 0, width: 0, height: 0 };
    setPlacement(calculateSettingsMenuPlacement({
      trigger: rootRect,
      card: toRect(card.getBoundingClientRect()),
      viewport: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
      menu: menuRect,
      row: rowRect,
      submenu: submenuRect,
    }));
  }, [cardRef, openRowIndex]);

  React.useLayoutEffect(() => {
    if (!state.open) return;
    updatePlacement();
    if (state.openRow) optionRefs.current[state.activeOption]?.focus();
    else rowRefs.current[state.activeRow]?.focus();
  }, [state, updatePlacement]);

  React.useEffect(() => {
    if (!state.open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setState(CLOSED_SETTINGS_MENU);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const onPositionChange = () => updatePlacement();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onPositionChange);
    window.addEventListener("scroll", onPositionChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onPositionChange);
      window.removeEventListener("scroll", onPositionChange, true);
    };
  }, [state.open, updatePlacement]);

  const handleEscape = (event: React.KeyboardEvent) => {
    const transition = transitionSettingsMenu(state, { type: "escape" }, rows);
    if (!transition.consumed) return;
    event.preventDefault();
    event.stopPropagation();
    setState(transition.state);
    if (!transition.state.open) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openActiveRow = () => {
    const row = rows[state.activeRow];
    if (!row) return;
    dispatch({ type: "open-row", selectedIndex: Math.max(0, row.options.findIndex((option) => option.value === row.value)) });
  };

  const commit = (row: SettingsRow, value: string) => {
    setState((current) => selectSettingsOption(current, row.key, value, onSelect));
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div ref={rootRef} className="scuttlebutt-settings-root">
      <button
        ref={triggerRef}
        type="button"
        className="scuttlebutt-settings-trigger"
        aria-label="Model settings"
        aria-haspopup="menu"
        aria-expanded={state.open}
        disabled={disabled}
        onClick={() => {
          if (state.open) {
            setState(CLOSED_SETTINGS_MENU);
            triggerRef.current?.focus();
          } else {
            dispatch({ type: "open" });
          }
        }}
      >
        <span className="scuttlebutt-settings-trigger-model">{modelLabel}</span>
        {rows.some((row) => row.key === "reasoning") ? (
          <span className="scuttlebutt-settings-trigger-effort">{effort}</span>
        ) : null}
      </button>
      {state.open ? (
        <div
          ref={menuRef}
          className="scuttlebutt-settings-menu"
          role="menu"
          aria-label="Model settings"
          style={placement ? { left: placement.menu.left, top: placement.menu.top } : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              handleEscape(event);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              dispatch({ type: "move-row", delta: event.key === "ArrowDown" ? 1 : -1 });
            } else if (event.key === "Enter" || event.key === "ArrowRight") {
              event.preventDefault();
              openActiveRow();
            }
          }}
        >
          {rows.map((row, index) => (
            <button
              key={row.key}
              ref={(element) => { rowRefs.current[index] = element; }}
              type="button"
              role="menuitem"
              tabIndex={index === state.activeRow && !state.openRow ? 0 : -1}
              className="scuttlebutt-settings-row"
              onFocus={() => setState((current) => ({ ...current, activeRow: index }))}
              onClick={() => {
                setState((current) => ({ ...current, activeRow: index }));
                const selectedIndex = row.options.findIndex((option) => option.value === row.value);
                setState((current) => transitionSettingsMenu(
                  current,
                  { type: "open-row", selectedIndex: Math.max(0, selectedIndex) },
                  rows,
                ).state);
              }}
            >
              <span className="scuttlebutt-settings-row-label">{row.label}</span>
              <span className="scuttlebutt-settings-row-value">{row.valueLabel}</span>
              <span className="scuttlebutt-settings-chevron" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      ) : null}
      {state.open && openRow ? (
        <div
          ref={submenuRef}
          className="scuttlebutt-settings-submenu"
          role="menu"
          aria-label={openRow.label}
          data-side={placement?.submenu.side ?? "right"}
          style={placement ? { left: placement.submenu.left, top: placement.submenu.top } : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              handleEscape(event);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              dispatch({ type: "move-option", delta: event.key === "ArrowDown" ? 1 : -1 });
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              dispatch({ type: "back" });
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              const option = openRow.options[state.activeOption];
              if (option) commit(openRow, option.value);
            }
          }}
        >
          {openRow.options.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === openRow.value}
              tabIndex={index === state.activeOption ? 0 : -1}
              className="scuttlebutt-settings-option"
              onFocus={() => setState((current) => ({ ...current, activeOption: index }))}
              onClick={() => commit(openRow, option.value)}
            >
              <span aria-hidden="true" className="scuttlebutt-settings-check">
                {option.value === openRow.value ? "✓" : ""}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function toRect(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function intersectBounds(first: Rect, second: Rect) {
  const left = Math.max(first.left, second.left) + PANEL_MARGIN;
  const top = Math.max(first.top, second.top) + PANEL_MARGIN;
  const right = Math.min(first.left + first.width, second.left + second.width) - PANEL_MARGIN;
  const bottom = Math.min(first.top + first.height, second.top + second.height) - PANEL_MARGIN;
  return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function clampIndex(index: number, length: number): number {
  return clamp(index, 0, Math.max(0, length - 1));
}

function wrapIndex(index: number, length: number): number {
  return length > 0 ? (index + length) % length : 0;
}
