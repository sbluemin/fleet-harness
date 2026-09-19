interface Disposable {
  readonly dispose: () => void;
}

interface TerminalSelectionSource {
  readonly getSelection: () => string;
  readonly onSelectionChange: (listener: () => void) => Disposable;
}

interface EventTargetLike {
  readonly addEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void;
  readonly removeEventListener: (type: string, listener: EventListener, options?: boolean | EventListenerOptions) => void;
}

interface ClipboardWriter {
  readonly writeText: (text: string) => Promise<void>;
}

export interface TerminalCopyOnSelectOptions {
  readonly terminal: TerminalSelectionSource;
  readonly selectionTarget: EventTargetLike;
  readonly windowTarget: EventTargetLike;
  readonly clipboard?: ClipboardWriter;
}

export interface TerminalCopyOnSelectController {
  readonly dispose: () => void;
}

/**
 * Copies xterm selections after the gesture that changed them completes.
 *
 * xterm 6 publishes its selection update from document mouseup before the
 * window mouseup listener runs, so reading the selection there captures the
 * completed drag without interfering with xterm's own mouse handling.
 */
export function createTerminalCopyOnSelect({
  terminal,
  selectionTarget,
  windowTarget,
  clipboard,
}: TerminalCopyOnSelectOptions): TerminalCopyOnSelectController {
  let disposed = false;
  let primaryGestureActive = false;
  let selectionDirty = false;

  const cancelGesture = () => {
    primaryGestureActive = false;
    selectionDirty = false;
  };
  const onMouseDown = (event: Event) => {
    if (!isPrimaryMouseButton(event)) return;
    primaryGestureActive = true;
    selectionDirty = false;
  };
  const onSelectionChange = () => {
    if (primaryGestureActive) selectionDirty = true;
  };
  const onMouseUp = (event: Event) => {
    const shouldCopy = primaryGestureActive && selectionDirty && isPrimaryMouseButton(event);
    cancelGesture();
    if (!shouldCopy) return;

    const selection = terminal.getSelection();
    if (!selection || !clipboard) return;
    try {
      void clipboard.writeText(selection).catch(() => undefined);
    } catch {
      // Clipboard access is best-effort; selection must remain usable if it is blocked.
    }
  };

  const selectionSubscription = terminal.onSelectionChange(onSelectionChange);
  selectionTarget.addEventListener("mousedown", onMouseDown, true);
  windowTarget.addEventListener("mouseup", onMouseUp);
  windowTarget.addEventListener("blur", cancelGesture);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelGesture();
      selectionSubscription.dispose();
      selectionTarget.removeEventListener("mousedown", onMouseDown, true);
      windowTarget.removeEventListener("mouseup", onMouseUp);
      windowTarget.removeEventListener("blur", cancelGesture);
    },
  };
}

function isPrimaryMouseButton(event: Event): boolean {
  return (event as { readonly button?: unknown }).button === 0;
}
