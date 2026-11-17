import { useEffect, useRef } from "react";

import type { Translate } from "@fleet-console/i18n";

import { MEMORY_STALE_MS } from "../../shared/contracts/memory-stale.js";
import { MEMORY_BRANCHES, type MemoryBranch, type MemoryEntry } from "../../shared/contracts/memory.js";
import type { CommodoreRunStatus, CommodoreState } from "../../shared/contracts/types.js";
import type { MapGraph, MapNode } from "./map-graph.js";
import { MEMORY_BRANCH_HINT, MEMORY_BRANCH_LABEL, memoryDay, memoryLinks } from "../commodore-memory.js";
import { CommodoreAvatar } from "../commodore-avatar.js";
import type { CommodoreMessageKey } from "../i18n/index.js";

type T = Translate<CommodoreMessageKey>;

/** 사령관 요약에 싣는 값 — 없는 항목은 뺀다(`없음` 문구 금지). */
export interface MapPanelFacts {
  readonly model: string | null;
  readonly session: number | null;
  readonly actions: number | null;
}

/** 화면 상태(view.run·defaults)에서 요약 사실을 뽑는다. */
export function mapPanelFacts(run: CommodoreRunStatus | null | undefined, defaultsModel: string | null | undefined): MapPanelFacts {
  const totals = run?.totals;
  return {
    model: run?.session?.model ?? defaultsModel ?? null,
    session: totals && totals.session > 0 ? totals.session : null,
    actions: totals && totals.actions > 0 ? totals.actions : null,
  };
}

export interface MapPanelProps {
  readonly t: T;
  readonly commodoreId: string;
  /** 고른 노드 — 없으면 사령관 요약. */
  readonly node: MapNode | null;
  readonly state: CommodoreState;
  readonly entries: readonly MemoryEntry[];
  readonly graph: MapGraph;
  readonly facts: MapPanelFacts;
  readonly branchName: (branch: MemoryBranch) => string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}

function sourceLabelOf(t: T, state: CommodoreState, sourceId: string): string {
  if (sourceId === "person") return t("commodore.intel.fromYou");
  return state.sources.find((source) => source.id === sourceId)?.label ?? sourceId;
}

function Crumb({ trail, onSelect }: { readonly trail: readonly { readonly label: string; readonly id?: string }[]; readonly onSelect: (id: string) => void }) {
  return (
    <div className="commodore-map-crumb">
      {trail.map((item, index) => (
        <span key={index}>
          {index > 0 ? <span aria-hidden="true"> / </span> : null}
          {item.id !== undefined
            ? <button type="button" className="commodore-map-crumb-link" onClick={() => onSelect(item.id!)}>{item.label}</button>
            : <span>{item.label}</span>}
        </span>
      ))}
    </div>
  );
}

function Dot({ branch, shape }: { readonly branch?: MemoryBranch | null; readonly shape?: "sq" | "ring" | "line" }) {
  return <span className={`commodore-map-dot${shape ? ` is-${shape}` : ""}`} data-branch={branch ?? ""} aria-hidden="true" />;
}

function EntryRow({ title, sub, branch, shape, onOpen }: {
  readonly title: string;
  readonly sub?: string;
  readonly branch?: MemoryBranch | null;
  readonly shape?: "sq" | "ring" | "line";
  readonly onOpen: () => void;
}) {
  return (
    <li>
      <button type="button" className="commodore-map-panel-link" onClick={onOpen}>
        <Dot branch={branch} shape={shape} />
        <span className="commodore-map-panel-link-text">{title}</span>
        {sub !== undefined && sub !== "" ? <small>{sub}</small> : null}
      </button>
    </li>
  );
}

function useStaleCount(entries: readonly MemoryEntry[]): number {
  const now = Date.now();
  return entries.filter((entry) => now - entry.verified > MEMORY_STALE_MS).length;
}

