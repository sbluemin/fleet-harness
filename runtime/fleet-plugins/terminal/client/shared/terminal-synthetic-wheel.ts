/**
 * Touch pans are turned into wheel events so xterm can decide what scrolling means
 * for whatever is running — its own scrollback, alt-buffer cursor keys, or a mouse
 * report a full-screen program asked for.
 *
 * A wheel with no client coordinates is not a real pointer. In a desktop browser the
 * constructor fills those with 0, but Android WebView leaves them unset, so xterm's
 * SGR encoder interpolates `NaN` into the report (`CSI < cb ; NaN ; NaN M`). Claude
 * Code then types that literal into its prompt. Refuse to dispatch until both axes
 * are finite numbers.
 */

export interface TerminalWheelOrigin {
  readonly clientX: number;
  readonly clientY: number;
}

export interface TerminalWheelFallbackRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function isFiniteWheelOrigin(origin: TerminalWheelOrigin | null | undefined): origin is TerminalWheelOrigin {
  return origin !== null
    && origin !== undefined
    && Number.isFinite(origin.clientX)
    && Number.isFinite(origin.clientY);
}

export function resolveSyntheticWheelOrigin(
  origin: TerminalWheelOrigin | undefined,
  fallbackRect: TerminalWheelFallbackRect | null,
): TerminalWheelOrigin | null {
  if (isFiniteWheelOrigin(origin)) return { clientX: origin.clientX, clientY: origin.clientY };
  if (fallbackRect === null) return null;
  const resolved = {
    clientX: fallbackRect.left + fallbackRect.width / 2,
    clientY: fallbackRect.top + fallbackRect.height / 2,
  };
  return isFiniteWheelOrigin(resolved) ? resolved : null;
}

export function dispatchSyntheticTerminalWheel(
  target: EventTarget & { getBoundingClientRect?: () => DOMRect },
  deltaY: number,
  origin?: TerminalWheelOrigin,
): boolean {
  if (!Number.isFinite(deltaY) || deltaY === 0) return false;
  const rect = typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
  const resolved = resolveSyntheticWheelOrigin(origin, rect);
  if (resolved === null) return false;
  target.dispatchEvent(new WheelEvent("wheel", {
    deltaY,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
    clientX: resolved.clientX,
    clientY: resolved.clientY,
  }));
  return true;
}
