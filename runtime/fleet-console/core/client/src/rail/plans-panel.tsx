import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "@fleet-console/markdown/styles.css";
import { deletePlan, fetchPlanRead, fetchPlansList, fetchPlansSearch, type PlanListItem, type PlanReadResult } from "../api.js";
import { diagramHydratorLabels, getT, markdownCopyOptions, useT, type CoreMessageKey } from "../i18n/index.js";
import type { Translate } from "@fleet-console/sdk/i18n";
import "./plans.css";
import { filterPlans, formatRelativeTime, getLaneDispatchState, getProgressPercent, getWaveProgressState, normalizePlanHeading, planLaneHeadingMatches, planListSignature, type PlanStatusFilter } from "./plans-helpers.js";
import { subscribeToPlanChanges } from "./plans-events.js";
import { activatePlansSearchTarget, consumePlansSearchTarget, type PlansSearchTarget, usePlansSearchTarget } from "./plans-search-navigation.js";

interface PlansListProps {
  readonly armedDeleteName: string | null;
  readonly revealTarget: PlansSearchTarget | null;
  readonly selectedName: string | null;
  readonly state: PlansListState;
  readonly theaterId: string | null;
  readonly language: ConsoleLocale;
  readonly onArmDelete: (name: string) => void;
  readonly onDeleteSuccess: (name: string) => void;
  readonly onDisarmDelete: () => void;
  readonly onRetry: () => void;
  readonly onRevealHandled: (target: PlansSearchTarget) => void;
  readonly onSelect: (name: string) => void;
  readonly pulsedNames: ReadonlySet<string>;
}

interface PlanReaderProps {
  readonly state: PlanReaderState;
  readonly language: ConsoleLocale;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}

interface PlanDocumentProps {
  readonly plan: PlanReadResult;
  readonly language: ConsoleLocale;
  readonly onClose: () => void;
}

interface CloseButtonProps {
  readonly onClose: () => void;
}

interface EmptyStateProps {
  readonly children: string;
  readonly detail?: string;
}

interface ErrorStateProps {
  readonly message: string;
  readonly onRetry: () => void;
}

type PlansListState =
  | { readonly kind: "no-theater" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly plans: readonly PlanListItem[] }
  | { readonly kind: "error" };

type PlanReaderState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly plan: PlanReadResult }
  | { readonly kind: "error" };

const PLANS_EXTRA_WIDTH = 360;
const PLAN_DELETE_ARM_DURATION_MS = 1_500;

export const plansPanel: RailPanelDescriptor = {
  id: "plans",
  title: (locale: ConsoleLocale) => getT(locale)("rail.plans.title"),
  defaultWidth: 360,
  icon: PlansIcon,
  render: (ctx) => <PlansPanel {...ctx} />,
  search: async ({ query, theaterId, limit, signal }) => {
    const result = await fetchPlansSearch(theaterId, query, limit, signal);
    return result.plans.map((plan) => ({
      id: plan.name,
      title: plan.title,
      subtitle: plan.name,
      activate: () => activatePlansSearchTarget(theaterId, plan.name),
    }));
  },
};

function PlansPanel(ctx: RailPanelContext) {
  const contextKey = ctx.theaterId;

  return <PlansPanelBody key={contextKey} {...ctx} />;
}

