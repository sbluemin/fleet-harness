import { useMemo, useRef } from "react";
import { useRailEntries } from "../chrome/pane/pane-registry.js";
import { createHostCapabilities } from "./plugin-capabilities.js";

export function useHostCapabilities(resync?: () => void) {
  const railBindings = useRailEntries();
  const resyncRef = useRef(resync);
  resyncRef.current = resync;
  return useMemo(() => createHostCapabilities(() => resyncRef.current?.(), { railBindings }), [railBindings]);
}
