/**
 * Touch gestures for the terminal surface.
 *
 * xterm handles the wheel but not the finger: its scrollable viewport is a sibling of the screen
 * the renderer paints into, so dragging over the text scrolls nothing. And a phone has no way to
 * ask for a different font size, which on a terminal is the same act as resizing it — fewer or
 * more columns, and a PTY resize behind them.
 *
 * So one finger pans the scrollback and two fingers scale the font. Both start only after the
 * touch travels past a threshold, which leaves a tap free to focus the terminal and a long press
 * free to select.
 */

export interface TerminalTouchGestureHost {
  /**
   * Hands the pan to the terminal as its own scroll input, in pixels, positive toward newer
   * output. The terminal already decides what scrolling means for what is running: its own
   * scrollback, the keys a full-screen program expects, or the wheel report a program that asked
   * for mouse tracking reads. Deciding that here would answer differently than the wheel does.
   *
   * `origin` is the finger that produced this step. A wheel report encodes a cell, so the
   * surface must know where the finger is — inventing a coordinate-less wheel is how `NaN`
   * used to reach the session.
   */
  scrollByPixels(deltaY: number, origin?: { readonly clientX: number; readonly clientY: number }): void;
}

export interface TerminalTouchGestureOptions {
  /** Applies a font scale relative to the surface's own size, already clamped. */
  readonly onFontScale: (scale: number) => void;
  /** Reads the scale a pinch starts from, so successive pinches compose. */
  readonly readFontScale: () => number;
  readonly minFontScale?: number;
  readonly maxFontScale?: number;
}

export interface TerminalTouchGestures {
  readonly dispose: () => void;
}

/** Below this the touch is still a tap or a long press, not a gesture. */
const PAN_THRESHOLD_PX = 8;
const PINCH_THRESHOLD_RATIO = 0.05;
export const MIN_FONT_SCALE = 0.6;
const MAX_FONT_SCALE = 2.2;
const DEFAULT_MIN_FONT_SCALE = MIN_FONT_SCALE;
const DEFAULT_MAX_FONT_SCALE = MAX_FONT_SCALE;

export function clampFontScale(scale: number, min = DEFAULT_MIN_FONT_SCALE, max = DEFAULT_MAX_FONT_SCALE): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, min), max);
}

export function touchDistance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function createTerminalTouchGestures(
  container: HTMLElement,
  terminal: TerminalTouchGestureHost,
  options: TerminalTouchGestureOptions,
): TerminalTouchGestures {
  const minScale = options.minFontScale ?? DEFAULT_MIN_FONT_SCALE;
  const maxScale = options.maxFontScale ?? DEFAULT_MAX_FONT_SCALE;

  let mode: "idle" | "pending" | "pan" | "pinch" = "idle";
  let panAnchorY = 0;
  let pinchStartDistance = 0;
  let pinchStartScale = 1;

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 2) {
      mode = "pinch";
      pinchStartDistance = touchDistance(event.touches[0]!, event.touches[1]!);
      pinchStartScale = options.readFontScale();
      return;
    }
    if (event.touches.length === 1) {
      mode = "pending";
      panAnchorY = event.touches[0]!.clientY;
    }
  };

  const onTouchMove = (event: TouchEvent) => {
    if (mode === "pinch") {
      if (event.touches.length < 2 || pinchStartDistance <= 0) return;
      const ratio = touchDistance(event.touches[0]!, event.touches[1]!) / pinchStartDistance;
      if (Math.abs(ratio - 1) < PINCH_THRESHOLD_RATIO) return;
      event.preventDefault();
      options.onFontScale(clampFontScale(pinchStartScale * ratio, minScale, maxScale));
      return;
    }
    if (mode !== "pending" && mode !== "pan") return;
    if (event.touches.length !== 1) return;
    const travel = event.touches[0]!.clientY - panAnchorY;
    if (mode === "pending") {
      if (Math.abs(travel) < PAN_THRESHOLD_PX) return;
      mode = "pan";
      // Start measuring from the point the pan began so the first step is not a jump.
      panAnchorY = event.touches[0]!.clientY;
      return;
    }
    event.preventDefault();
    const finger = event.touches[0]!;
    const travelled = finger.clientY - panAnchorY;
    panAnchorY = finger.clientY;
    if (travelled === 0) return;
    // Dragging down reveals older output, the direction a scrollbar would move under the finger.
    terminal.scrollByPixels(-travelled, { clientX: finger.clientX, clientY: finger.clientY });
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length === 0) mode = "idle";
    else if (mode === "pinch" && event.touches.length === 1) {
      mode = "pending";
      panAnchorY = event.touches[0]!.clientY;
    }
  };

  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return {
    dispose: () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    },
  };
}
