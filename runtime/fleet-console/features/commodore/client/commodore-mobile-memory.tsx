import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Translate } from "@fleet-console/i18n";

import { MEMORY_BRANCH_HINT, MEMORY_BRANCH_LABEL, MemoryHighlight, memoryDay, memoryDayTime, memoryExcerpt, memoryLinks, useCommodoreMemoryTree, useMemoryBranchToggle } from "./commodore-memory.js";
import { loadCommodoreMemory } from "./commodore-state.js";
import type { CommodoreMessageKey } from "./i18n/index.js";
import { openObjectiveOnPhone } from "./board.js";

type T = Translate<CommodoreMessageKey>;

const Chevron = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>;
const MemoryIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4Z" /></svg>;
const StaleDot = ({ t }: { readonly t: T }) => <span className="objectives-cm-memory-dot" role="img" aria-label={t("commodore.memory.stale")} />;

/**
 * 폰 정보 화면의 기억 — 같은 스토어를 읽되, 항목 이동과 뒤로 가기는 호스트 막대의 깊이에 싣는다. `header`(설명·정보)는 트리 위에
 * 같은 스크롤로 서고, 항목을 읽는 동안에는 내린다. 갈래는 처음에 모두 접혀 있고, 찾은 낱말은 `<mark>`로 보인다.
 */
