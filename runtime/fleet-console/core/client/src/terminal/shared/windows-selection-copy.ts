export interface WindowsSelectionCopyKeyEvent {
  readonly altKey: boolean;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly preventDefault?: () => void;
  readonly repeat?: boolean;
  readonly shiftKey: boolean;
  readonly stopPropagation?: () => void;
  readonly type: string;
}

export interface WindowsSelectionCopyDependencies {
  readonly getPlatform: () => string;
  readonly getSelection: () => string;
  readonly writeText: (text: string) => Promise<void>;
}

export interface WindowsSelectionCopyHandler {
  // Compatible with attachCustomKeyEventHandler: false blocks xterm handling, true passes through.
  readonly handleKeyEvent: (event: WindowsSelectionCopyKeyEvent) => boolean;
}

export function createWindowsSelectionCopyHandler({
  getPlatform,
  getSelection,
  writeText,
}: WindowsSelectionCopyDependencies): WindowsSelectionCopyHandler {
  return {
    handleKeyEvent(event) {
      if (!isWindowsCopyShortcut(event, getPlatform())) return true;

      // Returning false blocks PTY input; these calls also cancel the browser DevTools shortcut.
      event.preventDefault?.();
      event.stopPropagation?.();
      const selection = getSelection();
      if (selection && !event.repeat) {
        // Clipboard permission can be denied at runtime; consume the rejection so it does not become unhandled.
        void writeText(selection).catch(() => {});
      }
      return false;
    },
  };
}

function isWindowsCopyShortcut(event: WindowsSelectionCopyKeyEvent, platform: string): boolean {
  return event.type === "keydown"
    && /^win/i.test(platform)
    && event.ctrlKey
    && event.shiftKey
    && !event.altKey
    && !event.metaKey
    && (event.code === "KeyC" || event.key.toLowerCase() === "c");
}
