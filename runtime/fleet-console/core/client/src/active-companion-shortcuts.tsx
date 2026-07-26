import { createContext, useContext, type ReactNode } from "react";

import type { CompanionShortcutEntry } from "./shortcuts-catalog.js";

const ActiveCompanionShortcutsContext = createContext<readonly CompanionShortcutEntry[]>([]);

export function ActiveCompanionShortcutsProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: readonly CompanionShortcutEntry[];
}) {
  return (
    <ActiveCompanionShortcutsContext.Provider value={value}>
      {children}
    </ActiveCompanionShortcutsContext.Provider>
  );
}

export function useActiveCompanionShortcuts(): readonly CompanionShortcutEntry[] {
  return useContext(ActiveCompanionShortcutsContext);
}
