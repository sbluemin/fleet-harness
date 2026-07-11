import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { SHORTCUT_GROUPS } from "../shortcuts-catalog.js";

interface KeyboardShortcutsDialogProps {
  readonly onClose: () => void;
}

const KEYBOARD_SHORTCUTS_MODAL_ATTRIBUTE = "data-keyboard-shortcuts-open";
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function isKeyboardShortcutsModalOpen(): boolean {
  return document.body.getAttribute(KEYBOARD_SHORTCUTS_MODAL_ATTRIBUTE) === "true";
}

export function shouldHandleOperationsKeyboardShortcut(): boolean {
  return !isKeyboardShortcutsModalOpen();
}

export function KeyboardShortcutsDialog({ onClose }: KeyboardShortcutsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const shell = document.querySelector<HTMLElement>(".console-shell");
    const previousModalState = document.body.getAttribute(KEYBOARD_SHORTCUTS_MODAL_ATTRIBUTE);
    document.body.setAttribute(KEYBOARD_SHORTCUTS_MODAL_ATTRIBUTE, "true");
    if (shell) shell.inert = true;
    dialog?.focus();
    return () => {
      if (previousModalState === null) document.body.removeAttribute(KEYBOARD_SHORTCUTS_MODAL_ATTRIBUTE);
      else document.body.setAttribute(KEYBOARD_SHORTCUTS_MODAL_ATTRIBUTE, previousModalState);
      if (shell) shell.inert = false;
    };
  }, [onClose]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (activeElement === dialogRef.current || !dialogRef.current?.contains(activeElement) || (event.shiftKey ? activeElement === first : activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  };

  return createPortal(<div className="keyboard-shortcuts-scrim" onMouseDown={onClose}><div ref={dialogRef} className="keyboard-shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" tabIndex={-1} onKeyDown={handleKeyDown} onMouseDown={(event) => event.stopPropagation()}>
    <div className="keyboard-shortcuts-dialog-head"><strong>Keyboard Shortcuts</strong><button type="button" onClick={onClose} aria-label="Close keyboard shortcuts">✕</button></div>
    {SHORTCUT_GROUPS.map((group) => <section key={group.title} className="keyboard-shortcuts-group"><h3>{group.title}</h3><dl>{group.entries.map((entry) => <div key={`${group.title}:${entry.description}`}><dt>{entry.combos.map((combo, index) => <span key={combo.join("+")}>{index > 0 ? " or " : null}{combo.map((key) => <kbd key={key}>{key === "Mod" ? "⌘/Ctrl" : key}</kbd>)}</span>)}</dt><dd>{entry.description}</dd></div>)}</dl></section>)}
  </div></div>, document.body);
}
