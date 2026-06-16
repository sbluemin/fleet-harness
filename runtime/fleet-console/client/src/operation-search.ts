import { sessionDisplayName } from "./format.js";
import type { ConsoleState, SessionInfo, SessionStatus, TheaterInfo } from "./types.js";

export interface OperationSearchEntry {
  readonly sessionId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly operationName: string;
  readonly cliLabel?: string;
  readonly status: SessionStatus;
}

export interface OperationSearchGroup {
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly entries: readonly OperationSearchEntry[];
}

const UNASSIGNED_GROUP_KEY = "__unassigned__";

export function buildOperationSearchEntries(current: ConsoleState): readonly OperationSearchEntry[] {
  const theaters = new Map(current.theaters.map((theater) => [theater.id, theater]));
  const entries: OperationSearchEntry[] = [];
  for (const sessionId of current.sessionOrder) {
    const session = current.sessions[sessionId];
    if (!session) continue;
    if (!session.theaterId) continue;
    entries.push(toOperationSearchEntry(session, theaters.get(session.theaterId)));
  }
  return entries;
}

export function filterOperationSearchEntries(entries: readonly OperationSearchEntry[], query: string): readonly OperationSearchEntry[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = operationSearchText(entry);
    return tokens.every((token) => haystack.includes(token));
  });
}

export function groupOperationSearchEntries(entries: readonly OperationSearchEntry[]): readonly OperationSearchGroup[] {
  const groups: OperationSearchGroup[] = [];
  const groupIndexes = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.theaterId ?? UNASSIGNED_GROUP_KEY;
    const existingIndex = groupIndexes.get(key);
    if (existingIndex !== undefined) {
      const group = groups[existingIndex];
      if (group) groups[existingIndex] = { ...group, entries: [...group.entries, entry] };
      continue;
    }
    groupIndexes.set(key, groups.length);
    groups.push({ theaterId: entry.theaterId, theaterLabel: entry.theaterLabel, entries: [entry] });
  }
  return groups;
}

export function searchTokens(query: string): readonly string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function toOperationSearchEntry(session: SessionInfo, theater: TheaterInfo | undefined): OperationSearchEntry {
  return {
    sessionId: session.sessionId,
    theaterId: session.theaterId ?? null,
    theaterLabel: theater?.label ?? session.theaterId ?? "",
    operationName: sessionDisplayName(session),
    cliLabel: session.cliLabel,
    status: session.status,
  };
}

function operationSearchText(entry: OperationSearchEntry): string {
  return [entry.operationName, entry.theaterLabel, entry.cliLabel ?? ""].join(" ").toLocaleLowerCase();
}
