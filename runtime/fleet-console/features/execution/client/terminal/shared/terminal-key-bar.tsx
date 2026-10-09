import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { getT } from "../../agent/i18n/index.js";
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

/**
 * 모바일 Operation 화면의 키 줄(impl-spec S-30) — 한 줄을 가로로 밀어 보고, 맨 오른쪽 키보드 원만 고정이다.
 * 앞 열 키(Esc · Tab · Ctrl · ↑ · ↓ · ← · → · | · / · ~)는 시안 순서 그대로이고, 펼침 패널 대신 그 뒤에
 * 나머지 키를 이어 붙여 같은 줄에서 닿게 한다. Ctrl은 한 번 = 다음 키 하나에 붙는 무장, 무장에서 한 번 더 =
 * 고정, 고정에서 한 번 더 = 풀림. 연결이 끊긴 동안은 입력과 같이 비활성이다(D27).
 */
export interface MobileTerminalKeyBarProps {
  readonly locale?: ConsoleLocale;
  readonly modifiers: TerminalKeyBarModifiers;
  readonly ctrlLocked: boolean;
  readonly disabled: boolean;
  readonly onToggleModifier: (modifier: "ctrl" | "alt") => void;
  readonly onToggleKeyboard: () => void;
  readonly onKey: (id: TerminalKeyId) => void;
  readonly onText: (text: string) => void;
}

const MOBILE_LEAD_ARROWS: readonly KeySpec[] = [
  { id: "up", label: "↑", nameKey: "up" },
  { id: "down", label: "↓", nameKey: "down" },
  { id: "left", label: "←", nameKey: "left" },
  { id: "right", label: "→", nameKey: "right" },
];

const MOBILE_TAIL_KEYS: readonly KeySpec[] = [
  { id: "enter", label: "↵", nameKey: "enter" },
  { id: "backspace", label: "⌫", nameKey: "backspace" },
  { id: "shiftTab", label: "⇧Tab", nameKey: "shiftTab" },
  { id: "home", label: "Home" },
  { id: "end", label: "End" },
  { id: "pageUp", label: "PgUp" },
  { id: "pageDown", label: "PgDn" },
];

export function MobileTerminalKeyBar({ locale, modifiers, ctrlLocked, disabled, onToggleModifier, onToggleKeyboard, onKey, onText }: MobileTerminalKeyBarProps) {
  const t = getT(locale);
  const nameFor = (key: KeySpec): string | undefined => (
    key.nameKey === undefined ? undefined : t(`terminal.keyBar.key.${key.nameKey}`)
  );
  return (
    <div className={`terminal-key-bar is-mobile${disabled ? " is-disabled" : ""}`} role="group" aria-label={t("terminal.keyBar.aria")} aria-disabled={disabled || undefined}>
      <div className="terminal-key-strip">
        <KeyBarButton label="Esc" disabled={disabled} onActivate={() => onKey("escape")} />
        <KeyBarButton label="Tab" disabled={disabled} onActivate={() => onKey("tab")} />
        <KeyBarButton label="Ctrl" disabled={disabled} pressed={modifiers.ctrl} locked={ctrlLocked} onActivate={() => onToggleModifier("ctrl")} />
        {MOBILE_LEAD_ARROWS.map((key) => (
          <KeyBarButton key={key.id} label={key.label} name={nameFor(key)} disabled={disabled} onActivate={() => onKey(key.id)} />
        ))}
        {["|", "/", "~"].map((symbol) => (
          <KeyBarButton key={symbol} label={symbol} disabled={disabled} onActivate={() => onText(symbol)} />
        ))}
        <KeyBarButton label="Alt" disabled={disabled} pressed={modifiers.alt} onActivate={() => onToggleModifier("alt")} />
        {MOBILE_TAIL_KEYS.map((key) => (
          <KeyBarButton key={key.id} label={key.label} name={nameFor(key)} disabled={disabled} onActivate={() => onKey(key.id)} />
        ))}
        {Array.from("\\-_:;?!@$*#&%").map((symbol) => (
          <KeyBarButton key={symbol} label={symbol} disabled={disabled} onActivate={() => onText(symbol)} />
        ))}
      </div>
      <button
        type="button"
        className="terminal-key-keyboard"
        aria-label={t("terminal.mobile.keyboard")}
        disabled={disabled}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleKeyboard}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
        </svg>
      </button>
    </div>
  );
}

/**
 * CLI 확인 줄(impl-spec S-30, D26) — 터미널 프롬프트가 사람의 답을 기다리는 동안 키 줄 위에 선다. 프롬프트의
 * 선택지는 해석하지 않으므로 라벨 없는 고정 키 1 · 2 · 3 · ↵만 둔다. 폰 폭에서 한 줄로 서도록 보이는 문구는 짧게
 * 두고(전체 문장은 묶음 이름), 바로 아래 키 줄 첫 키와 겹치는 Esc는 싣지 않는다 — 거절·취소는 그 Esc가 맡는다.
 */
export function TerminalConfirmRow({ locale, disabled, onKey, onText }: {
  readonly locale?: ConsoleLocale;
  readonly disabled: boolean;
  readonly onKey: (id: TerminalKeyId) => void;
  readonly onText: (text: string) => void;
}) {
  const t = getT(locale);
  return (
    <div className={`terminal-confirm-row${disabled ? " is-disabled" : ""}`} role="group" aria-label={t("terminal.mobile.cliAwaiting")}>
      <span className="agent-status-glyph is-awaiting" aria-hidden="true" />
      <span className="terminal-confirm-label" aria-hidden="true">{t("terminal.mobile.cliAwaitingShort")}</span>
      <span className="terminal-confirm-keys">
        {["1", "2", "3"].map((digit) => <KeyBarButton key={digit} label={digit} disabled={disabled} onActivate={() => onText(digit)} />)}
        <KeyBarButton label="↵" name={t("terminal.keyBar.key.enter")} disabled={disabled} onActivate={() => onKey("enter")} />
      </span>
    </div>
  );
}

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

function KeyBarButton({ label, name, pressed, locked, disabled, onActivate }: {
  readonly label: string;
  readonly name?: string;
  readonly pressed?: boolean;
  readonly locked?: boolean;
  readonly disabled?: boolean;
  readonly onActivate: () => void;
}) {
  return (
    <button
      type="button"
      className={`terminal-key${locked ? " is-locked" : ""}`}
      aria-label={name}
      aria-pressed={pressed}
      disabled={disabled}
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
