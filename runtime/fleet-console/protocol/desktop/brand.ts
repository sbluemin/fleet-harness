/** Optional DOM geometry contract. Old Consoles need not expose these anchors. Values are Console CSS px. */
export const DESKTOP_BRAND_READY_ATTRIBUTE = "data-fleet-console-ready";
export const DESKTOP_BRAND_MARK_ATTRIBUTE = "data-fleet-brand-mark";
export const DESKTOP_BRAND_WORDMARK_ATTRIBUTE = "data-fleet-brand-wordmark";

export interface DesktopBrandRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface DesktopBrandTarget {
  readonly mark: DesktopBrandRect;
  /** null when the compact sidebar deliberately shows only the emblem. */
  readonly wordmark: (DesktopBrandRect & { readonly fontSize: number }) | null;
}

/** Bound untrusted renderer values before turning them into entry CSS coordinates. */
export function readDesktopBrandTarget(value: unknown): DesktopBrandTarget | null {
  if (!record(value) || !rect(value.mark)) return null;
  const wordmark = value.wordmark;
  if (wordmark !== null && (!rect(wordmark) || !record(wordmark) || !finite(wordmark.fontSize) || wordmark.fontSize <= 0 || wordmark.fontSize > 1_000)) return null;
  const copy = (box: DesktopBrandRect): DesktopBrandRect => ({ left: box.left, top: box.top, width: box.width, height: box.height });
  return { mark: copy(value.mark), wordmark: wordmark === null ? null : { ...copy(wordmark), fontSize: wordmark.fontSize as number } };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000; }
function rect(value: unknown): value is DesktopBrandRect {
  return record(value) && finite(value.left) && finite(value.top) && finite(value.width) && value.width > 0 && finite(value.height) && value.height > 0;
}
