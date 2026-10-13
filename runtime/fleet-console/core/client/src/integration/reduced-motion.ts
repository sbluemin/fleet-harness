let reducedMotionQuery: { readonly source: Window["matchMedia"]; readonly query: MediaQueryList } | null = null;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (reducedMotionQuery?.source !== window.matchMedia) {
    reducedMotionQuery = { source: window.matchMedia, query: window.matchMedia("(prefers-reduced-motion: reduce)") };
  }
  return reducedMotionQuery.query.matches;
}
