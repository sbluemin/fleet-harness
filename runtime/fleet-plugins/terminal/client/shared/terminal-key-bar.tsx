import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { getT } from "../i18n/index.js";
import type { TerminalKeyId } from "./terminal-key-sequences.js";

/**
 * The keys a phone keyboard leaves out, laid over the terminal.
 *
 * A soft keyboard is a text field's keyboard: it has letters and punctuation and nothing a terminal
 * reads as a command. Without Escape there is no leaving a mode, without arrows there is no history
 * or menu, and without Ctrl there is no interrupting anything. So this bar carries them.
 *
 * One row stays visible because those keys are needed constantly, and the rest live behind a toggle
 * that takes the keyboard's place rather than stacking on top of it — a phone cannot afford both and
 * still show a session.
 *
 * Ctrl and Alt latch instead of being held: a finger cannot press two keys at once, so they arm the
 * next key — whether it comes from this bar or from the letters of the soft keyboard — and release.
 */

export interface TerminalKeyBarModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
}

export const NO_LATCHED_MODIFIERS: TerminalKeyBarModifiers = { ctrl: false, alt: false };

export interface TerminalKeyBarProps {
  readonly locale?: ConsoleLocale;
  readonly modifiers: TerminalKeyBarModifiers;
  readonly expanded: boolean;
  readonly onToggleModifier: (modifier: "ctrl" | "alt") => void;
  readonly onToggleExpanded: () => void;
  readonly onKey: (id: TerminalKeyId) => void;
  readonly onText: (text: string) => void;
}

interface KeySpec {
  readonly id: TerminalKeyId;
  readonly label: string;
  /** Set when the label is a glyph a screen reader cannot name on its own. */
  readonly nameKey?: "up" | "down" | "left" | "right" | "enter" | "backspace" | "shiftTab";
}

const ARROW_KEYS: readonly KeySpec[] = [
  { id: "left", label: "←", nameKey: "left" },
  { id: "up", label: "↑", nameKey: "up" },
  { id: "down", label: "↓", nameKey: "down" },
  { id: "right", label: "→", nameKey: "right" },
];

const EDIT_KEYS: readonly KeySpec[] = [
  { id: "shiftTab", label: "⇧Tab", nameKey: "shiftTab" },
  { id: "enter", label: "↵", nameKey: "enter" },
  { id: "backspace", label: "⌫", nameKey: "backspace" },
  { id: "delete", label: "Del" },
  { id: "insert", label: "Ins" },
];

const NAVIGATION_KEYS: readonly KeySpec[] = [
  { id: "home", label: "Home" },
  { id: "end", label: "End" },
  { id: "pageUp", label: "PgUp" },
  { id: "pageDown", label: "PgDn" },
  { id: "space", label: "Space" },
];

const FUNCTION_KEYS: readonly (readonly KeySpec[])[] = [
  [
    { id: "f1", label: "F1" },
    { id: "f2", label: "F2" },
    { id: "f3", label: "F3" },
    { id: "f4", label: "F4" },
    { id: "f5", label: "F5" },
    { id: "f6", label: "F6" },
  ],
  [
    { id: "f7", label: "F7" },
    { id: "f8", label: "F8" },
    { id: "f9", label: "F9" },
    { id: "f10", label: "F10" },
    { id: "f11", label: "F11" },
    { id: "f12", label: "F12" },
  ],
];

/**
 * Punctuation a phone hides two layouts deep, chosen for what a shell needs: pipes and redirects,
 * paths and flags, globs and variables.
 */
const SYMBOL_ROWS: readonly string[] = [
  "|\\/~-_:;",
  "?!@$*#&%",
];

export function TerminalKeyBar({ locale, modifiers, expanded, onToggleModifier, onToggleExpanded, onKey, onText }: TerminalKeyBarProps) {
  const t = getT(locale);
  const nameFor = (key: KeySpec): string | undefined => (
    key.nameKey === undefined ? undefined : t(`terminal.keyBar.key.${key.nameKey}`)
  );

  return (
    <div className="terminal-key-bar" role="group" aria-label={t("terminal.keyBar.aria")}>
      <div className="terminal-key-row terminal-key-row-primary">
        <KeyBarButton label="Esc" onActivate={() => onKey("escape")} />
        <KeyBarButton label="Tab" onActivate={() => onKey("tab")} />
        <KeyBarButton label="Ctrl" pressed={modifiers.ctrl} onActivate={() => onToggleModifier("ctrl")} />
        <KeyBarButton label="Alt" pressed={modifiers.alt} onActivate={() => onToggleModifier("alt")} />
        {ARROW_KEYS.map((key) => (
          <KeyBarButton key={key.id} label={key.label} name={nameFor(key)} onActivate={() => onKey(key.id)} />
        ))}
        <KeyBarButton
          label="⋯"
          name={t(expanded ? "terminal.keyBar.fewer" : "terminal.keyBar.more")}
          pressed={expanded}
          onActivate={onToggleExpanded}
        />
      </div>
      {expanded ? (
        <div className="terminal-key-panel">
          <KeyRow keys={EDIT_KEYS} nameFor={nameFor} onKey={onKey} />
          <KeyRow keys={NAVIGATION_KEYS} nameFor={nameFor} onKey={onKey} />
          {FUNCTION_KEYS.map((row, index) => (
            <KeyRow key={`function-${index}`} keys={row} nameFor={nameFor} onKey={onKey} />
          ))}
          {SYMBOL_ROWS.map((row) => (
            <div className="terminal-key-row" key={row}>
              {Array.from(row).map((symbol) => (
                <KeyBarButton key={symbol} label={symbol} onActivate={() => onText(symbol)} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KeyRow({ keys, nameFor, onKey }: {
  readonly keys: readonly KeySpec[];
  readonly nameFor: (key: KeySpec) => string | undefined;
  readonly onKey: (id: TerminalKeyId) => void;
}) {
  return (
    <div className="terminal-key-row">
      {keys.map((key) => (
        <KeyBarButton key={key.id} label={key.label} name={nameFor(key)} onActivate={() => onKey(key.id)} />
      ))}
    </div>
  );
}

function KeyBarButton({ label, name, pressed, onActivate }: {
  readonly label: string;
  readonly name?: string;
  readonly pressed?: boolean;
  readonly onActivate: () => void;
}) {
  return (
    <button
      type="button"
      className="terminal-key"
      aria-label={name}
      aria-pressed={pressed}
      /* Focus must stay on the terminal. Letting the press move it closes the soft keyboard, and
         the next letter typed would land on this button instead of the session. */
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onActivate}
    >
      {label}
    </button>
  );
}
