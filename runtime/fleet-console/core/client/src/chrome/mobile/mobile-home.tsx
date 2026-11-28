import { useMemo, useRef } from "react";
import { useChromeHeightProperty } from "@fleet-console/ui/react";

import { commodoreListLoaded, commodoreSectionLabel, selectMobileCommodore, useCommodoreList, useSidebarOrder } from "../../../../../features/commodore/client/commodore-list.js";
import { openTaskforce, TaskforceStack } from "../../../../../features/commodore/client/taskforce/taskforce.js";
import { useTaskforceExperiment, useTaskforces } from "../../../../../features/commodore/client/taskforce/state.js";
import type { TaskforceSummary } from "../../../../../features/commodore/shared/contracts/taskforce.js";
import type { ConsoleCommodoreSummary } from "../../../../../features/commodore/shared/contracts/theaters.js";
import { commodoreSidebarBuckets, useCommodoreSidebarCommands } from "../../../../../features/commodore/client/sidebar-sections.js";
import { useAvatarClaims, KeyedAvatar } from "../../../../../features/workspace/client/avatars.js";
import { commodoreAvatarKey } from "../../../../../features/workspace/shared/avatars.js";
import type { MongleState } from "../../../../../features/workspace/shared/avatars.js";
import { useObjectiveClusters } from "../../../../../features/workspace/client/objective-clusters.js";
import { CommandBoardGlyph } from "../../../../../features/workspace/client/command-board/command-board.js";
import { useCommandBoardEnabled } from "../../../../../features/workspace/client/command-board/command-board-experiment.js";
import { useCommandBoardCounts } from "../../../../../features/workspace/client/command-board/command-board-data.js";
import { isNotStartedRow } from "../../../../../features/workspace/client/commander-tab/commander-rows.js";
import type { ObjectiveCluster } from "../../../../../features/objectives/shared/objective-clusters.js";
import { resolveObjectiveActivity } from "../../../../../features/execution/client/objective-activity.js";
import { openApprovalList } from "../../../../../features/execution/client/approval/store.js";
import { useT } from "../../i18n/index.js";
import { openConsoleSwitcher, useMobileAppearance } from "../../integration/mobile-appearance-store.js";
import { focusObjective } from "../../integration/store.js";
import { getViewedTheaterId } from "../../integration/viewed-theater.js";
import type { ConsoleState } from "../../integration/types.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { AttentionReason, useMobileAttentionRows } from "./mobile-attention.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { useConversationTime } from "./mobile-conversation-row.js";
import { attentionMovesFirst, entryIconOf, featuredDestinationBinding, isChipDestination, mobileHomeCommodoreId, mobilePluginRows, useMobileDestinationBindings } from "./mobile-destinations.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { MobileShortcutSheet } from "./mobile-shortcut-sheet.js";
import { useMobileUpdateReady } from "./mobile-update-sheet.js";
import { openMobilePluginDestination, pushMobileSheet, setMobileDestination, setMobileListTheater, setMobileReturnDestination } from "./mobile-store.js";
import { CommodoreRowActions } from "./mobile-sheet-host.js";
import { useLongPress } from "../../../../../features/workspace/client/long-press.js";

const HOME_ATTENTION_LIMIT = 3;
const HOME_OBJECTIVE_CHIP_LIMIT = 3;

type ChipTone = "awaiting" | "running" | "idle" | "fresh";

interface HomeObjectiveChip {
  readonly cluster: ObjectiveCluster;
  readonly tone: ChipTone;
  readonly progress: string | null;
}

function clusterTone(cluster: ObjectiveCluster, state: ConsoleState): ChipTone {
  const row = cluster.row;
  if (row?.personTurnAt !== undefined || row?.glyph === "review") return "awaiting";
  let hasRunning = false;
  for (const member of cluster.members) {
    if (member.awaitingInput || member.progress === "awaiting") return "awaiting";
    if (member.progress === "running") hasRunning = true;
    if (!member.pending) {
      const memberRecord = state.nestedObjectiveRecords.find((item) => item.id === member.objectiveId)
        ?? state.objectiveRecords.find((item) => item.id === member.objectiveId);
      if (memberRecord) {
        const memberActivity = resolveObjectiveActivity(memberRecord, state.objectiveRecordRuntime);
        if (memberActivity === "awaiting") return "awaiting";
        if (memberActivity === "running") hasRunning = true;
      }
    }
  }
  if (cluster.root) {
    const record = state.objectiveRecords.find((item) => item.id === cluster.root);
    if (record) {
      const act = resolveObjectiveActivity(record, state.objectiveRecordRuntime);
      if (act === "awaiting") return "awaiting";
      if (act === "running") hasRunning = true;
    }
    return hasRunning ? "running" : "idle";
  }
  return hasRunning ? "running" : "fresh";
}

