import type { ReactNode } from "react";

import type { Translate } from "@fleet-console/i18n";
import { PlusGlyph } from "@fleet-console/ui/react";

import { MEMORY_STALE_MS } from "../../shared/contracts/memory-stale.js";
import { MEMORY_BRANCHES, type MemoryBranch, type MemoryEntry } from "../../shared/contracts/memory.js";
import type { CommodoreRunStatus, CommodoreState } from "../../shared/contracts/types.js";
import type { MapDisplayLabels, MapGraph, MapNode } from "./map-graph.js";
import { MEMORY_BRANCH_HINT, MEMORY_BRANCH_LABEL, memoryDay, memoryLinks } from "../commodore-memory.js";
import { CommodoreAvatar } from "../commodore-avatar.js";
import type { CommodoreMessageKey } from "../i18n/index.js";

type T = Translate<CommodoreMessageKey>;

/** 지도·우측 상세가 같은 화면 언어 표기를 쓰도록 공통 라벨 묶음을 만든다. */
export function mapDisplayLabels(t: T, branchName: (branch: MemoryBranch) => string): MapDisplayLabels {
  return {
    description: t("commodore.description.label"),
    intelHub: t("commodore.intel.label"),
    branch: branchName,
    personSource: t("commodore.intel.fromYou"),
    source: (label: string): string => t("commodore.map.node.source", { label }),
  };
}

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
  /** 요약의 「+ 설명 추가 / + 정보 추가」에서 한 번에 편집까지 연다. 없으면 `onSelect`로 대신한다. */
  readonly onQuickEdit?: (target: "desc" | "intel") => void;
  /** 요약 상태에서 패널 자체를 접는다(데스크톱 부유 인스펙터 전용). */
  readonly onDismiss?: () => void;
  /** 레일 안에서는 공용 머리(아바타·이름)가 있으니 요약 머리를 뺀다. */
  readonly compactSummary?: boolean;
  /**
   * 사람이 고치는 설명·정보 — 데스크톱 오른쪽 사이드바가 옛 「정보」 탭의 편집 조각을 그대로 넘긴다. 있으면 설명 노드는 설명 편집을,
   * 정보 노드는 정보 추가·수정·삭제 목록을 읽기 전용 글 대신 세우고, 요약은 비어 있는 쪽으로 가는 입구를 둔다. 없으면(폰) 읽기 전용이다.
   */
  readonly editors?: MapPanelEditors;
}

export interface MapPanelEditors {
  readonly description: ReactNode;
  readonly intel: ReactNode;
}

function sourceLabelOf(t: T, state: CommodoreState, sourceId: string): string {
  if (sourceId === "person") return t("commodore.intel.fromYou");
  return state.sources.find((source) => source.id === sourceId)?.label ?? sourceId;
}

interface CrumbItem {
  readonly label: string;
  /** `null`이면 선택 해제(사령관 요약으로 복귀), 문자열이면 그 노드 선택. */
  readonly id?: string | null;
}

function PanelNav({ trail, closeLabel, onSelect, onClose }: {
  readonly trail: readonly CrumbItem[];
  readonly closeLabel: string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="commodore-map-panel-nav">
      <div className="commodore-map-crumb">
        {trail.map((item, index) => (
          <span key={index}>
            {index > 0 ? <span aria-hidden="true"> / </span> : null}
            {item.id === null
              ? <button type="button" className="commodore-map-crumb-link" onClick={onClose}>{item.label}</button>
              : item.id !== undefined
                ? <button type="button" className="commodore-map-crumb-link" onClick={() => onSelect(item.id!)}>{item.label}</button>
                : <span>{item.label}</span>}
          </span>
        ))}
      </div>
      <button type="button" className="commodore-map-icon-btn commodore-map-panel-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>✕</button>
    </div>
  );
}

function Dot({ branch, shape }: { readonly branch?: MemoryBranch | null; readonly shape?: "diamond" | "ring" | "line" }) {
  return <span className={`commodore-map-dot${shape ? ` is-${shape}` : ""}`} data-branch={branch ?? ""} aria-hidden="true" />;
}

