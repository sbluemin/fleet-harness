const XTERM_GESTURE_CHANGE_EVENT = "-xterm-gesturechange";

interface XtermGesturePoint {
  readonly clientX?: number;
  readonly clientY?: number;
}

export interface XtermGestureOriginGuard {
  readonly dispose: () => void;
}

function hasFiniteClientPoint(event: XtermGesturePoint): event is Required<XtermGesturePoint> {
  return Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
}

/**
 * xterm turns a touch release into inertial `-xterm-gesturechange` events. Unlike the changes emitted
 * while the finger is down, those internal events carry no client point. Under mouse tracking xterm
 * still encodes the point as an SGR wheel report, so the missing values become literal `NaN` fields
 * on the PTY input stream. Repair only that missing internal point before xterm's target listener sees
 * it; a real touch keeps its own coordinates.
 */
export function createXtermGestureOriginGuard(screen: HTMLElement): XtermGestureOriginGuard {
  let lastFingerPoint: Required<XtermGesturePoint> | null = null;

  const onGestureChange = (rawEvent: Event) => {
    const event = rawEvent as Event & XtermGesturePoint;
    if (hasFiniteClientPoint(event)) {
      lastFingerPoint = { clientX: event.clientX, clientY: event.clientY };
      return;
    }

    const rect = screen.getBoundingClientRect();
    const rectCentre = {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const fallback = lastFingerPoint ?? (hasFiniteClientPoint(rectCentre) ? rectCentre : null);
    if (fallback === null) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    try {
      Object.defineProperties(event, {
        clientX: { configurable: true, value: fallback.clientX },
        clientY: { configurable: true, value: fallback.clientY },
      });
    } catch {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (!hasFiniteClientPoint(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  // xterm registers a target listener during terminal.open(). Capture still runs first at the target,
  // independent of registration order, without importing its private Gesture implementation.
  screen.addEventListener(XTERM_GESTURE_CHANGE_EVENT, onGestureChange, true);
  return {
    dispose: () => screen.removeEventListener(XTERM_GESTURE_CHANGE_EVENT, onGestureChange, true),
  };
}
