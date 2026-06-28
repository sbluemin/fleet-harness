import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

interface PinnedScroll {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly pinned: boolean;
  readonly jumpToLatest: () => void;
}

const PIN_SLACK_PX = 56;

/**
 * 스트리밍 출력용 pin-to-bottom 스크롤.
 * 바닥 근처에 있으면 새 콘텐츠를 따라가고, 사용자가 위로 스크롤하면 고정을 해제한다.
 * resetKey(잡 정체성)가 바뀌면 핀과 스크롤 위치를 초기화해 이전 잡의 상태가 이월되지 않는다.
 */
export function usePinnedScroll(resetKey: unknown, contentKey: unknown): PinnedScroll {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const updatePinned = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      updatePinned(distance <= PIN_SLACK_PX);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [updatePinned]);

  useLayoutEffect(() => {
    updatePinned(true);
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [resetKey, updatePinned]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !pinnedRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [contentKey]);

  const jumpToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    container.focus({ preventScroll: true });
    updatePinned(true);
  }, [updatePinned]);

  return { containerRef, pinned, jumpToLatest };
}
