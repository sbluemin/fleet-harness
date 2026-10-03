import { diffSnippetLines } from "@fleet-console/markdown/diff";
import type { WikiEntry } from "./types.js";

export class WikiReapplyError extends Error {
  constructor(readonly code: "reapply_conflict" | "reapply_limit") { super(code); }
}

interface Edit { start: number; end: number; lines: string[] }

/** 겹친 변경은 추측하지 않는다. 독립 변경만 최신본 위에 재적용한다. */
export function reapplyWikiEntry(base: WikiEntry, proposed: WikiEntry, current: WikiEntry): WikiEntry {
  if (base.id !== current.id || proposed.id !== current.id) throw new WikiReapplyError("reapply_conflict");
  const result = { ...current } as WikiEntry & Record<string, unknown>;
  const before = base as unknown as Record<string, unknown>;
  const draft = proposed as unknown as Record<string, unknown>;
  const latest = current as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(draft), ...Object.keys(latest)])) {
    if (["id", "created", "updated", "version", "body"].includes(key)) continue;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (same(before[key], draft[key]) || same(draft[key], latest[key])) continue;
    if (!same(before[key], latest[key])) throw new WikiReapplyError("reapply_conflict");
    if (draft[key] === undefined) delete result[key];
    else result[key] = draft[key];
  }
  result.body = reapplyText(base.body, proposed.body, current.body);
  return result;
}

function reapplyText(base: string, proposed: string, current: string): string {
  if (base === proposed || proposed === current) return current;
  if (base === current) return proposed;
  const before = base.replace(/\r\n/g, "\n").split("\n");
  const edits = (next: string): Edit[] => {
    if ((before.length + 1) * (next.split("\n").length + 1) > (1 << 20)) throw new WikiReapplyError("reapply_limit");
    const result: Edit[] = [];
    let position = 0;
    let active: Edit | null = null;
    for (const row of diffSnippetLines(base, next)) {
      if (row.sign === " ") { active = null; position++; continue; }
      if (!active) { active = { start: position, end: position, lines: [] }; result.push(active); }
      if (row.sign === "-") active.end = ++position;
      else active.lines.push(row.text);
    }
    return result;
  };
  const server = edits(current);
  const local: Edit[] = [];
  for (const edit of edits(proposed)) {
    let duplicate = false;
    for (const other of server) {
      if (edit.start === other.start && edit.end === other.end && JSON.stringify(edit.lines) === JSON.stringify(other.lines)) { duplicate = true; break; }
      const overlap = edit.start === edit.end
        ? edit.start >= other.start && edit.start <= other.end
        : other.start === other.end
          ? other.start >= edit.start && other.start <= edit.end
          : Math.max(edit.start, other.start) < Math.min(edit.end, other.end);
      if (overlap) throw new WikiReapplyError("reapply_conflict");
    }
    if (!duplicate) local.push(edit);
  }
  const merged = [...before];
  for (const edit of [...server, ...local].sort((a, b) => b.start - a.start || b.end - a.end)) merged.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return merged.join("\n");
}
