import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

interface PinnedScroll {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly pinned: boolean;
  readonly jumpToLatest: () => void;
}

const PIN_SLACK_PX = 56;
