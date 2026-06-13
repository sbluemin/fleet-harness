import { useSyncExternalStore } from "react";

import { getState, subscribe } from "../store.js";
import type { ConsoleState } from "../types.js";

export function useConsoleState(): ConsoleState {
  return useSyncExternalStore(subscribe, getState, getState);
}