function chipRank(tone: ChipTone): number {
  if (tone === "awaiting") return 0;
  if (tone === "running") return 1;
  if (tone === "idle") return 2;
  return 3;
}

function liveCommodoreState(chips: readonly HomeObjectiveChip[]): MongleState {
  if (chips.some((chip) => chip.tone === "awaiting")) return "awaiting";
  if (chips.some((chip) => chip.tone === "running")) return "running";
  return "idle";
}

/**
 * 홈 — 통합 지휘 허브(메신저형). 머리(Console 전환 알약 · 설정 · +), 최상단 확인 필요 스트립,
 * 사령관 행(실시간 상태 아바타 · 이름 · 마지막 말 · 1탭 인라인 지휘관 칩), 아래 통합 독(보관함/바로가기 · 통합 검색).
 */
export function MobileHome({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const appearance = useMobileAppearance();
  const updateReady = useMobileUpdateReady();
  const commodores = useCommodoreList();
  const sections = useCommodoreSidebarCommands();
  const taskforceExperiment = useTaskforceExperiment();
  const allTaskforces = useTaskforces();
  const order = useSidebarOrder();
  const clusters = useObjectiveClusters();
  const boardCounts = useCommandBoardCounts();
  const commandBoardEnabled = useCommandBoardEnabled();
  const attentionRows = useMobileAttentionRows();
  const bindings = useRailEntries();
  const shownDestinations = useMobileDestinationBindings(bindings, mobileHomeCommodoreId());
  const featured = featuredDestinationBinding(shownDestinations);
  const extraShortcuts = shownDestinations.filter((binding) => binding !== featured && isChipDestination(binding)).length + mobilePluginRows(bindings).length;
  // 사령관별 인라인 목표 칩(시작 전·완료는 지휘판으로 통합하고 진행·검토 중인 지휘관만 표시, 최대 3개).
  const chipsByCommodore = useMemo(() => {
    const map = new Map<string, HomeObjectiveChip[]>();
    for (const cluster of clusters) {
      if (!cluster.commodoreId || !cluster.row || cluster.row.commodore || cluster.row.glyph === "done" || isNotStartedRow(cluster.row)) continue;
      const tone = clusterTone(cluster, state);
      const progress = cluster.row.progress ? `${cluster.row.progress.done}/${cluster.row.progress.total}` : null;
      const list = map.get(cluster.commodoreId) ?? [];
      list.push({ cluster, tone, progress });
      map.set(cluster.commodoreId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => chipRank(a.tone) - chipRank(b.tone) || (b.cluster.row?.activityAt ?? 0) - (a.cluster.row?.activityAt ?? 0));
    }
    return map;
  }, [clusters, state]);
  // 사령관과 TF는 데스크톱 사이드바처럼 한 목록이다 — 서버가 내린 전체 순서로 섞고, 순위에 없는 행은 뒤에 붙는다. 실험이 꺼져 있으면 TF 행을 그리지 않는다.
  const faces = useMemo((): readonly HomeFace[] => {
    const rank = (id: string) => { const index = order.indexOf(id); return index === -1 ? order.length : index; };
    return [
      ...commodores.map((commodore): HomeFace => ({ kind: "commodore", id: commodore.commodoreId, commodore })),
      ...(taskforceExperiment.enabled ? allTaskforces : []).map((taskforce): HomeFace => ({ kind: "taskforce", id: taskforce.id, taskforce })),
    ].sort((left, right) => rank(left.id) - rank(right.id));
  }, [commodores, allTaskforces, taskforceExperiment.enabled, order]);
  const buckets = commodoreSidebarBuckets(sections.layout, faces, (face) => face.id);
  const time = useConversationTime();
  // 사령관 얼굴은 몽글 아바타다 — 아직 모습이 없는 키를 한 번 묶음째 뽑아 저장한다.
  useAvatarClaims();
  // 이 화면이 자기 머리를 그린다 — 호스트 상단 막대는 숨긴다.
  useClaimMobileBar({ variant: "centered", title: "", leading: "back", hidden: true });

  const consoleName = appearance.console?.label ?? window.location.hostname;
  const fallbackName = t("sidebar.commodore.fallback");
  const open = (commodore: ConsoleCommodoreSummary) => {
    setMobileReturnDestination(null);
    selectMobileCommodore(commodore.commodoreId);
    // 바로가기의 범위는 마지막으로 연 사령관의 Theater 목록 첫 줄이다 — 옛 사령관 고르기 시트와 같은 규칙.
    const home = commodore.theaters.find((theater) => theater.status === "available")?.theaterId ?? null;
    if (home) setMobileListTheater({ commodoreId: commodore.commodoreId, theaterId: home });
    setMobileDestination({ kind: "plugin", entryId: "commodore", params: { commodoreId: commodore.commodoreId } });
  };
  const openChipObjective = (commodore: ConsoleCommodoreSummary, cluster: ObjectiveCluster) => {
    setMobileReturnDestination(null);
    selectMobileCommodore(commodore.commodoreId);
    if (cluster.root) {
      setMobileDestination({ kind: "home" });
      focusObjective(cluster.root);
    } else {
      cluster.open?.();
    }
  };
  // 머리는 목록 위에 떠 있다 — 목록이 그 높이(`--m-screen-head`)만큼 위를 비운다.
  const listRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  useChromeHeightProperty(headRef, listRef, "--m-screen-head");

  const visibleAttention = attentionRows.slice(0, HOME_ATTENTION_LIMIT);

  return (
    <section ref={listRef} className="mobile-conv-list mobile-home">
      <header ref={headRef} className="mobile-conv-head mobile-screen-head">
        {/* Console 전환 알약 — 지금 연결된 Console 이름과 상태를 홈 상단에서 바로 보고 전환한다. */}
        <button
          type="button"
          data-press="r1"
          className="mobile-home-console"
          aria-label={t("mobile.home.consoleSwitchAria", { name: consoleName })}
          onClick={() => { if (!openConsoleSwitcher()) pushMobileSheet({ kind: "console" }); }}
        >
          <MobileMonogram label={consoleName} toneKey={consoleName} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? consoleName.charAt(0).toUpperCase()} round size={28} />
          <span className="mobile-home-console-name">{consoleName}</span>
          <span className="mobile-home-console-dot" data-state={state.connection === "live" ? "live" : state.connection === "offline" ? "failed" : "reconnecting"} aria-hidden="true" />
          <MobileIcon name="down" size={14} className="mobile-home-console-caret" />
        </button>
        <span className="mobile-conv-gap" />
        <button
          type="button"
          data-press="r1"
          className="mobile-conv-round"
          aria-label={updateReady ? `${t("mobile.home.settingsAria")} · ${t("chrome.system.helpUpdateReady")}` : t("mobile.home.settingsAria")}
          onClick={() => pushMobileSheet({ kind: "profile" })}
        >
          <MobileIcon name="gear" size={20} />
          {updateReady ? <span className="mobile-update-dot" aria-hidden="true" /> : null}
        </button>
        <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.list.create")} onClick={() => pushMobileSheet({ kind: "create" })}><MobileIcon name="plus" /></button>
      </header>
      <div className="mobile-conv-scroll">
        {commandBoardEnabled ? (
          <button
            type="button"
            data-press="r1"
            className="mobile-home-board-entry"
            onClick={() => setMobileDestination({ kind: "command-board" })}
          >
            <span className="mobile-home-board-entry-icon" aria-hidden="true"><CommandBoardGlyph size={18} /></span>
            <span className="mobile-home-board-entry-copy">
              <span className="mobile-home-board-entry-title">{t("commandBoard.title")}</span>
              <span className="mobile-home-board-entry-sub">
                {t("commandBoard.mobileEntrySummary", { fresh: boardCounts.fresh, active: boardCounts.active, review: boardCounts.review, done: boardCounts.done })}
              </span>
            </span>
            {boardCounts.review > 0 ? (
              <span className="mobile-home-board-entry-badge is-review">{t("commandBoard.sidebarReview", { n: boardCounts.review })}</span>
            ) : null}
            <MobileIcon name="right" size={16} className="mobile-home-chip-caret" />
          </button>
        ) : null}
        {visibleAttention.length > 0 ? (
          <section className="mobile-home-attention" aria-label={t("mobile.home.attention")}>
            <div className="mobile-home-attention-head">
              <span className="mobile-home-attention-title">
                <span className="mobile-home-attention-dot" aria-hidden="true" />
                {t("mobile.home.attention")} {attentionRows.length}
              </span>
              {attentionRows.length > HOME_ATTENTION_LIMIT ? (
                <button type="button" data-press="r1" className="mobile-home-attention-all" onClick={() => setMobileDestination({ kind: "attention" })}>{t("mobile.home.attentionAll")}</button>
              ) : null}
            </div>
            <div className="mobile-conv-attention">
              {visibleAttention.map((row) => (
                row.kind === "objectiveRecord" ? (
                  <button key={row.key} type="button" data-press="r1" className="mobile-conv-row" onClick={() => { setMobileReturnDestination(null); setMobileDestination({ kind: "home" }); focusObjective(row.objectiveRecord.id); }}>
                    <span className="mobile-conv-row-copy">
                      <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.objectiveRecord.title}</span></span>
                      <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
                    </span>
                    <MobileIcon name="right" size={16} className="mobile-home-chip-caret" />
                  </button>
                ) : row.kind === "approval" ? (
                  <button key={row.key} type="button" data-press="r1" className="mobile-conv-row" onClick={() => openApprovalList()}>
                    <span className="mobile-conv-row-copy">
                      <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.title}</span></span>
                      <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
                    </span>
                    <MobileIcon name="right" size={16} className="mobile-home-chip-caret" />
                  </button>
                ) : (
                  <button key={row.key} type="button" data-press="r1" className="mobile-conv-row" onClick={() => { setMobileReturnDestination(null); if (attentionMovesFirst(bindings, row.entryId)) openMobilePluginDestination(row.entryId, getViewedTheaterId()); row.item.open(); }}>
                    <span className="mobile-conv-row-av"><span className="mobile-conv-round is-static">{entryIconOf(bindings, row.entryId)}</span></span>
                    <span className="mobile-conv-row-copy">
                      <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.item.title}</span></span>
                      <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
                    </span>
                    <MobileIcon name="right" size={16} className="mobile-home-chip-caret" />
                  </button>
                )
              ))}
            </div>
          </section>
        ) : null}
        {sections.error ? <p className="mobile-home-section-error" role="alert">{t("sidebar.commodoreSection.error")}</p> : null}
        {faces.length === 0 && commodoreListLoaded() && sections.layout.sections.length === 0 ? <p className="mobile-conv-empty-note">{t("mobile.home.noCommodore")}</p> : null}
        {buckets.map((bucket) => {
          const rows = bucket.rows.map((face) => face.kind === "commodore"
            ? <HomeCommodoreRow
                key={face.id}
                commodore={face.commodore}
                name={commodoreSectionLabel(face.commodore, fallbackName)}
                chips={(chipsByCommodore.get(face.id) ?? []).slice(0, HOME_OBJECTIVE_CHIP_LIMIT)}
                time={time}
                onOpen={() => open(face.commodore)}
                onOpenObjective={(cluster) => openChipObjective(face.commodore, cluster)}
              />
            : <HomeTaskforceRow key={face.id} taskforce={face.taskforce} time={time} onOpen={() => openTaskforce(face.id)} />);
          if (bucket.id === undefined) return rows;
          const sectionId = bucket.id;
          const section = sections.layout.sections.find((item) => item.id === sectionId);
          const name = section?.name ?? t("sidebar.commodoreSection.none");
          const collapsed = section?.collapsed ?? sections.layout.unsectionedCollapsed;
          return <section key={bucket.id ?? "none"} className="mobile-home-section" aria-label={name}>
            <h2 className="mobile-home-section-heading">
              <button type="button" data-press="r1" className="mobile-home-section-toggle" aria-expanded={!collapsed} disabled={sections.busy}
                onClick={() => { void sections.run({ op: "collapse", sectionId, collapsed: !collapsed }); }}>
                <span className="mobile-home-section-name">{name}</span><MobileIcon name={collapsed ? "right" : "down"} size={14} />
              </button>
            </h2>
            {!collapsed ? rows.length ? rows : <p className="mobile-home-section-empty">{t("mobile.home.sectionEmpty")}</p> : null}
          </section>;
        })}
      </div>
      <footer className="mobile-home-dock">
        {extraShortcuts > 0 ? (
          <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.list.shortcutsAria")} onClick={() => pushMobileSheet({ kind: "custom", render: (close) => <MobileShortcutSheet onClose={close} /> })}><MobileIcon name="grid" /></button>
        ) : (
          <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.home.archive")} onClick={() => setMobileDestination({ kind: "archive" })}><MobileIcon name="archive" size={20} /></button>
        )}
        <button type="button" data-press="r1" className="mobile-conv-searchfield mobile-home-search" onClick={() => setMobileDestination({ kind: "search" })}>
          <MobileIcon name="search" size={18} />
          <span>{t("mobile.home.searchUnified")}</span>
        </button>
      </footer>
    </section>
  );
}

