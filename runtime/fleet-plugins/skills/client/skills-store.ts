import { useSyncExternalStore } from "react";

import type { SkillListItem, SkillSearchItem } from "../server/skill-types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export type ActiveTab = "installed" | "find";
export type Scope = "project" | "global";

export interface SkillsState {
  readonly activeTab: ActiveTab;
  readonly scope: Scope;
  readonly filterText: string;
  readonly searchQuery: string;
  readonly searchResults: readonly SkillSearchItem[];
  readonly searchLoading: boolean;
  readonly installedList: readonly SkillListItem[];
  readonly installedLoading: boolean;
  readonly installedContextKey: string | null;
  readonly updateJobId: string | null;
  readonly updateJobScope: Scope | null;
}

type Listener = () => void;

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_STATE: SkillsState = {
  activeTab: "installed",
  scope: "project",
  filterText: "",
  searchQuery: "",
  searchResults: [],
  searchLoading: false,
  installedList: [],
  installedLoading: false,
  installedContextKey: null,
  updateJobId: null,
  updateJobScope: null,
};

// ─── module state ─────────────────────────────────────────────────────────────

const listeners = new Set<Listener>();
let state: SkillsState = DEFAULT_STATE;

// ─── functions ───────────────────────────────────────────────────────────────

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): SkillsState {
  return state;
}

export function useSkillsStore(): SkillsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setActiveTab(tab: ActiveTab): void {
  state = { ...state, activeTab: tab };
  emit();
}

export function setScope(scope: Scope): void {
  state = { ...state, scope };
  emit();
}

export function setFilterText(filterText: string): void {
  state = { ...state, filterText };
  emit();
}

export function setSearchQuery(searchQuery: string): void {
  state = { ...state, searchQuery };
  emit();
}

export function setSearchState(results: readonly SkillSearchItem[], loading: boolean): void {
  state = { ...state, searchResults: results, searchLoading: loading };
  emit();
}

export function skillsContextKey(theaterId: string | null): string {
  return theaterId ?? "";
}

export function hasInstalledStateForContext(current: SkillsState, contextKey: string): boolean {
  return current.installedContextKey === contextKey;
}

export function setInstalledState(contextKey: string, list: readonly SkillListItem[], loading: boolean): void {
  if (state.installedContextKey !== contextKey) return;
  state = { ...state, installedList: list, installedLoading: loading };
  emit();
}

export function resetProjectContextState(contextKey: string): void {
  state = { ...state, installedContextKey: contextKey, installedList: [], installedLoading: false };
  emit();
}

export function getSkillsStateForTest(): SkillsState {
  return state;
}

export function resetSkillsStateForTest(): void {
  state = DEFAULT_STATE;
  emit();
}
