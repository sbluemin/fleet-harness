import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { Translate } from "@fleet-console/i18n";

import type { MemoryBranch, MemoryEntry } from "../shared/contracts/memory.js";
import { MEMORY_STALE_MS } from "../shared/contracts/memory-stale.js";
import { useCommodoreMemory } from "./commodore-state.js";
import type { CommodoreMessageKey } from "./i18n/index.js";
import { revealObjective } from "./board.js";

type T = Translate<CommodoreMessageKey>;

/**
 * 사령관의 fleet-memory — 오른쪽 패널(대화 중심 화면)과 Inbox 시트의 「정보」 칸 맨 아래 섹션. 사령관만 쓰고 사람은 읽기만 한다.
 *
 * 갈래(정보 칸의 다른 섹션과 같은 구분선 섹션) → 주제 → 항목 줄. 갈래는 처음에 모두 접혀 있고, 찾는 동안에는 맞는 갈래가 펼쳐진다.
 * 찾은 낱말은 제목·주제에, 제목 밖에서 맞았으면 그 자리의 한 줄 발췌에 `<mark>`로 보인다. 항목을 누르면 정보 칸이 그 항목의 읽기 화면이 되고,
 * 연결된 기억으로 옮겨 다닌다. 마지막 검증 뒤 30일이 지난 항목은 상태 잉크(warn) 점 하나로만 말한다(풀이는 점의 이름표).
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
/** 지시 칸의 정보 목록과 같은 날짜 표기(MM-DD). */
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

/**
 * 정보 칸의 기억 섹션. `onReading` 은 항목 읽기 화면이 서고 내리는 것을 알린다 — 정보 칸은 읽는 동안 위 섹션(설명·정보)을 내리고
 * 읽기 화면에 칸을 내준다.
 */