export function CommodoreMobileMemory({ t, theaterId, trail, onOpen, onTrim, leave, header }: {
  readonly t: T;
  readonly theaterId: string;
  readonly trail: readonly string[];
  readonly onOpen: (ref: string) => void;
  readonly onTrim: (length: number) => void;
  /** 출처 목표를 열 때 세부(기억 단계 포함)를 먼저 접는다 — 사령관 화면의 `leave`. */
  readonly leave: (run: () => void) => void;
  readonly header?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const branchToggle = useMemoryBranchToggle();
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
  const toggle = branchToggle.toggle;

  if (!memory.entries.length && !header) return (
    <div className="objectives-cm-content objectives-cm-memory">
      <div className="objectives-cm-center" role="status">
        {memory.loaded || memory.failed ? <span className="objectives-cm-bigmono"><MemoryIcon /></span> : null}
        <p className="objectives-cm-center-text">{t(memory.failed ? "commodore.memory.failed" : memory.loaded ? "commodore.memory.empty" : "commodore.memory.loading")}</p>
        {memory.failed ? <button type="button" data-press="r3" className="objectives-cm-pill" onClick={() => { void loadCommodoreMemory(theaterId); }}>{t("commodore.memory.retry")}</button> : null}
      </div>
    </div>
  );

  const links = entry ? memoryLinks(entry, memory.entries) : [];
  return (
    <div ref={scrollRef} className={`objectives-cm-content objectives-cm-memory${entry ? " is-entry" : ""}`}>
      <div className="objectives-cm-pad">
        {/* 머리(설명·정보)는 항목을 읽는 동안에도 같은 자리에 마운트된 채 숨는다 — 쓰던 설명 초안이 사라지지 않는다. */}
        {header ? <div className="objectives-cm-pad-head" hidden={entry !== undefined}>{header}</div> : null}
        {entry ? <>
          <nav className="objectives-cm-memory-crumbs" aria-label={t("commodore.memory.label")}>
            <span>{t("commodore.memory.label")}</span><span aria-hidden="true">/</span><span>{t(MEMORY_BRANCH_LABEL[entry.branch])}</span><span aria-hidden="true">/</span><span>{entry.topic}</span>
          </nav>
          <div className="objectives-cm-memory-head">
            <h3 className="objectives-cm-memory-title"><MemoryHighlight text={entry.title} query={query} /></h3>
            <p className="objectives-cm-memory-desc"><MemoryHighlight text={entry.description} query={query} /></p>
            <div className="objectives-cm-memory-stamps">
              <span>{t("commodore.memory.updated", { date: memoryDay(entry.updated) })}</span>
              <span>{t("commodore.memory.verified", { date: memoryDay(entry.verified) })}</span>
              {stale(entry) ? <span className="objectives-cm-memory-due"><StaleDot t={t} />{t("commodore.memory.due")}</span> : null}
            </div>
          </div>
          <h4 className="objectives-cm-glab">{t("commodore.memory.why")}</h4>
          <p className="objectives-cm-gr objectives-cm-memory-body"><MemoryHighlight text={entry.why} query={query} /></p>
          <h4 className="objectives-cm-glab">{t("commodore.memory.how")}</h4>
          <p className="objectives-cm-gr objectives-cm-memory-body"><MemoryHighlight text={entry.how} query={query} /></p>
          {entry.sources.length ? <>
            <h4 className="objectives-cm-glab">{t("commodore.memory.sources")}</h4>
            <div className="objectives-cm-grp">
              {entry.sources.map((source) => <button key={source.objectiveId} type="button" data-press="r2" className="objectives-cm-gr objectives-cm-memory-jump is-source" aria-label={`${t("commodore.trail.open")}: ${source.title}`} onClick={() => leave(() => openObjectiveOnPhone(source.objectiveId, theaterId))}>
                <span className="objectives-cm-memory-glyph" aria-hidden="true">◎</span><span className="objectives-cm-gr-tx">{source.title}</span><Chevron />
              </button>)}
            </div>
          </> : null}
          {links.length ? <>
            <h4 className="objectives-cm-glab">{t("commodore.memory.links")}</h4>
            <div className="objectives-cm-grp">
              {links.map((link) => <button key={link.ref} type="button" data-press="r2" className="objectives-cm-gr objectives-cm-memory-jump is-link" onClick={() => open(link.ref)}>
                <span className="objectives-cm-memory-glyph" aria-hidden="true">↗</span><span className="objectives-cm-gr-tx">{link.title}<small>{t(MEMORY_BRANCH_LABEL[link.branch])}</small></span><Chevron />
              </button>)}
            </div>
          </> : null}
          <p className="objectives-cm-secnote objectives-cm-memory-path">{`commodore/memory/${entry.ref}.md`}</p>
        </> : <section className="objectives-commodore-panel-section">{!memory.entries.length ? <>
          <h3 className="objectives-commodore-panel-title">{t("commodore.memory.label")}</h3>
          <p className="objectives-cm-secnote" role="status">{t(memory.failed ? "commodore.memory.failed" : memory.loaded ? "commodore.memory.empty" : "commodore.memory.loading")}</p>
          {memory.failed ? <button type="button" data-press="r3" className="objectives-cm-pill" onClick={() => { void loadCommodoreMemory(theaterId); }}>{t("commodore.memory.retry")}</button> : null}
        </> : <>
          {header ? <h3 className="objectives-commodore-panel-title">{t("commodore.memory.label")}</h3> : null}
          <p className="objectives-cm-secnote">{t("commodore.memory.meta", { count: memory.entries.length, time: memoryDayTime(latest) })}</p>
          <label className="objectives-cm-memory-search">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
            <input type="search" value={query} placeholder={t("commodore.memory.search")} aria-label={t("commodore.memory.search")} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {searching && !branches.length ? <p className="objectives-cm-secnote" role="status">{t("commodore.memory.noMatch")}</p> : null}
          {branches.map((group) => {
            const expanded = branchToggle.isOpen(group.branch, searching);
            return <section key={group.branch} className="objectives-cm-memory-branch">
              <button type="button" data-press="r1" className="objectives-cm-memory-bhead" aria-expanded={expanded} onClick={() => toggle(group.branch)}>
                <b>{t(MEMORY_BRANCH_LABEL[group.branch])}</b><span className="is-light">{t(MEMORY_BRANCH_HINT[group.branch])}</span><span className="objectives-cm-memory-count">{group.count}</span><span className={`objectives-cm-memory-chev${expanded ? " is-open" : ""}`}><Chevron /></span>
              </button>
              {expanded ? group.topics.map((topic) => <div key={topic.topic} className="objectives-cm-memory-branch">
                <p className="objectives-cm-memory-topic"><MemoryHighlight text={topic.topic} query={query} /></p>
                <div className="objectives-cm-grp">
                  {topic.entries.map((item) => <button key={item.ref} type="button" data-press="r2" className="objectives-cm-gr objectives-cm-memory-row" onClick={() => open(item.ref)}>
                    <span className="objectives-cm-gr-tx"><b><MemoryHighlight text={item.title} query={query} /></b><small><MemoryRowNote t={t} item={item} query={query} /></small></span><span className="objectives-cm-memory-end">{stale(item) ? <StaleDot t={t} /> : null}<span>{memoryDay(item.updated)}</span></span>
                  </button>)}
                </div>
              </div>) : null}
            </section>;
          })}
        </>}</section>}
      </div>
    </div>
  );
}

/** 폰 행의 둘째 줄 — 요약이다. 낱말이 제목·요약 밖(왜·적용)에서만 맞았으면 그 자리의 발췌를 대신 보인다. */
function MemoryRowNote({ t, item, query }: { readonly t: T; readonly item: Parameters<typeof memoryExcerpt>[0]; readonly query: string }) {
  const inSummary = query.trim() !== "" && item.description.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const excerpt = inSummary ? null : memoryExcerpt(item, query);
  if (!excerpt) return <MemoryHighlight text={item.description} query={query} />;
  return <><span className="objectives-cm-memory-excerpt-field">{t(excerpt.field)} · </span><MemoryHighlight text={excerpt.text} query={query} /></>;
}
