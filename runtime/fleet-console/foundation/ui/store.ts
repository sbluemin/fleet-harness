import * as React from "react";

export function useStoreSnapshot<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
