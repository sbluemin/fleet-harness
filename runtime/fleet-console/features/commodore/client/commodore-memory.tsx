import { useMemo, useState, type ReactNode } from "react";

import type { MemoryBranch, MemoryEntry } from "../shared/contracts/memory.js";
import { MEMORY_STALE_MS } from "../shared/contracts/memory-stale.js";
import { useCommodoreMemory } from "./commodore-state.js";
import type { CommodoreMessageKey } from "./i18n/index.js";

/**
 * 사령관의 fleet-memory 를 읽는 공용 조각 — 데스크톱은 신경망(지도)이, 폰은 정보 화면의 기억 섹션이 쓴다. 사령관만 쓰고 사람은 읽기만 한다.
 *
 * 갈래 → 주제 → 항목. 찾은 낱말은 제목·주제에, 제목 밖에서 맞았으면 그 자리의 한 줄 발췌에 `<mark>`로 보인다. 마지막 검증 뒤 30일이
 * 지난 항목은 상태 잉크(warn) 점 하나로만 말한다(풀이는 점의 이름표).
 */

/** 서버 `MEMORY_BRANCHES` 와 같은 순서 — 서버 모듈은 파일시스템을 쓰므로 값은 여기 둔다. */
export const MEMORY_BRANCHES: readonly MemoryBranch[] = ["person", "theater", "lessons", "crew"];
export const MEMORY_BRANCH_LABEL: Record<MemoryBranch, CommodoreMessageKey> = {
  person: "commodore.memory.branch.person",
  theater: "commodore.memory.branch.theater",
  lessons: "commodore.memory.branch.lessons",
  crew: "commodore.memory.branch.crew",
};
export const MEMORY_BRANCH_HINT: Record<MemoryBranch, CommodoreMessageKey> = {
  person: "commodore.memory.hint.person",
  theater: "commodore.memory.hint.theater",
  lessons: "commodore.memory.hint.lessons",
  crew: "commodore.memory.hint.crew",
};

const pad = (value: number) => String(value).padStart(2, "0");
/** 정보 목록과 같은 날짜 표기(MM-DD). */
export const memoryDay = (at: number) => { const date = new Date(at); return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
export const memoryDayTime = (at: number) => { const date = new Date(at); return `${memoryDay(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };

function matches(entry: MemoryEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [entry.title, entry.description, entry.topic, entry.why, entry.how].some((text) => text.toLocaleLowerCase().includes(needle));
}

/** 찾는 낱말이 든 곳을 `<mark>`로 감싼다 — 대소문자를 가리지 않고, 글자를 바꾸지 않는다. 낱말이 없으면 글 그대로다. */
export function MemoryHighlight({ text, query }: { readonly text: string; readonly query: string }): ReactNode {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return text;
  const lower = text.toLocaleLowerCase();
  // 소문자로 바꾸며 길이가 달라지는 글자(예: İ)가 있으면 위치가 어긋난다 — 그때는 표시 없이 글 그대로 둔다.
  if (lower.length !== text.length) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

const EXCERPT_FIELDS = [["description", "commodore.memory.summary"], ["why", "commodore.memory.why"], ["how", "commodore.memory.how"]] as const;

/** 제목 밖(요약·왜·적용)에서 맞았을 때 맞은 자리를 한 줄로 — 앞뒤를 줄이되 낱말 중간에서 끊지 않으려 가까운 공백까지 민다. */
export function memoryExcerpt(entry: MemoryEntry, query: string): { readonly field: CommodoreMessageKey; readonly text: string } | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || entry.title.toLocaleLowerCase().includes(needle)) return null;
  for (const [field, label] of EXCERPT_FIELDS) {
    const text = entry[field];
    const at = text.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    let start = Math.max(0, at - 16);
    let end = Math.min(text.length, at + needle.length + 28);
    if (start > 0) { const space = text.lastIndexOf(" ", start); if (space >= 0 && start - space <= 8) start = space + 1; }
    if (end < text.length) { const space = text.indexOf(" ", end); if (space >= 0 && space - end <= 8) end = space; }
    return { field: label, text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}` };
  }
  return null;
}

export function useCommodoreMemoryTree(theaterId: string, query: string) {
  const memory = useCommodoreMemory(theaterId);
  const now = Date.now();
  const stale = (entry: MemoryEntry) => now - entry.verified > MEMORY_STALE_MS;
  const visible = useMemo(() => memory.entries.filter((entry) => matches(entry, query)), [memory.entries, query]);
  const branches = useMemo(() => MEMORY_BRANCHES.map((branch) => {
    const inBranch = visible.filter((entry) => entry.branch === branch);
    const topics = [...new Set(inBranch.map((entry) => entry.topic))].map((topic) => ({ topic, entries: inBranch.filter((entry) => entry.topic === topic) }));
    return { branch, count: inBranch.length, topics };
  }).filter((group) => group.count > 0), [visible]);
  const latest = memory.entries.reduce((max, candidate) => Math.max(max, candidate.updated), 0);
  return { memory, branches, latest, searching: query.trim().length > 0, stale };
}

export function memoryLinks(entry: MemoryEntry, entries: readonly MemoryEntry[]) {
  return entry.links.flatMap((ref) => entries.filter((candidate) => candidate.ref === ref));
}

/** 갈래 펼침 — 처음에는 모두 접혀 있다. 찾는 동안에는 맞는 갈래가 모두 펼쳐지고, 지우면 사람이 펼쳐 둔 갈래만 남는다. */
export function useMemoryBranchToggle() {
  const [opened, setOpened] = useState<ReadonlySet<MemoryBranch>>(() => new Set());
  const toggle = (branch: MemoryBranch) => setOpened((current) => {
    const next = new Set(current);
    if (next.has(branch)) next.delete(branch); else next.add(branch);
    return next;
  });
  return { isOpen: (branch: MemoryBranch, searching: boolean) => searching || opened.has(branch), toggle };
}