type HomeFace =
  | { readonly kind: "commodore"; readonly id: string; readonly commodore: ConsoleCommodoreSummary }
  | { readonly kind: "taskforce"; readonly id: string; readonly taskforce: TaskforceSummary };

/** TaskForce 한 줄 — 누르면 그 TF의 대화 화면이 홈 위에 선다. 사령관 줄과 같은 모양이다. */
function HomeTaskforceRow({ taskforce, time, onOpen }: {
  readonly taskforce: TaskforceSummary;
  readonly time: (timestamp: number) => string;
  readonly onOpen: () => void;
}) {
  const t = useT();
  return (
    <button type="button" data-press="r1" className="mobile-conv-row is-taskforce" data-taskforce-id={taskforce.id} onClick={onOpen}>
      <span className="mobile-conv-row-av"><TaskforceStack members={taskforce.members} /></span>
      <span className="mobile-conv-row-copy">
        <span className="mobile-conv-row-top">
          <span className="mobile-conv-row-title">{taskforce.name}</span>
          <span className="mobile-conv-row-aside">{time(taskforce.preview?.at ?? taskforce.createdAt)}</span>
        </span>
        <span className="mobile-conv-row-sub">{taskforce.preview?.text.trim() || taskforce.topic || t("mobile.home.noMessage")}</span>
      </span>
    </button>
  );
}

