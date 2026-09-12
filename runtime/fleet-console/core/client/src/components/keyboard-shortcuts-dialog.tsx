import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { buildShortcutGroups, useActiveCompanionShortcuts } from "../shortcuts.js";
import { useShortcutOverrides } from "../shortcut-bindings.js";
import { openPane } from "../pane/pane-store.js";
import { openRailPanel, setRailChromeExpanded } from "../rail/rail-store.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../settings/settings-entry.js";
import { getViewModeSnapshot } from "../view-mode-store.js";

// 설정은 레일 표면이다(팔레트의 「설정 열기」와 같은 길). 폰에는 키보드 단축키도 레일도 없어
// 이 링크를 세우지 않는다.
function openShortcutSettings(): void {
  openRailPanel(SETTINGS_RAIL_ENTRY_ID);
  setRailChromeExpanded(true);
  openPane({ paneId: SETTINGS_PANE_ID, params: { section: "shortcuts" } });
}
import { useT } from "../i18n/index.js";

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
  const t = useT();
  const companionShortcuts = useActiveCompanionShortcuts();
  const overrides = useShortcutOverrides();
  const shortcutGroups = useMemo(
    () => buildShortcutGroups(t, companionShortcuts),
    // 재배정이 바뀌면 목록을 다시 짓는다 — overrides는 그 신호다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companionShortcuts, overrides, t],
  );
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

  return createPortal(<div className="keyboard-shortcuts-scrim" onMouseDown={onClose}><div ref={dialogRef} className="keyboard-shortcuts-dialog" role="dialog" aria-modal="true" aria-label={t("chrome.shortcuts.title")} tabIndex={-1} onKeyDown={handleKeyDown} onMouseDown={(event) => event.stopPropagation()}>
    <div className="keyboard-shortcuts-dialog-head"><strong>{t("chrome.shortcuts.title")}</strong><button type="button" onClick={onClose} aria-label={t("chrome.shortcuts.closeAria")}>✕</button></div>
    {getViewModeSnapshot().effective === "mobile" ? null : <p className="keyboard-shortcuts-dialog-foot">
      <button type="button" onClick={() => { onClose(); openShortcutSettings(); }}>{t("chrome.shortcuts.customize")}</button>
    </p>}
    {shortcutGroups.map((group) => <section key={group.title} className="keyboard-shortcuts-group"><h3>{group.title}</h3><dl>{group.entries.map((entry) => <div key={`${group.title}:${entry.description}`}><dt>{entry.combos.map((combo, index) => <span key={combo.join("+")}>{index > 0 ? t("chrome.shortcuts.or") : null}{combo.map((key, keyIndex) => <kbd key={`${keyIndex}:${key}`}>{key}</kbd>)}</span>)}</dt><dd>{entry.description}</dd></div>)}</dl></section>)}
  </div></div>, document.body);
}