function CommanderSummary({ t, commodoreId, state, entries, graph, facts, branchName, onSelect }: Omit<MapPanelProps, "node" | "onClose">) {
  const stale = useStaleCount(entries);
  const links = graph.edges.filter((edge) => edge.kind === "link").length;
  const objectives = graph.nodes.filter((node) => node.kind === "objective").length;
  const max = Math.max(1, ...MEMORY_BRANCHES.map((branch) => entries.filter((entry) => entry.branch === branch).length));
  const name = (state.alias ?? "").trim() || "commodore";
  const stats: { readonly label: string; readonly value: number }[] = [
    { label: t("commodore.map.stat.memory"), value: entries.length },
    { label: t("commodore.map.stat.intel"), value: state.intel.length },
    { label: t("commodore.map.stat.objectives"), value: objectives },
    { label: t("commodore.map.stat.links"), value: links },
    { label: t("commodore.map.stat.stale"), value: stale },
    { label: t("commodore.map.stat.rev"), value: state.description.rev },
  ];
  return (
    <>
      <div className="commodore-map-soma">
        <CommodoreAvatar commodoreId={commodoreId} state="idle" size={52} label="" decorative />
        <div>
          <h2>{name}</h2>
          <div className="commodore-map-panel-meta">
            {[facts.model, facts.session !== null ? t("commodore.drawer.session", { n: facts.session }) : null, facts.actions !== null ? t("commodore.meta.handled", { n: facts.actions }) : null]
              .filter((part) => part !== null).join(" · ")}
          </div>
        </div>
      </div>
      {state.description.text ? <p>{state.description.text.split("\n")[0]}</p> : null}
      <div className="commodore-map-stats">
        {stats.map((stat) => (
          <div key={stat.label} className="commodore-map-stat"><b>{stat.value}</b><span>{stat.label}</span></div>
        ))}
      </div>
      <section className="commodore-map-sec" aria-label={t("commodore.map.summary.byBranch")}>
        <h3>{t("commodore.map.summary.byBranch")}</h3>
        <div className="commodore-map-bars">
          {MEMORY_BRANCHES.map((branch) => {
            const count = entries.filter((entry) => entry.branch === branch).length;
            return (
              <div key={branch} className="commodore-map-bar" data-branch={branch}>
                <button type="button" className="commodore-map-crumb-link" onClick={() => onSelect(`mem:${branch}`)}>{branchName(branch)}</button>
                <i style={{ width: `${(count / max) * 100}%` }} aria-hidden="true" />
                <span>{count}</span>
              </div>
            );
          })}
        </div>
      </section>
      <section className="commodore-map-sec" aria-label={t("commodore.map.summary.tour")}>
        <h3>{t("commodore.map.summary.tour")}</h3>
        <ol className="commodore-map-howto">
          <li>{t("commodore.map.tour.hover")}</li>
          <li>{t("commodore.map.tour.select")}</li>
          <li>{t("commodore.map.tour.chips")}</li>
        </ol>
      </section>
    </>
  );
}

function MemoryDetail({ t, node, entry, entries, branchName, onSelect }: {
  readonly t: T;
  readonly node: MapNode;
  readonly entry: MemoryEntry;
  readonly entries: readonly MemoryEntry[];
  readonly branchName: (branch: MemoryBranch) => string;
  readonly onSelect: (id: string) => void;
}) {
  const links = memoryLinks(entry, entries);
  const shared = entries.filter((candidate) =>
    candidate.ref !== entry.ref &&
    candidate.sources.some((source) => entry.sources.some((own) => own.objectiveId === source.objectiveId)),
  );
  const stale = Date.now() - entry.verified > MEMORY_STALE_MS;
  const fresh = Date.now() - entry.updated <= 7 * 24 * 60 * 60 * 1000;
  return (
    <>
      <Crumb trail={[{ label: entry.title, id: "core" }, { label: branchName(entry.branch), id: `mem:${entry.branch}` }, { label: entry.topic }]} onSelect={onSelect} />
      <h2>{entry.title}</h2>
      {entry.description ? <p>{entry.description}</p> : null}
      <div className="commodore-map-panel-meta">
        <span>{t("commodore.memory.updated", { date: memoryDay(entry.updated) })}</span>
        <span>{t("commodore.memory.verified", { date: memoryDay(entry.verified) })}</span>
        {stale ? <span className="is-stale">● {t("commodore.memory.stale")}</span> : null}
        {!stale && fresh ? <span className="is-fresh">● {t("commodore.map.detail.fresh")}</span> : null}
      </div>
      {entry.why ? <section className="commodore-map-sec" aria-label={t("commodore.memory.why")}><h3>{t("commodore.memory.why")}</h3><p>{entry.why}</p></section> : null}
      {entry.how ? <section className="commodore-map-sec" aria-label={t("commodore.memory.how")}><h3>{t("commodore.memory.how")}</h3><p>{entry.how}</p></section> : null}
      <section className="commodore-map-sec" aria-label={t("commodore.memory.sources")}>
        <h3>{t("commodore.memory.sources")}</h3>
        {entry.sources.length > 0 ? (
          <ul className="commodore-map-lst">
            {entry.sources.map((source) => (
              <EntryRow key={source.objectiveId} title={source.title} sub={t("commodore.tasks.goals")} branch={null} shape="ring" onOpen={() => onSelect(`obj:${source.objectiveId}`)} />
            ))}
          </ul>
        ) : null}
      </section>
      <section className="commodore-map-sec" aria-label={t("commodore.memory.links")}>
        <h3>{t("commodore.memory.links")}</h3>
        {links.length > 0 ? (
          <ul className="commodore-map-lst">
            {links.map((linked) => (
              <EntryRow key={linked.ref} title={linked.title} sub={branchName(linked.branch)} branch={linked.branch} onOpen={() => onSelect(`mem:${linked.ref}`)} />
            ))}
          </ul>
        ) : null}
      </section>
      {shared.length > 0 ? (
        <section className="commodore-map-sec" aria-label={t("commodore.map.objectiveMemories")}>
          <h3>{t("commodore.map.objectiveMemories")} {shared.length}</h3>
          <ul className="commodore-map-lst">
            {shared.slice(0, 8).map((other) => (
              <EntryRow key={other.ref} title={other.title} sub={branchName(other.branch)} branch={other.branch} onOpen={() => onSelect(`mem:${other.ref}`)} />
            ))}
          </ul>
        </section>
      ) : null}
      <p className="commodore-map-ref">commodore/memory/{entry.ref}.md</p>
    </>
  );
}

