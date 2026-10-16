import { useMemo, useRef } from "react";
import { useRailEntries } from "../chrome/pane/pane-registry.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { useHostClientBindings } from "./host-client-context.js";

export function useHostCapabilities(resync?: () => void) {
  const railBindings = useRailEntries();
  const host = useHostClientBindings();
  const resyncRef = useRef(resync);
  resyncRef.current = resync;
  return useMemo(() => createHostCapabilities(() => resyncRef.current?.(), { railBindings, host }), [railBindings, host]);
}