function PlansPanelBody(ctx: RailPanelContext) {
  const { requestExtraWidth, theaterId } = ctx;
  const language = ctx.language ?? "en";
  const [listState, setListState] = useState<PlansListState>({ kind: "no-theater" });
  const [readerState, setReaderState] = useState<PlanReaderState>({ kind: "loading" });
  const [selectedPlan, setSelectedPlan] = useState<{ readonly theaterId: string; readonly name: string } | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [readerRetry, setReaderRetry] = useState(0);
  const [armedDeleteName, setArmedDeleteName] = useState<string | null>(null);
  const [pulsedNames, setPulsedNames] = useState<ReadonlySet<string>>(() => new Set());
  const [revealTarget, setRevealTarget] = useState<PlansSearchTarget | null>(null);
  const searchTarget = usePlansSearchTarget();
  const listRequestRef = useRef(0);
  const readerRequestRef = useRef(0);
  const listSignaturesRef = useRef<Map<string, string> | null>(null);
  const readerStateRef = useRef<PlanReaderState>(readerState);
  // reader가 요청했거나 실제 반영한 목록 signature. 요청 시작 시 예약해 동일 signature의
  // 중복 목록 갱신이 요청을 supersede하지 않게 하고, 현재 요청 실패 시 해제해 재시도를 허용한다.
  const readerSignatureRef = useRef<string | null>(null);
  // signature가 null인 삭제 확인 요청과 실패 후 재시도 가능한 상태를 구분한다.
  const readerInFlightRef = useRef(false);
  // 목록 갱신에서 선택 Plan이 사라졌을 때 세팅 — 다음 reader 조회 실패를 조용히 버리지 않고 error로 표면화한다.
  const readerForceRef = useRef(false);
  // 수동 REFRESH에서 세팅 — 다음 목록 조회 실패를 background로 삼키지 않고 error로 표면화한다.
  const listSurfaceFailureRef = useRef(false);
  const selectedNameRef = useRef<string | null>(null);
  const armedNameRef = useRef<string | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedName = selectedPlan?.theaterId === theaterId ? selectedPlan.name : null;

  useEffect(() => {
    if (!searchTarget || searchTarget.theaterId !== theaterId || !theaterId) return;
    setSelectedPlan({ theaterId, name: searchTarget.name });
    setRevealTarget(searchTarget);
  }, [searchTarget, theaterId]);

  useEffect(() => {
    selectedNameRef.current = selectedName;
  }, [selectedName]);

  const clearDeleteArmTimer = useCallback(() => {
    if (deleteArmTimerRef.current === null) return;
    clearTimeout(deleteArmTimerRef.current);
    deleteArmTimerRef.current = null;
  }, []);
  const disarmDelete = useCallback(() => {
    clearDeleteArmTimer();
    armedNameRef.current = null;
    setArmedDeleteName(null);
  }, [clearDeleteArmTimer]);
  const armDelete = useCallback((name: string) => {
    clearDeleteArmTimer();
    armedNameRef.current = name;
    setArmedDeleteName(name);
    deleteArmTimerRef.current = setTimeout(() => {
      deleteArmTimerRef.current = null;
      armedNameRef.current = null;
      setArmedDeleteName(null);
    }, PLAN_DELETE_ARM_DURATION_MS);
  }, [clearDeleteArmTimer]);

  useEffect(() => {
    const requestId = ++listRequestRef.current;

    if (!theaterId) {
      setListState({ kind: "no-theater" });
      return;
    }

    const isBackgroundRevalidation = listSignaturesRef.current !== null;
    // 수동 REFRESH는 background여도 실패를 침묵시키지 않는다 — 기존 행은 유지하되 실패 시 error를 표면화.
    const surfaceFailure = listSurfaceFailureRef.current;
    listSurfaceFailureRef.current = false;
    if (!isBackgroundRevalidation) setListState({ kind: "loading" });
    void fetchPlansList(theaterId).then((result) => {
      if (requestId !== listRequestRef.current) return;
      const nextSignatures = new Map(result.plans.map((plan) => [plan.name, planListSignature(plan)]));
      const previousSignatures = listSignaturesRef.current;
      if (previousSignatures) {
        const changed = new Set(result.plans.filter((plan) => previousSignatures.get(plan.name) !== nextSignatures.get(plan.name)).map((plan) => plan.name));
        if (changed.size > 0) {
          if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
          setPulsedNames(changed);
          pulseTimerRef.current = setTimeout(() => setPulsedNames(new Set()), 1_200);
        }
      }
      listSignaturesRef.current = nextSignatures;
      setListState({ kind: "ready", plans: result.plans });
      const currentArmedName = armedNameRef.current;
      if (currentArmedName && !nextSignatures.has(currentArmedName)) disarmDelete();
      // 목록 갱신 완료 시점의 현재 선택(effect 시작 시점 클로저가 아닌)과 reader 반영분을 비교한다.
      const currentSelection = selectedNameRef.current;
      if (currentSelection) {
        if (!nextSignatures.has(currentSelection)) {
          if (readerSignatureRef.current !== null || !readerInFlightRef.current) {
            readerSignatureRef.current = null;
            readerForceRef.current = true;
            setReaderRetry((attempt) => attempt + 1);
          }
        } else if (nextSignatures.get(currentSelection) !== readerSignatureRef.current) {
          setReaderRetry((attempt) => attempt + 1);
        }
      }
    }).catch(() => {
      if (requestId === listRequestRef.current && (!isBackgroundRevalidation || surfaceFailure)) setListState({ kind: "error" });
    });
  }, [disarmDelete, theaterId, listRetry]);

  useEffect(() => {
    const requestId = ++readerRequestRef.current;

    if (!theaterId || !selectedName) return;

    readerInFlightRef.current = true;
    readerSignatureRef.current = listSignaturesRef.current?.get(selectedName) ?? null;
    const forceSurface = readerForceRef.current;
    readerForceRef.current = false;
    const isBackgroundRevalidation = !forceSurface
      && readerStateRef.current.kind === "ready"
      && readerStateRef.current.plan.name === selectedName;
    if (!isBackgroundRevalidation) {
      readerStateRef.current = { kind: "loading" };
      setReaderState({ kind: "loading" });
    }
    void fetchPlanRead(theaterId, selectedName).then((result) => {
      if (requestId === readerRequestRef.current) {
        readerInFlightRef.current = false;
        readerSignatureRef.current = listSignaturesRef.current?.get(result.name) ?? null;
        const nextState = { kind: "ready", plan: result } as const;
        readerStateRef.current = nextState;
        setReaderState(nextState);
      }
    }).catch(() => {
      // background 재검증도 실패는 표면화한다 — 성공만 무깜빡임 교체 대상이며, 열린 리더가
      // 읽기 불가(413 등)로 바뀐 사실을 낡은 본문으로 가리면 안 된다. loopback 특성상
      // 일시 네트워크 실패로 인한 오탐 여지는 사실상 없다.
      if (requestId === readerRequestRef.current) {
        readerInFlightRef.current = false;
        readerSignatureRef.current = null;
        readerStateRef.current = { kind: "error" };
        setReaderState({ kind: "error" });
      }
    });
  }, [readerRetry, selectedName, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    return subscribeToPlanChanges(theaterId, () => {
      setListRetry((attempt) => attempt + 1);
    });
  }, [theaterId]);

  useEffect(() => () => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
  }, []);

  useEffect(() => clearDeleteArmTimer, [clearDeleteArmTimer]);

  useLayoutEffect(() => {
    requestExtraWidth?.(selectedName ? PLANS_EXTRA_WIDTH : null);
    return () => requestExtraWidth?.(null);
  }, [requestExtraWidth, selectedName]);

  const handleSelect = useCallback((name: string) => {
    if (theaterId) setSelectedPlan({ theaterId, name });
  }, [theaterId]);
  const handleRevealHandled = useCallback((target: PlansSearchTarget) => {
    consumePlansSearchTarget(target);
    setRevealTarget((current) => current?.requestId === target.requestId ? null : current);
  }, []);
  // 닫힌 리더는 유지할 내용이 없다 — ref/상태를 함께 리셋해 같은 플랜 재열람이 background로
  // 오분류되어 읽기 실패를 침묵시키는 일이 없게 한다(재열람은 항상 foreground).
  const handleClose = useCallback(() => {
    setSelectedPlan(null);
    readerInFlightRef.current = false;
    readerSignatureRef.current = null;
    readerStateRef.current = { kind: "loading" };
    setReaderState({ kind: "loading" });
  }, []);
  const refreshPlans = useCallback(() => {
    listSurfaceFailureRef.current = true;
    setListRetry((attempt) => attempt + 1);
  }, []);
  const retryList = refreshPlans;
  const retryReader = useCallback(() => setReaderRetry((attempt) => attempt + 1), []);
  const handleDeleteSuccess = useCallback((name: string) => {
    if (selectedNameRef.current === name) handleClose();
    refreshPlans();
  }, [handleClose, refreshPlans]);

  return (
    <div className="plans-panel-shell">
      <div className={`plans-root${selectedName ? " is-reader-open" : ""}`} onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (armedDeleteName) {
          event.preventDefault();
          disarmDelete();
          return;
        }
        if (selectedName) handleClose();
      }}>
        {selectedName && <PlanReader state={readerState} language={language} onClose={handleClose} onRetry={retryReader} />}
        {selectedName && <div className="plans-divider" aria-hidden="true" />}
        <PlansList
          armedDeleteName={armedDeleteName}
          revealTarget={revealTarget}
          selectedName={selectedName}
          state={listState}
          theaterId={theaterId}
          language={language}
          onArmDelete={armDelete}
          onDeleteSuccess={handleDeleteSuccess}
          onDisarmDelete={disarmDelete}
          onRetry={retryList}
          onRevealHandled={handleRevealHandled}
          onSelect={handleSelect}
          pulsedNames={pulsedNames}
        />
      </div>
    </div>
  );
}

