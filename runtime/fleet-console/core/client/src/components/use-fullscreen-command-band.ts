import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useDesktopFullscreenSnapshot } from "../desktop-fullscreen.js";

const DISPLAY_MODE_FULLSCREEN_QUERY = "(display-mode: fullscreen)";
const INITIAL_REVEAL_MS = 480;
const LEAVE_REVEAL_MS = 480;
const ALWAYS_ALLOW_HIDE = () => true;

function isDisplayModeFullscreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DISPLAY_MODE_FULLSCREEN_QUERY).matches;
}

/**
 * Owns only the renderer fullscreen lifecycle. Pointer and focus containment
 * stay with the command-band DOM, where the edge control and band refs exist.
 */
export function useFullscreenCommandBand(canHide: () => boolean = ALWAYS_ALLOW_HIDE) {
  const nativeFullscreen = useDesktopFullscreenSnapshot();
  const [displayModeFullscreen, setDisplayModeFullscreen] = useState(isDisplayModeFullscreen);
  const desktopShell = typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
  const fullscreen = displayModeFullscreen || (desktopShell && nativeFullscreen);
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const pinnedRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(fullscreen);
  const [isVisible, setIsVisible] = useState(true);
  const [isPinned, setIsPinned] = useState(false);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideAfter = useCallback((delay: number) => {
    clearHideTimer();
    if (!fullscreenRef.current || pinnedRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      if (fullscreenRef.current && !pinnedRef.current && canHide()) setIsVisible(false);
    }, delay);
  }, [canHide, clearHideTimer]);

  const reveal = useCallback(() => {
    clearHideTimer();
    if (fullscreenRef.current) setIsVisible(true);
  }, [clearHideTimer]);

  const hideAfterLeave = useCallback(() => hideAfter(LEAVE_REVEAL_MS), [hideAfter]);

  const togglePin = useCallback(() => {
    const next = !pinnedRef.current;
    pinnedRef.current = next;
    setIsPinned(next);
    if (next) {
      clearHideTimer();
      setIsVisible(true);
    }
  }, [clearHideTimer]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DISPLAY_MODE_FULLSCREEN_QUERY);
    const syncDisplayMode = () => setDisplayModeFullscreen(mediaQuery.matches);
    syncDisplayMode();
    mediaQuery.addEventListener("change", syncDisplayMode);
    return () => mediaQuery.removeEventListener("change", syncDisplayMode);
  }, []);

  useLayoutEffect(() => {
    clearHideTimer();
    setIsFullscreen(fullscreen);
    setIsVisible(true);
    if (fullscreen && !pinnedRef.current) hideAfter(INITIAL_REVEAL_MS);
    return clearHideTimer;
  }, [clearHideTimer, fullscreen, hideAfter]);

  return { isFullscreen, isVisible, isPinned, reveal, hideAfterLeave, togglePin };
}
