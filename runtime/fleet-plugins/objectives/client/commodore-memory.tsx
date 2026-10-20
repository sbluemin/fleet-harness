import { useMemo, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { MemoryBranch, MemoryEntry } from "../server/commodore/memory.js";
import { MEMORY_STALE_MS } from "../server/commodore/memory-stale.js";
import { useCommodoreMemory } from "./commodore-state.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { revealObjective } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관의 fleet-memory — 오른쪽 패널(대화 중심 화면)과 Inbox 시트의 「기억」 칸. 사령관만 쓰고 사람은 읽기만 한다.
 *
 * 갈래(정보 칸과 같은 구분선 섹션) → 주제 → 항목 줄. 항목을 누르면 같은 칸이 그 항목의 읽기 화면이 되고, 연결된 기억으로 옮겨 다닌다.
 * 마지막 검증 뒤 30일이 지난 항목은 상태 잉크(warn) 점 하나로만 말한다.
 */

/** 서버 `MEMORY_BRANCHES` 와 같은 순서 — 서버 모듈은 파일시스템을 쓰므로 값은 여기 둔다. */
const BRANCHES: readonly MemoryBranch[] = ["person", "theater", "lessons", "crew"];
const BRANCH_LABEL: Record<MemoryBranch, ObjectiveMessageKey> = {
  person: "objectives.commodore.memory.branch.person",
  theater: "objectives.commodore.memory.branch.theater",
  lessons: "objectives.commodore.memory.branch.lessons",
  crew: "objectives.commodore.memory.branch.crew",
};
const BRANCH_HINT: Record<MemoryBranch, ObjectiveMessageKey> = {
  person: "objectives.commodore.memory.hint.person",
  theater: "objectives.commodore.memory.hint.theater",
  lessons: "objectives.commodore.memory.hint.lessons",
  crew: "objectives.commodore.memory.hint.crew",
};

const pad = (value: number) => String(value).padStart(2, "0");
/** 정보 칸과 같은 날짜 표기(MM-DD). */
const day = (at: number) => { const date = new Date(at); return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
const dayTime = (at: number) => { const date = new Date(at); return `${day(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };

function matches(entry: MemoryEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [entry.title, entry.description, entry.topic, entry.why, entry.how].some((text) => text.toLocaleLowerCase().includes(needle));
}

export function CommodoreMemory({ t, theaterId }: { readonly t: T; readonly theaterId: string }) {
  const memory = useCommodoreMemory(theaterId);
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<MemoryBranch>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const now = Date.now();
  const stale = (entry: MemoryEntry) => now - entry.verified > MEMORY_STALE_MS;

  const visible = useMemo(() => memory.entries.filter((entry) => matches(entry, query)), [memory.entries, query]);
  const branches = useMemo(() => BRANCHES.map((branch) => {
    const inBranch = visible.filter((entry) => entry.branch === branch);
    const topics = [...new Set(inBranch.map((entry) => entry.topic))].map((topic) => ({ topic, entries: inBranch.filter((entry) => entry.topic === topic) }));
    return { branch, count: inBranch.length, topics };
  }).filter((group) => group.count > 0), [visible]);

  const entry = selected ? memory.entries.find((candidate) => candidate.ref === selected) ?? null : null;
  if (entry) return <CommodoreMemoryEntry t={t} entry={entry} entries={memory.entries} stale={stale(entry)} onBack={() => setSelected(null)} onOpen={setSelected} />;

  const latest = memory.entries.reduce((max, candidate) => Math.max(max, candidate.updated), 0);
  const searching = query.trim().length > 0;
  const toggle = (branch: MemoryBranch) => setClosed((current) => {
    const next = new Set(current);
    if (next.has(branch)) next.delete(branch); else next.add(branch);
    return next;
  });

  return (
    <div className="objectives-commodore-memory">
      <div className="objectives-commodore-section">
        <div className="objectives-commodore-memory-head">
          <h3 className="objectives-commodore-section-title">{t("objectives.commodore.memory.label")}</h3>
          {memory.entries.length ? <span className="objectives-commodore-memory-meta">{t("objectives.commodore.memory.meta", { count: memory.entries.length, time: dayTime(latest) })}</span> : null}
        </div>
        {memory.entries.length ? (
          <label className="objectives-commodore-memory-search">
            <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="5.2" cy="5.2" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M7.8 7.8 L10.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
            <input type="search" value={query} placeholder={t("objectives.commodore.memory.search")} aria-label={t("objectives.commodore.memory.search")} onChange={(event) => setQuery(event.target.value)} />
          </label>
        ) : null}
        {memory.failed && !memory.entries.length ? <p className="objectives-commodore-hint">{t("objectives.commodore.memory.failed")}</p> : null}
        {memory.loaded && !memory.failed && !memory.entries.length ? <p className="objectives-commodore-hint">{t("objectives.commodore.memory.empty")}</p> : null}
        {searching && !branches.length ? <p className="objectives-commodore-hint">{t("objectives.commodore.memory.noMatch")}</p> : null}
      </div>
      {branches.map((group) => {
        const open = searching || !closed.has(group.branch);
        return (
          <section key={group.branch} className="objectives-commodore-section objectives-commodore-memory-branch">
            <button type="button" className="objectives-commodore-memory-branch-head" aria-expanded={open} onClick={() => toggle(group.branch)}>
              <span className="objectives-commodore-section-title">{t(BRANCH_LABEL[group.branch])}</span>
              <span className="objectives-commodore-memory-hint">{t(BRANCH_HINT[group.branch])}</span>
              <span className="objectives-commodore-memory-count">{group.count}</span>
              <svg className={`objectives-commodore-memory-chevron${open ? " is-open" : ""}`} viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 L6.5 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {open ? group.topics.map((topic) => (
              <div key={topic.topic} className="objectives-commodore-memory-topic">
                <span className="objectives-commodore-memory-topic-name">{topic.topic}</span>
                <ul className="objectives-commodore-memory-entries">
                  {topic.entries.map((item) => (
                    <li key={item.ref}>
                      <button type="button" className="objectives-commodore-memory-entry" title={item.description} onClick={() => setSelected(item.ref)}>
                        <span className="objectives-commodore-memory-entry-title">{item.title}</span>
                        {stale(item) ? <span className="objectives-commodore-memory-stale" role="img" aria-label={t("objectives.commodore.memory.stale")} title={t("objectives.commodore.memory.stale")} /> : null}
                        <span className="objectives-commodore-memory-date">{day(item.updated)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )) : null}
          </section>
        );
      })}
      {memory.entries.length ? (
        <div className="objectives-commodore-section objectives-commodore-memory-foot">
          <span className="objectives-commodore-memory-legend"><span className="objectives-commodore-memory-stale" aria-hidden="true" />{t("objectives.commodore.memory.stale")}</span>
          <span>{t("objectives.commodore.memory.readOnly")}</span>
        </div>
      ) : null}
    </div>
  );
}

function CommodoreMemoryEntry({ t, entry, entries, stale, onBack, onOpen }: {
  readonly t: T;
  readonly entry: MemoryEntry;
  readonly entries: readonly MemoryEntry[];
  readonly stale: boolean;
  readonly onBack: () => void;
  readonly onOpen: (ref: string) => void;
}) {
  const links = entry.links.flatMap((ref) => entries.filter((candidate) => candidate.ref === ref));
  return (
    <div className="objectives-commodore-memory is-entry">
      <div className="objectives-commodore-section">
        <nav className="objectives-commodore-memory-crumbs" aria-label={t("objectives.commodore.memory.label")}>
          <button type="button" className="objectives-commodore-text-button objectives-commodore-memory-back" onClick={onBack}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 2 L3.5 5 L6.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {t("objectives.commodore.memory.label")}
          </button>
          <span aria-hidden="true">/</span>
          <span>{t(BRANCH_LABEL[entry.branch])}</span>
          <span aria-hidden="true">/</span>
          <span className="objectives-commodore-memory-crumb-topic">{entry.topic}</span>
        </nav>
        <h3 className="objectives-commodore-memory-title">{entry.title}</h3>
        <p className="objectives-commodore-memory-description">{entry.description}</p>
        <div className="objectives-commodore-memory-stamps">
          <span>{t("objectives.commodore.memory.updated", { date: day(entry.updated) })}</span>
          <span>{t("objectives.commodore.memory.verified", { date: day(entry.verified) })}</span>
          {stale ? <span className="objectives-commodore-memory-due"><span className="objectives-commodore-memory-stale" aria-hidden="true" />{t("objectives.commodore.memory.due")}</span> : null}
        </div>
      </div>
      <section className="objectives-commodore-section">
        <h4 className="objectives-commodore-section-title">{t("objectives.commodore.memory.why")}</h4>
        <p className="objectives-commodore-memory-body">{entry.why}</p>
      </section>
      <section className="objectives-commodore-section">
        <h4 className="objectives-commodore-section-title">{t("objectives.commodore.memory.how")}</h4>
        <p className="objectives-commodore-memory-body">{entry.how}</p>
      </section>
      {entry.sources.length ? (
        <section className="objectives-commodore-section">
          <h4 className="objectives-commodore-section-title">{t("objectives.commodore.memory.sources")}</h4>
          <ul className="objectives-commodore-memory-entries is-flat">
            {entry.sources.map((source) => (
              <li key={source.objectiveId}>
                <button type="button" className="objectives-commodore-memory-entry" title={t("objectives.commodore.trail.open")} onClick={() => revealObjective({ objectiveId: source.objectiveId })}>
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
          <h4 className="objectives-commodore-section-title">{t("objectives.commodore.memory.links")}</h4>
          <ul className="objectives-commodore-memory-entries is-flat">
            {links.map((link) => (
              <li key={link.ref}>
                <button type="button" className="objectives-commodore-memory-entry" onClick={() => onOpen(link.ref)}>
                  <svg className="objectives-commodore-memory-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 7 L7 3 M4 3 H7 V6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span className="objectives-commodore-memory-entry-title">{link.title}</span>
                  <span className="objectives-commodore-memory-date">{t(BRANCH_LABEL[link.branch])}</span>
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