function PlansList({
  armedDeleteName,
  revealTarget,
  selectedName,
  state,
  theaterId,
  language,
  onArmDelete,
  onDeleteSuccess,
  onDisarmDelete,
  onRetry,
  onRevealHandled,
  onSelect,
  pulsedNames,
}: PlansListProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<PlanStatusFilter>("all");
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const [deleteInFlightKeys, setDeleteInFlightKeys] = useState<ReadonlySet<string>>(() => new Set());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());
  const deleteInFlightRef = useRef<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    if (!revealTarget || state.kind === "loading") return;
    if (state.kind !== "ready") {
      onRevealHandled(revealTarget);
      return;
    }
    if (query !== "" || status !== "all") {
      setQuery("");
      setStatus("all");
      return;
    }
    rowRefs.current.get(revealTarget.name)?.scrollIntoView({ block: "nearest" });
    onRevealHandled(revealTarget);
  }, [onRevealHandled, query, revealTarget, state, status]);
  if (state.kind === "no-theater") {
    return <div className="plans-list-pane"><EmptyState>{t("rail.plans.selectTheater")}</EmptyState></div>;
  }

  if (state.kind === "loading") {
    return <div className="plans-list-pane"><div className="plans-loading">{t("rail.plans.loadingList")}</div></div>;
  }

  if (state.kind === "error") {
    return (
      <div className="plans-list-pane">
        <ErrorState message={t("rail.plans.loadListError")} onRetry={onRetry} />
      </div>
    );
  }

  if (state.plans.length === 0) {
    return (
      <div className="plans-list-pane">
        <EmptyState detail={t("rail.plans.emptyDetail")}>{t("rail.plans.empty")}</EmptyState>
      </div>
    );
  }

  const visiblePlans = filterPlans(state.plans, query, status);
  const moveFocus = (index: number, direction: -1 | 1) => {
    const nextIndex = (index + direction + visiblePlans.length) % visiblePlans.length;
    rowRefs.current.get(visiblePlans[nextIndex]?.name ?? "")?.focus();
  };
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number, name: string) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Delete") {
      event.preventDefault();
      if (theaterId && deleteInFlightRef.current.has(`${theaterId}\0${name}`)) return;
      onArmDelete(name);
      deleteRefs.current.get(name)?.focus();
    }
  };
  const deletePlanFile = (event: React.MouseEvent<HTMLButtonElement>, name: string) => {
    event.stopPropagation();
    const deleteKey = theaterId ? `${theaterId}\0${name}` : null;
    if (deleteKey && deleteInFlightRef.current.has(deleteKey)) return;
    if (armedDeleteName !== name) {
      onArmDelete(name);
      return;
    }
    onDisarmDelete();
    if (!theaterId || !deleteKey) return;
    const nextInFlight = new Set(deleteInFlightRef.current);
    nextInFlight.add(deleteKey);
    deleteInFlightRef.current = nextInFlight;
    setDeleteInFlightKeys(nextInFlight);
    void deletePlan(theaterId, name).then(() => {
      onDeleteSuccess(name);
    }).catch(() => {
      onDisarmDelete();
      onRetry();
    }).finally(() => {
      const remainingInFlight = new Set(deleteInFlightRef.current);
      remainingInFlight.delete(deleteKey);
      deleteInFlightRef.current = remainingInFlight;
      setDeleteInFlightKeys(remainingInFlight);
    });
  };
  const copyPlanPath = (event: React.MouseEvent<HTMLButtonElement>, name: string) => {
    event.stopPropagation();
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(`plans/${name}`).then(() => {
      setCopiedName(name);
      window.setTimeout(() => setCopiedName((current) => current === name ? null : current), 1_200);
    }).catch(() => undefined);
  };

  return (
    <div className="plans-list-pane">
      <div className="plans-toolbar">
        <label className="plans-search-label">
          <span>{t("rail.plans.search")}</span>
          <input className="plans-search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="plans-filter-group" aria-label={t("rail.plans.statusAria")}>
          {(["all", "in-progress", "complete"] as const).map((filter) => (
            <button key={filter} type="button" className={`plans-filter${status === filter ? " is-active" : ""}`} aria-pressed={status === filter} onClick={() => setStatus(filter)}>
              {filter === "all" ? t("rail.plans.filterAll") : filter === "in-progress" ? t("rail.plans.filterInProgress") : t("rail.plans.filterComplete")}
            </button>
          ))}
        </div>
        <button type="button" className="plans-refresh" onClick={onRetry}>{t("rail.plans.refresh")}</button>
      </div>
      <div className="plans-list" aria-label={t("rail.plans.listAria")}>
        {visiblePlans.length === 0 && <EmptyState>{t("rail.plans.noMatch")}</EmptyState>}
        {visiblePlans.map((plan, index) => {
          const progress = getProgressPercent(plan.tasksDone, plan.tasksTotal);
          const isComplete = progress === 100;
          const isDeleteInFlight = theaterId ? deleteInFlightKeys.has(`${theaterId}\0${plan.name}`) : false;
          return (
            <div
              key={plan.name}
              className={`plans-row${selectedName === plan.name ? " is-selected" : ""}${pulsedNames.has(plan.name) ? " is-pulsing" : ""}`}
              onPointerLeave={() => {
                if (armedDeleteName === plan.name) onDisarmDelete();
              }}
            >
              <button ref={(node) => { if (node) rowRefs.current.set(plan.name, node); else rowRefs.current.delete(plan.name); }} type="button" className="plans-row-select" onClick={() => onSelect(plan.name)} onKeyDown={(event) => handleRowKeyDown(event, index, plan.name)}>
                <span className="plans-row-name">{plan.name}</span>
                <span className="plans-row-meta">
                  {t("rail.plans.rowMeta", { waves: plan.waveCount, done: plan.tasksDone, total: plan.tasksTotal, relative: formatRelativeTime(plan.updatedAt, language) })}
                  {plan.executionMode === "parallel" ? t("rail.plans.rowMetaParallel") : ""}
                </span>
                {progress !== null && <span className="plans-progress-track" aria-label={t("rail.plans.progressAria", { progress })}><span className={`plans-progress-fill${isComplete ? " is-complete" : ""}`} style={{ width: `${progress}%` }} /></span>}
              </button>
              <button
                ref={(node) => { if (node) deleteRefs.current.set(plan.name, node); else deleteRefs.current.delete(plan.name); }}
                type="button"
                className={`plans-delete${armedDeleteName === plan.name ? " is-armed" : ""}`}
                onClick={(event) => deletePlanFile(event, plan.name)}
                disabled={isDeleteInFlight}
                style={isDeleteInFlight ? { cursor: "default" } : undefined}
                onBlur={() => {
                  if (armedDeleteName === plan.name) onDisarmDelete();
                }}
                aria-label={armedDeleteName === plan.name ? t("rail.plans.confirmDeleteAria", { name: plan.name }) : t("rail.plans.deleteAria", { name: plan.name })}
              >
                {armedDeleteName === plan.name
                  ? t("rail.plans.deleteArmed")
                  : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              </button>
              <button type="button" className="plans-copy" onClick={(event) => copyPlanPath(event, plan.name)} aria-label={copiedName === plan.name ? t("rail.plans.copiedAria", { name: plan.name }) : t("rail.plans.copyAria", { name: plan.name })}>
                {copiedName === plan.name ? t("rail.plans.copied") : t("rail.plans.copy")}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanReader({ state, language, onClose, onRetry }: PlanReaderProps) {
  const t = useT();
  if (state.kind === "loading") {
    return (
      <div className="plans-reader-pane">
        <div className="plans-reader-head">
          <span className="plans-reader-title">{t("rail.plans.readerTitle")}</span>
          <CloseButton onClose={onClose} />
        </div>
        <div className="plans-loading">{t("rail.plans.loadingPlan")}</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="plans-reader-pane">
        <div className="plans-reader-head">
          <span className="plans-reader-title">{t("rail.plans.readerTitle")}</span>
          <CloseButton onClose={onClose} />
        </div>
        <ErrorState message={t("rail.plans.loadPlanError")} onRetry={onRetry} />
      </div>
    );
  }

  return <PlanDocument plan={state.plan} language={language} onClose={onClose} />;
}

function PlanDocument({ plan, language, onClose }: PlanDocumentProps) {
  const t = useT();
  // plan 본문은 신뢰 불가 입력이다 — 렌더 HTML을 mount하기 전에 원격 이미지(추적 픽셀·IP 노출)와
  // 비-http 로컬 href(SPA hijack)를 무력화한다. 준거: file-explorer MarkdownViewer의 mount-전 처리.
  const html = useMemo(() => {
    const doc = new DOMParser().parseFromString(renderMarkdown(plan.content, markdownCopyOptions(t)).html, "text/html");
    neutralizePlanDom(doc.body, t);
    return doc.body.innerHTML;
  }, [plan.content, t]);
  const markdownRootRef = useRef<HTMLDivElement | null>(null);
  const headingFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const jumpToHeading = useCallback((level: "h2" | "h3", heading: string) => {
    const root = markdownRootRef.current;
    if (!root) return;
    const target = [...root.querySelectorAll(level)].find((element) => level === "h3"
      ? planLaneHeadingMatches(element.textContent ?? "", heading)
      : normalizePlanHeading(element.textContent ?? "") === normalizePlanHeading(heading));
    if (!target) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    target.classList.remove("plans-heading-flash");
    void target.getBoundingClientRect();
    target.classList.add("plans-heading-flash");
    if (headingFlashTimerRef.current) clearTimeout(headingFlashTimerRef.current);
    headingFlashTimerRef.current = setTimeout(() => target.classList.remove("plans-heading-flash"), 1_200);
  }, []);

  // 공유 렌더러가 코드 블록에 주입하는 Copy 버튼(data-action="copy-code")을 위임 처리한다 — 준거: file-explorer.
  const handleCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    const original = button.textContent;
    button.textContent = t("rail.plans.codeCopied");
    window.setTimeout(() => {
      button.textContent = original;
    }, 1200);
  }, [t]);

  // mermaid 블록은 하이드레이터가 비동기로 SVG를 삽입한다 — mount-전 중화만으로는 비동기 삽입분이
  // 누락되므로, 삽입/속성 변화를 관찰해 즉시 재중화한다. 준거: file-explorer MarkdownViewer.
  useEffect(() => {
    const root = markdownRootRef.current;
    if (!root) return;
    installDiagramHydrator(root, diagramHydratorLabels(t));
    neutralizePlanDom(root, t);
    const observer = new MutationObserver(() => neutralizePlanDom(root, t));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src", "srcset"] });
    return () => observer.disconnect();
  }, [html, t]);

  useEffect(() => () => {
    if (headingFlashTimerRef.current) clearTimeout(headingFlashTimerRef.current);
  }, []);

  return (
    <div className="plans-reader-pane">
      <div className="plans-reader-head">
        <div className="plans-reader-heading">
          <h2 className="plans-reader-title">{plan.title}</h2>
          <span className="plans-reader-meta">
            {plan.executionMode === "parallel" && <span className="plans-mode-badge">{t("rail.plans.parallelBadge")}</span>}
            {t("rail.plans.readerMeta", { waves: plan.waves.length, done: plan.tasksDone, total: plan.tasksTotal, relative: formatRelativeTime(plan.updatedAt, language) })}
          </span>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="plans-reader-body">
        <div className="plans-wave-strip" aria-label={t("rail.plans.waveProgressAria")}>
          {plan.waves.map((wave, waveIndex) => {
            const progressState = getWaveProgressState(wave.tasksDone, wave.tasksTotal);
            return (
              <div key={wave.index} className={`plans-wave is-${progressState}`}>
                <button type="button" className="plans-wave-heading" onClick={() => jumpToHeading("h2", wave.heading)}>{wave.heading}</button>
                {wave.tasksTotal > 0 && <span className="plans-wave-count">{wave.tasksDone}/{wave.tasksTotal}</span>}
                {wave.lanes.length > 0 && (
                  <div className="plans-lane-list">
                    {wave.lanes.map((lane, laneIndex) => {
                      const laneState = getLaneDispatchState(plan.waves, waveIndex, lane);
                      return (
                        <div key={lane.id ?? `${wave.index}-${laneIndex}`} className={`plans-lane is-${laneState}`}>
                          <button type="button" className="plans-lane-id" onClick={() => jumpToHeading("h3", lane.heading)}>{lane.id ?? lane.heading}</button>
                          {lane.tasksTotal > 0 && <span className="plans-lane-count">{lane.tasksDone}/{lane.tasksTotal}</span>}
                          {laneState === "ready" && <span className="plans-lane-ready">{t("rail.plans.laneReady")}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div
          ref={markdownRootRef}
          className="plans-markdown markdown-body"
          onClick={handleCopyClick}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

function CloseButton({ onClose }: CloseButtonProps) {
  const t = useT();
  return (
    <button className="plans-close" type="button" aria-label={t("rail.plans.closePlanAria")} onClick={onClose}>
      ✕
    </button>
  );
}

function EmptyState({ children, detail }: EmptyStateProps) {
  return (
    <div className="plans-empty">
      <span>{children}</span>
      {detail && <span className="plans-empty-detail">{detail}</span>}
    </div>
  );
}

function ErrorState({ message, onRetry }: ErrorStateProps) {
  const t = useT();
  return (
    <div className="plans-error-state">
      <span>{message}</span>
      <button className="plans-retry" type="button" onClick={onRetry}>{t("common.retry")}</button>
    </div>
  );
}

function neutralizePlanDom(root: ParentNode, t: Translate<CoreMessageKey>): void {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:|#)/i.test(href)) {
      anchor.removeAttribute("href");
      anchor.setAttribute("role", "link");
      anchor.setAttribute("aria-disabled", "true");
    }
  }
  // plans에는 미디어 서빙 라우트가 없다 — img뿐 아니라 video(poster)/audio 등 리소스-로딩 요소는
  // 상호작용 전에 메타데이터를 페치하므로, 로컬 복원 없이 전부 placeholder로 일관 차단한다.
  for (const element of root.querySelectorAll("img, video, audio, embed, object, iframe")) {
    const label = element.getAttribute("alt")?.trim() || element.getAttribute("title")?.trim();
    const placeholder = element.ownerDocument.createElement("span");
    placeholder.className = "plans-md-blocked-image";
    if (element.tagName === "IMG") {
      placeholder.textContent = label ? t("rail.plans.imageBlockedNamed", { label }) : t("rail.plans.imageBlocked");
    } else {
      placeholder.textContent = label ? t("rail.plans.mediaBlockedNamed", { label }) : t("rail.plans.mediaBlocked");
    }
    element.replaceWith(placeholder);
  }
  for (const element of root.querySelectorAll("source, track")) {
    element.removeAttribute("src");
    element.removeAttribute("srcset");
  }
  // 원시 SVG의 리소스 요소는 href/xlink:href로 mount 즉시 원격 페치를 유발한다 — 제거.
  // mermaid 산출 SVG(strict, htmlLabels: false)는 이 요소들을 쓰지 않으므로 다이어그램은 보존된다.
  for (const element of root.querySelectorAll("image, feImage")) {
    element.remove();
  }
  for (const element of root.querySelectorAll("use")) {
    const href = element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "";
    if (href !== "" && !href.startsWith("#")) element.remove();
  }
}

function PlansIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 6h10M9 12h10M9 18h10M4 6.5l1.5 1.5L8 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12.5l1.5 1.5L8 10.5M4 18.5l1.5 1.5L8 16.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