/**
 * 시안 모양의 상세 패널 — 고르면 그 항목, 고르지 않으면 사령관 요약.
 * 없는 값은 항목째 뺀다(`없음` 문구 금지).
 */
export function MapPanel({ t, commodoreId, node, state, entries, graph, facts, branchName, onSelect, onClose }: MapPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, [node?.id]);
  const name = (state.alias ?? "").trim() || "commodore";
  const crumbTop = { label: name, id: "core" };

  let title = name;
  let body: React.ReactNode = (
    <CommanderSummary t={t} commodoreId={commodoreId} state={state} entries={entries} graph={graph} facts={facts} branchName={branchName} onSelect={onSelect} />
  );
  const entry = node?.ref ? entries.find((candidate) => candidate.ref === node.ref) ?? null : null;
  if (node && entry && node.kind === "memory") {
    title = entry.title;
    body = <MemoryDetail t={t} node={node} entry={entry} entries={entries} branchName={branchName} onSelect={onSelect} />;
  } else if (node?.kind === "branch" && node.branch && node.branch !== "description" && node.branch !== "intel") {
    const branchEntries = entries.filter((candidate) => candidate.branch === node.branch);
    const topics = [...new Set(branchEntries.map((candidate) => candidate.topic))].sort();
    const stale = branchEntries.filter((candidate) => Date.now() - candidate.verified > MEMORY_STALE_MS).length;
    title = branchName(node.branch);
    body = (
      <>
        <Crumb trail={[crumbTop, { label: branchName(node.branch) }]} onSelect={onSelect} />
        <h2>{branchName(node.branch)}</h2>
        <p>{t(MEMORY_BRANCH_HINT[node.branch])}</p>
        <div className="commodore-map-stats">
          {[
            { label: t("commodore.map.stat.memory"), value: branchEntries.length },
            { label: t("commodore.map.stat.topics"), value: topics.length },
            { label: t("commodore.map.stat.stale"), value: stale },
          ].map((stat) => (
            <div key={stat.label} className="commodore-map-stat"><b>{stat.value}</b><span>{stat.label}</span></div>
          ))}
        </div>
        {topics.map((topic) => {
          const inTopic = branchEntries.filter((candidate) => candidate.topic === topic);
          return (
            <section key={topic} className="commodore-map-sec" aria-label={topic}>
              <h3>{topic} · {inTopic.length}</h3>
              <ul className="commodore-map-lst">
                {inTopic.map((item) => (
                  <EntryRow key={item.ref} title={item.title} sub={memoryDay(item.updated)} branch={item.branch} onOpen={() => onSelect(`mem:${item.ref}`)} />
                ))}
              </ul>
            </section>
          );
        })}
      </>
    );
  } else if (node?.kind === "topic" && node.branch && node.branch !== "description" && node.branch !== "intel" && node.topic) {
    const inTopic = entries.filter((candidate) => candidate.branch === node.branch && candidate.topic === node.topic);
    title = node.topic;
    body = (
      <>
        <Crumb trail={[crumbTop, { label: branchName(node.branch), id: `mem:${node.branch}` }, { label: node.topic }]} onSelect={onSelect} />
        <h2>{node.topic}</h2>
        <section className="commodore-map-sec" aria-label={t("commodore.map.topicEntries")}>
          <h3>{t("commodore.map.topicEntries")}</h3>
          <ul className="commodore-map-lst">
            {inTopic.map((item) => (
              <EntryRow key={item.ref} title={item.title} sub={memoryDay(item.updated)} branch={item.branch} onOpen={() => onSelect(`mem:${item.ref}`)} />
            ))}
          </ul>
        </section>
      </>
    );
  } else if (node && (node.kind === "intel-hub" || node.kind === "intel")) {
    const items = [...state.intel].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    const current = node.kind === "intel" ? state.intel.find((item) => item.id === node.intelId) ?? null : null;
    title = t("commodore.map.allIntelCount", { n: items.length });
    body = (
      <>
        <Crumb trail={[crumbTop, { label: node.kind === "intel" ? t("commodore.intel.label") : t("commodore.intel.label") }]} onSelect={onSelect} />
        <h2>{t("commodore.intel.label")}</h2>
        <p>{t("commodore.map.detail.intelLead", { n: items.length })}</p>
        {current ? (
          <section className="commodore-map-sec" aria-label={current.text}>
            <h3>{t("commodore.map.detail.intelPicked", { date: memoryDay(current.at), source: sourceLabelOf(t, state, current.source) })}</h3>
            <p>{current.text}</p>
          </section>
        ) : null}
        <section className="commodore-map-sec" aria-label={t("commodore.map.allIntelCount", { n: items.length })}>
          <h3>{t("commodore.map.allIntelCount", { n: items.length })}</h3>
          {items.length === 0 ? <p>{t("commodore.intel.empty")}</p> : (
            <ul className="commodore-map-lst">
              {items.map((item) => (
                <EntryRow key={item.id} title={item.text} sub={memoryDay(item.at)} shape="sq" onOpen={() => onSelect(`intel:${item.id}`)} />
              ))}
            </ul>
          )}
        </section>
      </>
    );
  } else if (node?.kind === "intel-overflow") {
    const items = [...state.intel].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    title = t("commodore.map.allIntelCount", { n: items.length });
    body = (
      <>
        <Crumb trail={[crumbTop, { label: t("commodore.intel.label"), id: "intel" }, { label: title }]} onSelect={onSelect} />
        <h2>{title}</h2>
        <section className="commodore-map-sec" aria-label={title}>
          <ul className="commodore-map-lst">
            {items.map((item) => (
              <EntryRow key={item.id} title={item.text} sub={`${sourceLabelOf(t, state, item.source)} · ${memoryDay(item.at)}`} shape="sq" onOpen={() => onSelect(`intel:${item.id}`)} />
            ))}
          </ul>
        </section>
      </>
    );
  } else if (node?.kind === "description") {
    title = t("commodore.description.label");
    body = (
      <>
        <Crumb trail={[crumbTop, { label: t("commodore.description.label") }]} onSelect={onSelect} />
        <h2>{t("commodore.description.label")}</h2>
        <div className="commodore-map-panel-meta">
          <span>{t("commodore.description.rev", { rev: state.description.rev, time: memoryDay(state.description.updatedAt) })}</span>
        </div>
        <section className="commodore-map-sec" aria-label={t("commodore.description.label")}>
          <p>{state.description.text}</p>
        </section>
        <p>{t("commodore.map.detail.descNote")}</p>
      </>
    );
  } else if (node?.kind === "source" && node.sourceId) {
    const items = state.intel.filter((item) => item.source === node.sourceId).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    title = node.label;
    body = (
      <>
        <Crumb trail={[crumbTop, { label: t("commodore.intel.label"), id: "intel" }, { label: node.label }]} onSelect={onSelect} />
        <h2>{node.label}</h2>
        <div className="commodore-map-panel-meta"><span>{t("commodore.map.countIntel", { n: items.length })}</span></div>
        <section className="commodore-map-sec" aria-label={t("commodore.map.sourceIntel")}>
          <h3>{t("commodore.map.sourceIntel")}</h3>
          <ul className="commodore-map-lst">
            {items.map((item) => (
              <EntryRow key={item.id} title={item.text} sub={memoryDay(item.at)} shape="sq" onOpen={() => onSelect(`intel:${item.id}`)} />
            ))}
          </ul>
        </section>
      </>
    );
  } else if (node?.kind === "objective" && node.objectiveId) {
    const linked = entries.filter((candidate) => candidate.sources.some((source) => source.objectiveId === node.objectiveId));
    title = node.label;
    body = (
      <>
        <Crumb trail={[crumbTop, { label: t("commodore.tasks.goals") }, { label: node.label }]} onSelect={onSelect} />
        <h2>{node.label}</h2>
        <p>{t("commodore.map.detail.objectiveLead", { n: linked.length })}</p>
        <section className="commodore-map-sec" aria-label={t("commodore.map.objectiveMemories")}>
          <ul className="commodore-map-lst">
            {linked.map((item) => (
              <EntryRow key={item.ref} title={item.title} sub={branchName(item.branch)} branch={item.branch} onOpen={() => onSelect(`mem:${item.ref}`)} />
            ))}
          </ul>
        </section>
      </>
    );
  }

  return (
    <aside className="commodore-map-panel" aria-label={title}>
      {node ? (
        <button ref={closeRef} type="button" className="commodore-map-icon-btn commodore-map-panel-close" aria-label={t("commodore.map.closePanel")} onClick={onClose}>✕</button>
      ) : null}
      {body}
    </aside>
  );
}
