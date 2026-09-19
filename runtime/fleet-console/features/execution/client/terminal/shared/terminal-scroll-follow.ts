export interface TerminalViewportPosition {
  readonly baseY: number;
  readonly viewportY: number;
}

export interface TerminalScrollFollowController {
  readonly isFollowing: () => boolean;
  readonly recordUserViewportChange: () => void;
  readonly recordUnclassifiedViewportChange: () => void;
  readonly resumeFollowing: () => void;
  readonly preserveAfterGeometryChange: (change: () => void) => void;
  readonly restoreAfterOutputParsing: () => void;
  readonly dispose: () => void;
}

interface TerminalScrollFollowOptions {
  readonly getViewport: () => TerminalViewportPosition;
  readonly scrollToBottom: () => void;
  readonly scrollToLine: (line: number) => void;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
}

export function isTerminalViewportAtBottom({ baseY, viewportY }: TerminalViewportPosition): boolean {
  return viewportY >= baseY;
}

// xterm emits the same onScroll event for user gestures, layout, and programmatic restores.
// Callers ignore unclassified events and record intent after an explicit DOM gesture settles.
export function createTerminalScrollFollow(options: TerminalScrollFollowOptions): TerminalScrollFollowController {
  let following = true;
  let manualBottomDistance: number | null = null;
  let frame: number | null = null;

  const rememberManualAnchor = () => {
    const { baseY, viewportY } = options.getViewport();
    manualBottomDistance = Math.max(0, baseY - viewportY);
  };

  const restoreManualAnchor = () => {
    if (manualBottomDistance === null) return;
    const { baseY } = options.getViewport();
    options.scrollToLine(Math.max(0, Math.min(baseY, baseY - manualBottomDistance)));
  };

  const restoreCurrentAnchor = () => {
    if (following) {
      options.scrollToBottom();
      return;
    }
    restoreManualAnchor();
  };

  const scheduleFrameRestore = () => {
    if (frame !== null) return;
    frame = options.requestFrame(() => {
      frame = null;
      restoreCurrentAnchor();
    });
  };

  const restoreIfFollowing = () => {
    if (!following) return;
    restoreCurrentAnchor();
    scheduleFrameRestore();
  };

  return {
    isFollowing: () => following,
    recordUserViewportChange: () => {
      following = isTerminalViewportAtBottom(options.getViewport());
      if (following) {
        manualBottomDistance = null;
        return;
      }
      rememberManualAnchor();
    },
    // A geometry/layout onScroll has no user-intent meaning. In particular it may arrive before
    // ResizeObserver's debounced fit and must not clear a previously followed terminal.
    recordUnclassifiedViewportChange: () => undefined,
    resumeFollowing: () => {
      following = true;
      manualBottomDistance = null;
      restoreIfFollowing();
    },
    preserveAfterGeometryChange: (change) => {
      change();
      restoreCurrentAnchor();
      scheduleFrameRestore();
    },
    restoreAfterOutputParsing: () => {
      if (following) {
        restoreIfFollowing();
        return;
      }
      // Output shifts baseY while a manual viewport remains fixed. Update the distance after
      // parsing without moving it so the next fit restores the same visible content.
      if (!isTerminalViewportAtBottom(options.getViewport())) rememberManualAnchor();
    },
    dispose: () => {
      if (frame !== null) options.cancelFrame(frame);
      frame = null;
    },
  };
}