function EntryRow({ title, sub, branch, shape, onOpen }: {
  readonly title: string;
  readonly sub?: string;
  readonly branch?: MemoryBranch | null;
  readonly shape?: "diamond" | "ring" | "line";
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

function CommanderSummary({ t, commodoreId, state, entries, graph, facts, branchName, onSelect, onQuickEdit, onDismiss, compact, editors }: Omit<MapPanelProps, "node" | "onClose"> & { readonly compact?: boolean }) {
  const stale = useStaleCount(entries);
  const links = graph.edges.filter((edge) => edge.kind === "link").length;
  const objectives = graph.nodes.filter((node) => node.kind === "objective").length;
  const max = Math.max(1, ...MEMORY_BRANCHES.map((branch) => entries.filter((entry) => entry.branch === branch).length));
  const name = (state.alias ?? "").trim() || "commodore";
  const metaLine = [
    facts.model,
    facts.session !== null ? t("commodore.drawer.session", { n: facts.session }) : null,
    facts.actions !== null ? t("commodore.meta.handled", { n: facts.actions }) : null,
  ].filter((part) => part !== null).join(" · ");
  const stats: { readonly label: string; readonly value: number }[] = [
    { label: t("commodore.map.stat.memory"), value: entries.length },
    { label: t("commodore.map.stat.intel"), value: state.intel.length },
    { label: t("commodore.map.stat.objectives"), value: objectives },
    { label: t("commodore.map.stat.links"), value: links },
    { label: t("commodore.map.stat.stale"), value: stale },
    { label: t("commodore.map.stat.rev"), value: state.description.rev },
  ];
  const firstDescLine = state.description.text.split("\n")[0] ?? "";
  return (
    <>
      {compact ? (
        metaLine || onDismiss ? (
          <div className="commodore-map-panel-nav">
            {metaLine ? <div className="commodore-map-panel-meta">{metaLine}</div> : <span />}
            {onDismiss ? <button type="button" className="commodore-map-icon-btn commodore-map-panel-close" aria-label={t("commodore.map.closePanel")} title={t("commodore.map.closePanel")} onClick={onDismiss}>✕</button> : null}
          </div>
        ) : null
      ) : (
      <div className="commodore-map-soma">
        <CommodoreAvatar commodoreId={commodoreId} state="idle" size={52} label="" decorative />
        <div className="commodore-map-soma-copy">
          <h2>{name}</h2>
          {metaLine ? <div className="commodore-map-panel-meta">{metaLine}</div> : null}
        </div>
        {onDismiss ? <button type="button" className="commodore-map-icon-btn commodore-map-panel-close" aria-label={t("commodore.map.closePanel")} title={t("commodore.map.closePanel")} onClick={onDismiss}>✕</button> : null}
      </div>
      )}
      {firstDescLine ? (
        editors
          ? <button type="button" className="commodore-map-summary-desc" onClick={() => onSelect("desc")}>{firstDescLine}</button>
          : <p>{firstDescLine}</p>
      ) : null}
      {/* 비어 있는 설명·정보는 바로 편집 노드로 들어갈 수 있는 뚜렷한 동작 단추로 둔다. */}
      {editors && (!state.description.text || state.intel.length === 0) ? (
        <div className="commodore-map-quick-actions">
          {!state.description.text ? (
            <button type="button" className="commodore-map-quick-btn" onClick={() => (onQuickEdit ?? onSelect)("desc")}>
              <span className="commodore-map-quick-plus" aria-hidden="true"><PlusGlyph /></span>
              <span>{t("commodore.description.add")}</span>
            </button>
          ) : null}
          {state.intel.length === 0 ? (
            <button type="button" className="commodore-map-quick-btn" onClick={() => (onQuickEdit ?? onSelect)("intel")}>
              <span className="commodore-map-quick-plus" aria-hidden="true"><PlusGlyph /></span>
              <span>{t("commodore.intel.add")}</span>
            </button>
          ) : null}
        </div>
      ) : null}
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

function MemoryDetail({ t, entry, entries, crumbTop, branchName, onSelect, onClose }: {
  readonly t: T;
  readonly crumbTop: CrumbItem;
  readonly entry: MemoryEntry;
  readonly entries: readonly MemoryEntry[];
  readonly branchName: (branch: MemoryBranch) => string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
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
      <PanelNav
        trail={[
          crumbTop,
          { label: branchName(entry.branch), id: `mem:${entry.branch}` },
          { label: entry.topic, id: `topic:${entry.branch}:${entry.topic}` },
        ]}
        closeLabel={t("commodore.map.closePanel")}
        onSelect={onSelect}
        onClose={onClose}
      />
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
      {entry.sources.length > 0 ? (
        <section className="commodore-map-sec" aria-label={t("commodore.memory.sources")}>
          <h3>{t("commodore.memory.sources")}</h3>
          <ul className="commodore-map-lst">
            {entry.sources.map((source) => (
              <EntryRow key={source.objectiveId} title={source.title} sub={t("commodore.tasks.goals")} branch={null} shape="ring" onOpen={() => onSelect(`obj:${source.objectiveId}`)} />
            ))}
          </ul>
        </section>
      ) : null}
      {links.length > 0 ? (
        <section className="commodore-map-sec" aria-label={t("commodore.memory.links")}>
          <h3>{t("commodore.memory.links")}</h3>
          <ul className="commodore-map-lst">
            {links.map((linked) => (
              <EntryRow key={linked.ref} title={linked.title} sub={branchName(linked.branch)} branch={linked.branch} onOpen={() => onSelect(`mem:${linked.ref}`)} />
            ))}
          </ul>
        </section>
      ) : null}
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
export function MapPanel({ t, commodoreId, node, state, entries, graph, facts, branchName, onSelect, onClose, onQuickEdit, onDismiss, compactSummary, editors }: MapPanelProps) {
  const name = (state.alias ?? "").trim() || "commodore";
  const crumbTop: CrumbItem = { label: name, id: null };
  const closeLabel = t("commodore.map.closePanel");

  let title = name;
  let body: React.ReactNode = (
    <CommanderSummary t={t} commodoreId={commodoreId} state={state} entries={entries} graph={graph} facts={facts} branchName={branchName} onSelect={onSelect} {...(onQuickEdit ? { onQuickEdit } : {})} {...(onDismiss ? { onDismiss } : {})} compact={compactSummary} {...(editors ? { editors } : {})} />
  );
  const entry = node?.ref ? entries.find((candidate) => candidate.ref === node.ref) ?? null : null;
  if (node && entry && node.kind === "memory") {
    title = entry.title;
    body = <MemoryDetail t={t} entry={entry} entries={entries} crumbTop={crumbTop} branchName={branchName} onSelect={onSelect} onClose={onClose} />;
  } else if (node?.kind === "branch" && node.branch && node.branch !== "description" && node.branch !== "intel") {
    const branchEntries = entries.filter((candidate) => candidate.branch === node.branch);
    const topics = [...new Set(branchEntries.map((candidate) => candidate.topic))].sort();
    const stale = branchEntries.filter((candidate) => Date.now() - candidate.verified > MEMORY_STALE_MS).length;
    title = branchName(node.branch);
    body = (
      <>
        <PanelNav trail={[crumbTop, { label: branchName(node.branch) }]} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        <h2>{branchName(node.branch)}</h2>
        <p className="commodore-map-panel-lead">{t(MEMORY_BRANCH_HINT[node.branch])}</p>
        <div className="commodore-map-stats">
          {[
            { label: t("commodore.map.stat.memory"), value: branchEntries.length },
            { label: t("commodore.map.stat.topics"), value: topics.length },
            { label: t("commodore.map.stat.stale"), value: stale },
          ].map((stat) => (
            <div key={stat.label} className="commodore-map-stat"><b>{stat.value}</b><span>{stat.label}</span></div>
          ))}
        </div>
        {topics.length === 0 ? <p className="commodore-map-panel-note">{t("commodore.memory.empty")}</p> : topics.map((topic) => {
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
        <PanelNav trail={[crumbTop, { label: branchName(node.branch), id: `mem:${node.branch}` }, { label: node.topic }]} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
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
    title = current ? node.label : t("commodore.map.allIntelCount", { n: items.length });
    const trail: readonly CrumbItem[] = current
      ? [crumbTop, { label: t("commodore.intel.label"), id: "intel" }, { label: node.label }]
      : [crumbTop, { label: t("commodore.intel.label") }];
    const picked = current ? (
      <section className="commodore-map-sec commodore-map-picked" aria-label={current.text}>
        <h3>{t("commodore.map.detail.intelPicked", { date: memoryDay(current.at), source: sourceLabelOf(t, state, current.source) })}</h3>
        <p>{current.text}</p>
      </section>
    ) : null;
    // 편집 조각이 있으면 옛 「정보」 탭의 정보 목록(수정·삭제·「+ 정보 추가」)이 읽기 전용 목록을 대신한다 — 제목은 그 목록 머리가 진다.
    body = editors ? (
      <>
        <PanelNav trail={trail} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        {picked}
        {editors.intel}
        <p className="commodore-map-panel-note">{t("commodore.map.detail.intelLead", { n: items.length })}</p>
      </>
    ) : (
      <>
        <PanelNav trail={trail} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        <h2>{t("commodore.intel.label")}</h2>
        <p className="commodore-map-panel-lead">{t("commodore.map.detail.intelLead", { n: items.length })}</p>
        {picked}
        <section className="commodore-map-sec" aria-label={t("commodore.map.allIntelCount", { n: items.length })}>
          <h3>{t("commodore.map.allIntelCount", { n: items.length })}</h3>
          {items.length === 0 ? <p className="commodore-map-panel-lead">{t("commodore.intel.empty")}</p> : (
            <ul className="commodore-map-lst">
              {items.map((item) => (
                <EntryRow key={item.id} title={item.text} sub={memoryDay(item.at)} shape="diamond" onOpen={() => onSelect(`intel:${item.id}`)} />
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
        <PanelNav trail={[crumbTop, { label: t("commodore.intel.label"), id: "intel" }, { label: title }]} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        <h2>{title}</h2>
        <section className="commodore-map-sec" aria-label={title}>
          <ul className="commodore-map-lst">
            {items.map((item) => (
              <EntryRow key={item.id} title={item.text} sub={`${sourceLabelOf(t, state, item.source)} · ${memoryDay(item.at)}`} shape="diamond" onOpen={() => onSelect(`intel:${item.id}`)} />
            ))}
          </ul>
        </section>
      </>
    );
  } else if (node?.kind === "description") {
    title = t("commodore.description.label");
    // 편집 조각이 있으면 옛 「정보」 탭의 설명 섹션(개정·눌러 고치기·저장)이 읽기 전용 글을 대신한다 — 제목은 그 섹션 머리가 진다.
    body = editors ? (
      <>
        <PanelNav trail={[crumbTop, { label: t("commodore.description.label") }]} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        {editors.description}
        <p className="commodore-map-panel-note">{t("commodore.map.detail.descNote")}</p>
      </>
    ) : (
      <>
        <PanelNav trail={[crumbTop, { label: t("commodore.description.label") }]} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        <h2>{t("commodore.description.label")}</h2>
        {state.description.text ? (
          <div className="commodore-map-panel-meta">
            <span>{t("commodore.description.rev", { rev: state.description.rev, time: memoryDay(state.description.updatedAt) })}</span>
          </div>
        ) : null}
        <section className="commodore-map-sec" aria-label={t("commodore.description.label")}>
          {state.description.text ? <p>{state.description.text}</p> : <p className="commodore-map-panel-lead">{t("commodore.description.placeholder")}</p>}
        </section>
        <p className="commodore-map-panel-note">{t("commodore.map.detail.descNote")}</p>
      </>
    );
  } else if (node?.kind === "source" && node.sourceId) {
    const items = state.intel.filter((item) => item.source === node.sourceId).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    title = node.label;
    body = (
      <>
        <PanelNav trail={[crumbTop, { label: t("commodore.intel.label"), id: "intel" }, { label: node.label }]} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        <h2>{node.label}</h2>
        <div className="commodore-map-panel-meta"><span>{t("commodore.map.countIntel", { n: items.length })}</span></div>
        <section className="commodore-map-sec" aria-label={t("commodore.map.sourceIntel")}>
          <h3>{t("commodore.map.sourceIntel")}</h3>
          {items.length === 0 ? <p className="commodore-map-panel-lead">{t("commodore.intel.empty")}</p> : (
            <ul className="commodore-map-lst">
              {items.map((item) => (
                <EntryRow key={item.id} title={item.text} sub={memoryDay(item.at)} shape="diamond" onOpen={() => onSelect(`intel:${item.id}`)} />
              ))}
            </ul>
          )}
        </section>
      </>
    );
  } else if (node?.kind === "objective" && node.objectiveId) {
    const linked = entries.filter((candidate) => candidate.sources.some((source) => source.objectiveId === node.objectiveId));
    title = node.label;
    body = (
      <>
        <PanelNav trail={[crumbTop, { label: t("commodore.tasks.goals") }, { label: node.label }]} closeLabel={closeLabel} onSelect={onSelect} onClose={onClose} />
        <h2>{node.label}</h2>
        <p className="commodore-map-panel-lead">{t("commodore.map.detail.objectiveLead", { n: linked.length })}</p>
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
    <aside className="commodore-map-panel" data-in-rail={compactSummary ? "true" : undefined} aria-label={title}>
      {body}
    </aside>
  );
}
