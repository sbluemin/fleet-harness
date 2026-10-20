import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { MemoryBranch } from "../server/commodore/memory.js";
import { MEMORY_BRANCH_HINT, MEMORY_BRANCH_LABEL, memoryDay, memoryDayTime, memoryLinks, useCommodoreMemoryTree } from "./commodore-memory.js";
import { loadCommodoreMemory } from "./commodore-state.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { openObjectiveOnPhone } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

const Chevron = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>;
const MemoryIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4Z" /></svg>;
const StaleDot = ({ t }: { readonly t: T }) => <span className="objectives-cm-memory-dot" role="img" aria-label={t("objectives.commodore.memory.stale")} />;

/** 폰 기억은 같은 스토어를 읽되, 항목 이동과 뒤로 가기는 호스트 막대의 깊이에 싣는다. */
export function CommodoreMobileMemory({ t, theaterId, trail, onOpen, onTrim }: {
  readonly t: T;
  readonly theaterId: string;
  readonly trail: readonly string[];
  readonly onOpen: (ref: string) => void;
  readonly onTrim: (length: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<MemoryBranch>>(() => new Set());
  const { memory, branches, latest, searching, stale } = useCommodoreMemoryTree(theaterId, query);
  const missing = memory.loaded ? trail.findIndex((ref) => !memory.entries.some((entry) => entry.ref === ref)) : -1;
  const validTrail = missing < 0 ? trail : trail.slice(0, missing);
  const entry = memory.entries.find((candidate) => candidate.ref === validTrail.at(-1));
  useEffect(() => { if (missing >= 0) onTrim(missing); }, [missing, onTrim]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const treeScroll = useRef(0);
  const selected = entry?.ref;
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = selected ? 0 : treeScroll.current;
  }, [selected]);
  const open = (ref: string) => {
    if (!selected) treeScroll.current = scrollRef.current?.scrollTop ?? 0;
    onOpen(ref);
  };
  const toggle = (branch: MemoryBranch) => setClosed((current) => {
    const next = new Set(current);
    if (next.has(branch)) next.delete(branch); else next.add(branch);
    return next;
  });

  if (!memory.entries.length) return (
    <div className="objectives-cm-content objectives-cm-memory">
      <div className="objectives-cm-center" role="status">
        {memory.loaded || memory.failed ? <span className="objectives-cm-bigmono"><MemoryIcon /></span> : null}
        <p className="objectives-cm-center-text">{t(memory.failed ? "objectives.commodore.memory.failed" : memory.loaded ? "objectives.commodore.memory.empty" : "objectives.commodore.memory.loading")}</p>
        {memory.failed ? <button type="button" data-press="r3" className="objectives-cm-pill" onClick={() => { void loadCommodoreMemory(theaterId); }}>{t("objectives.commodore.memory.retry")}</button> : null}
      </div>
    </div>
  );

  const links = entry ? memoryLinks(entry, memory.entries) : [];
  return (
    <div ref={scrollRef} className={`objectives-cm-content objectives-cm-memory${entry ? " is-entry" : ""}`}>
      <div className="objectives-cm-pad">
        {entry ? <>
          <nav className="objectives-cm-memory-crumbs" aria-label={t("objectives.commodore.memory.label")}>
            <span>{t("objectives.commodore.memory.label")}</span><span aria-hidden="true">/</span><span>{t(MEMORY_BRANCH_LABEL[entry.branch])}</span><span aria-hidden="true">/</span><span>{entry.topic}</span>
          </nav>
          <div className="objectives-cm-memory-head">
            <h3 className="objectives-cm-memory-title">{entry.title}</h3>
            <p className="objectives-cm-memory-desc">{entry.description}</p>
            <div className="objectives-cm-memory-stamps">
              <span>{t("objectives.commodore.memory.updated", { date: memoryDay(entry.updated) })}</span>
              <span>{t("objectives.commodore.memory.verified", { date: memoryDay(entry.verified) })}</span>
              {stale(entry) ? <span className="objectives-cm-memory-due"><StaleDot t={t} />{t("objectives.commodore.memory.due")}</span> : null}
            </div>
          </div>
          <h4 className="objectives-cm-glab">{t("objectives.commodore.memory.why")}</h4>
          <p className="objectives-cm-gr objectives-cm-memory-body">{entry.why}</p>
          <h4 className="objectives-cm-glab">{t("objectives.commodore.memory.how")}</h4>
          <p className="objectives-cm-gr objectives-cm-memory-body">{entry.how}</p>
          {entry.sources.length ? <>
            <h4 className="objectives-cm-glab">{t("objectives.commodore.memory.sources")}</h4>
            <div className="objectives-cm-grp">
              {entry.sources.map((source) => <button key={source.objectiveId} type="button" data-press="r2" className="objectives-cm-gr objectives-cm-memory-jump is-source" aria-label={`${t("objectives.commodore.trail.open")}: ${source.title}`} onClick={() => openObjectiveOnPhone(source.objectiveId, theaterId)}>
                <span className="objectives-cm-memory-glyph" aria-hidden="true">◎</span><span className="objectives-cm-gr-tx">{source.title}</span><Chevron />
              </button>)}
            </div>
          </> : null}
          {links.length ? <>
            <h4 className="objectives-cm-glab">{t("objectives.commodore.memory.links")}</h4>
            <div className="objectives-cm-grp">
              {links.map((link) => <button key={link.ref} type="button" data-press="r2" className="objectives-cm-gr objectives-cm-memory-jump is-link" onClick={() => open(link.ref)}>
                <span className="objectives-cm-memory-glyph" aria-hidden="true">↗</span><span className="objectives-cm-gr-tx">{link.title}<small>{t(MEMORY_BRANCH_LABEL[link.branch])}</small></span><Chevron />
              </button>)}
            </div>
          </> : null}
          <p className="objectives-cm-secnote objectives-cm-memory-path">{`commodore/memory/${entry.ref}.md`}</p>
        </> : <>
          <p className="objectives-cm-secnote">{t("objectives.commodore.memory.meta", { count: memory.entries.length, time: memoryDayTime(latest) })}</p>
          <label className="objectives-cm-memory-search">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
            <input type="search" value={query} placeholder={t("objectives.commodore.memory.search")} aria-label={t("objectives.commodore.memory.search")} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {searching && !branches.length ? <p className="objectives-cm-secnote" role="status">{t("objectives.commodore.memory.noMatch")}</p> : null}
          {branches.map((group) => {
            const expanded = searching || !closed.has(group.branch);
            return <section key={group.branch} className="objectives-cm-memory-branch">
              <button type="button" data-press="r1" className="objectives-cm-memory-bhead" aria-expanded={expanded} onClick={() => toggle(group.branch)}>
                <b>{t(MEMORY_BRANCH_LABEL[group.branch])}</b><span className="is-light">{t(MEMORY_BRANCH_HINT[group.branch])}</span><span className="objectives-cm-memory-count">{group.count}</span><span className={`objectives-cm-memory-chev${expanded ? " is-open" : ""}`}><Chevron /></span>
              </button>
              {expanded ? group.topics.map((topic) => <div key={topic.topic} className="objectives-cm-memory-branch">
                <p className="objectives-cm-memory-topic">{topic.topic}</p>
                <div className="objectives-cm-grp">
                  {topic.entries.map((item) => <button key={item.ref} type="button" data-press="r2" className="objectives-cm-gr objectives-cm-memory-row" onClick={() => open(item.ref)}>
                    <span className="objectives-cm-gr-tx"><b>{item.title}</b><small>{item.description}</small></span><span className="objectives-cm-memory-end">{stale(item) ? <StaleDot t={t} /> : null}<span>{memoryDay(item.updated)}</span></span>
                  </button>)}
                </div>
              </div>) : null}
            </section>;
          })}
          <div className="objectives-cm-memory-foot objectives-cm-secnote"><span className="objectives-cm-memory-legend"><span className="objectives-cm-memory-dot" aria-hidden="true" />{t("objectives.commodore.memory.stale")}</span><span>{t("objectives.commodore.memory.readOnly")}</span></div>
        </>}
      </div>
    </div>
  );
}