/**
 * 사령관 한 줄 — 실시간 상태 아바타, 누르면 그 사령관의 대화, 아래 인라인 지휘관 칩은 1탭으로 해당 목표 직행.
 * 길게 누르면(터치·펜) 그 사령관의 동작 시트(설정 · 이름과 모양 · 섹션 이동 · 삭제)를 연다.
 */
function HomeCommodoreRow({ commodore, name, chips, time, onOpen, onOpenObjective }: {
  readonly commodore: ConsoleCommodoreSummary;
  readonly name: string;
  readonly chips: readonly HomeObjectiveChip[];
  readonly time: (timestamp: number) => string;
  readonly onOpen: () => void;
  readonly onOpenObjective: (cluster: ObjectiveCluster) => void;
}) {
  const t = useT();
  const avatarState = liveCommodoreState(chips);
  const openActions = () => pushMobileSheet({ kind: "custom", render: (dismiss) => <CommodoreRowActions commodoreId={commodore.commodoreId} label={name} alias={commodore.alias ?? ""} onClose={dismiss} /> });
  const longPress = useLongPress<HTMLButtonElement>(openActions);
  return (
    <div className="mobile-home-commodore-item">
      <button
        type="button"
        data-press="r1"
        className="mobile-conv-row is-commodore"
        data-commodore-id={commodore.commodoreId}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
        onContextMenu={(event) => {
          event.preventDefault();
          if (longPress.claimContextMenu(event)) return;
          openActions();
        }}
        onClick={onOpen}
      >
        <span className="mobile-conv-row-av"><KeyedAvatar avatarKey={commodoreAvatarKey(commodore.commodoreId)} role="commodore" state={avatarState} size={52} label="" decorative /></span>
        <span className="mobile-conv-row-copy">
          <span className="mobile-conv-row-top">
            <span className="mobile-conv-row-title">{name}</span>
            {commodore.last ? <span className="mobile-conv-row-aside">{time(commodore.last.at)}</span> : null}
          </span>
          <span className="mobile-conv-row-sub">{commodore.last?.text ?? t("mobile.home.noMessage")}</span>
        </span>
      </button>
      {chips.length > 0 ? (
        <div className="mobile-home-obj-chips">
          {chips.map(({ cluster, tone, progress }) => (
            <button
              key={cluster.id}
              type="button"
              data-press="r1"
              className="mobile-home-obj-chip"
              data-tone={tone}
              onClick={() => onOpenObjective(cluster)}
            >
              <span className={`mobile-home-obj-dot is-${tone}`} aria-hidden="true" />
              <span className="mobile-home-obj-title">{cluster.title}</span>
              {progress ? <span className="mobile-home-obj-prog">{progress}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