export function CommodoreMemory({ t, theaterId, onReading }: { readonly t: T; readonly theaterId: string; readonly onReading?: (reading: boolean) => void }) {
  const [query, setQuery] = useState("");
  const branchToggle = useMemoryBranchToggle();
  const [selected, setSelected] = useState<string | null>(null);
  const { memory, branches, latest, searching, stale } = useCommodoreMemoryTree(theaterId, query);
  const entry = selected ? memory.entries.find((candidate) => candidate.ref === selected) ?? null : null;
  const reading = entry !== null;
  useEffect(() => { onReading?.(reading); }, [reading, onReading]);
  useEffect(() => () => onReading?.(false), [onReading]);
  if (entry) return <CommodoreMemoryEntry t={t} entry={entry} entries={memory.entries} query={query} stale={stale(entry)} onBack={() => setSelected(null)} onOpen={setSelected} />;

  const toggle = branchToggle.toggle;

  return (
    <div className="objectives-commodore-memory">
      <div className="objectives-commodore-section">
        <div className="objectives-commodore-memory-head">
          <h3 className="objectives-commodore-section-title">{t("commodore.memory.label")}</h3>
          {memory.entries.length ? <span className="objectives-commodore-memory-meta">{t("commodore.memory.meta", { count: memory.entries.length, time: memoryDayTime(latest) })}</span> : null}
        </div>
        {memory.entries.length ? (
          <label className="objectives-commodore-memory-search">
            <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="5.2" cy="5.2" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M7.8 7.8 L10.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
            <input type="search" value={query} placeholder={t("commodore.memory.search")} aria-label={t("commodore.memory.search")} onChange={(event) => setQuery(event.target.value)} />
          </label>
        ) : null}
        {memory.failed && !memory.entries.length ? <p className="objectives-commodore-hint">{t("commodore.memory.failed")}</p> : null}
        {memory.loaded && !memory.failed && !memory.entries.length ? <p className="objectives-commodore-hint">{t("commodore.memory.empty")}</p> : null}
        {searching && !branches.length ? <p className="objectives-commodore-hint">{t("commodore.memory.noMatch")}</p> : null}
      </div>
      {branches.map((group) => {
        const open = branchToggle.isOpen(group.branch, searching);
        return (
          <section key={group.branch} className="objectives-commodore-section objectives-commodore-memory-branch">
            <button type="button" className="objectives-commodore-memory-branch-head" aria-expanded={open} onClick={() => toggle(group.branch)}>
              <span className="objectives-commodore-section-title">{t(MEMORY_BRANCH_LABEL[group.branch])}</span>
              <span className="objectives-commodore-memory-hint">{t(MEMORY_BRANCH_HINT[group.branch])}</span>
              <span className="objectives-commodore-memory-count">{group.count}</span>
              <svg className={`objectives-commodore-memory-chevron${open ? " is-open" : ""}`} viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 L6.5 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {open ? group.topics.map((topic) => (
              <div key={topic.topic} className="objectives-commodore-memory-topic">
                <span className="objectives-commodore-memory-topic-name"><MemoryHighlight text={topic.topic} query={query} /></span>
                <ul className="objectives-commodore-memory-entries">
                  {topic.entries.map((item) => {
                    const excerpt = memoryExcerpt(item, query);
                    return (
                      <li key={item.ref}>
                        <button type="button" className="objectives-commodore-memory-entry" title={item.description} onClick={() => setSelected(item.ref)}>
                          <span className="objectives-commodore-memory-entry-title"><MemoryHighlight text={item.title} query={query} /></span>
                          {stale(item) ? <span className="objectives-commodore-memory-stale" role="img" aria-label={t("commodore.memory.stale")} title={t("commodore.memory.stale")} /> : null}
                          <span className="objectives-commodore-memory-date">{memoryDay(item.updated)}</span>
                          {excerpt ? <span className="objectives-commodore-memory-excerpt"><span className="objectives-commodore-memory-excerpt-field">{t(excerpt.field)} · </span><MemoryHighlight text={excerpt.text} query={query} /></span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )) : null}
          </section>
        );
      })}
    </div>
  );
}

function CommodoreMemoryEntry({ t, entry, entries, query, stale, onBack, onOpen }: {
  readonly t: T;
  readonly entry: MemoryEntry;
  readonly entries: readonly MemoryEntry[];
  /** 찾다가 연 항목이면 그 낱말 — 읽기 화면에서도 같은 자리가 보인다. */
  readonly query: string;
  readonly stale: boolean;
  readonly onBack: () => void;
  readonly onOpen: (ref: string) => void;
}) {
  const links = memoryLinks(entry, entries);
  return (
    <div className="objectives-commodore-memory is-entry">
      <div className="objectives-commodore-section">
        <nav className="objectives-commodore-memory-crumbs" aria-label={t("commodore.memory.label")}>
          <button type="button" className="objectives-commodore-text-button objectives-commodore-memory-back" onClick={onBack}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 2 L3.5 5 L6.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {t("commodore.memory.label")}
          </button>
          <span aria-hidden="true">/</span>
          <span>{t(MEMORY_BRANCH_LABEL[entry.branch])}</span>
          <span aria-hidden="true">/</span>
          <span className="objectives-commodore-memory-crumb-topic">{entry.topic}</span>
        </nav>
        <h3 className="objectives-commodore-memory-title"><MemoryHighlight text={entry.title} query={query} /></h3>
        <p className="objectives-commodore-memory-description"><MemoryHighlight text={entry.description} query={query} /></p>
        <div className="objectives-commodore-memory-stamps">
          <span>{t("commodore.memory.updated", { date: memoryDay(entry.updated) })}</span>
          <span>{t("commodore.memory.verified", { date: memoryDay(entry.verified) })}</span>
          {stale ? <span className="objectives-commodore-memory-due"><span className="objectives-commodore-memory-stale" aria-hidden="true" />{t("commodore.memory.due")}</span> : null}
        </div>
      </div>
      <section className="objectives-commodore-section">
        <h4 className="objectives-commodore-section-title">{t("commodore.memory.why")}</h4>
        <p className="objectives-commodore-memory-body"><MemoryHighlight text={entry.why} query={query} /></p>
      </section>
      <section className="objectives-commodore-section">
        <h4 className="objectives-commodore-section-title">{t("commodore.memory.how")}</h4>
        <p className="objectives-commodore-memory-body"><MemoryHighlight text={entry.how} query={query} /></p>
      </section>
      {entry.sources.length ? (
        <section className="objectives-commodore-section">
          <h4 className="objectives-commodore-section-title">{t("commodore.memory.sources")}</h4>
          <ul className="objectives-commodore-memory-entries is-flat">
            {entry.sources.map((source) => (
              <li key={source.objectiveId}>
                <button type="button" className="objectives-commodore-memory-entry" title={t("commodore.trail.open")} onClick={() => revealObjective({ objectiveId: source.objectiveId })}>
                  <svg className="objectives-commodore-memory-glyph" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.1" /><circle cx="5" cy="5" r="1.3" fill="currentColor" /></svg>
                  <span className="objectives-commodore-memory-entry-title">{source.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {links.length ? (
        <section className="objectives-commodore-section">
          <h4 className="objectives-commodore-section-title">{t("commodore.memory.links")}</h4>
          <ul className="objectives-commodore-memory-entries is-flat">
            {links.map((link) => (
              <li key={link.ref}>
                <button type="button" className="objectives-commodore-memory-entry" onClick={() => onOpen(link.ref)}>
                  <svg className="objectives-commodore-memory-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 7 L7 3 M4 3 H7 V6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span className="objectives-commodore-memory-entry-title">{link.title}</span>
                  <span className="objectives-commodore-memory-date">{t(MEMORY_BRANCH_LABEL[link.branch])}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="objectives-commodore-memory-path">{`commodore/memory/${entry.ref}.md`}</p>
    </div>
  );
}
