import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { renderMarkdown } from "@fleet-console/markdown/core";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "@fleet-console/markdown/styles.css";
import "./plans.css";
import { formatRelativeTime, getProgressPercent, getWaveProgressState } from "./helpers.js";

interface PlanListItem {
  readonly name: string;
  readonly title: string;
  readonly waveCount: number;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly updatedAt: string;
  readonly sizeBytes: number;
}

interface PlanWave {
  readonly index: number;
  readonly heading: string;
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

interface PlanReadResult {
  readonly name: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly content: string;
  readonly waves: readonly PlanWave[];
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

interface PlansListResult {
  readonly plans: readonly PlanListItem[];
}

interface PlansListProps {
  readonly selectedName: string | null;
  readonly state: PlansListState;
  readonly onRetry: () => void;
  readonly onSelect: (name: string) => void;
}

interface PlanReaderProps {
  readonly state: PlanReaderState;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}

interface PlanDocumentProps {
  readonly plan: PlanReadResult;
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

export const plansPanel: RailPanelDescriptor = {
  id: "plans",
  title: "Plans",
  icon: PlansIcon,
  render: (ctx) => <PlansPanel {...ctx} />,
};

function PlansPanel(ctx: RailPanelContext) {
  const { api, requestExtraWidth, theaterId } = ctx;
  const [listState, setListState] = useState<PlansListState>({ kind: "no-theater" });
  const [readerState, setReaderState] = useState<PlanReaderState>({ kind: "loading" });
  const [selectedPlan, setSelectedPlan] = useState<{ readonly theaterId: string; readonly name: string } | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [readerRetry, setReaderRetry] = useState(0);
  const selectedName = selectedPlan?.theaterId === theaterId ? selectedPlan.name : null;

  useEffect(() => {
    let cancelled = false;
    setSelectedPlan(null);
    setReaderState({ kind: "loading" });

    if (!theaterId) {
      setListState({ kind: "no-theater" });
      return () => { cancelled = true; };
    }

    setListState({ kind: "loading" });
    void api.fetch("plans", "list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId }),
    }).then(async (response) => {
      const result = await response.json() as PlansListResult;
      if (!cancelled) setListState({ kind: "ready", plans: result.plans });
    }).catch(() => {
      if (!cancelled) setListState({ kind: "error" });
    });

    return () => { cancelled = true; };
  }, [api, theaterId, listRetry]);

  useEffect(() => {
    let cancelled = false;

    if (!theaterId || !selectedName) return () => { cancelled = true; };

    setReaderState({ kind: "loading" });
    void api.fetch("plans", "read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, name: selectedName }),
    }).then(async (response) => {
      const result = await response.json() as PlanReadResult;
      if (!cancelled) setReaderState({ kind: "ready", plan: result });
    }).catch(() => {
      if (!cancelled) setReaderState({ kind: "error" });
    });

    return () => { cancelled = true; };
  }, [api, readerRetry, selectedName, theaterId]);

  useLayoutEffect(() => {
    requestExtraWidth?.(selectedName ? PLANS_EXTRA_WIDTH : null);
  }, [requestExtraWidth, selectedName]);

  const handleSelect = useCallback((name: string) => {
    if (theaterId) setSelectedPlan({ theaterId, name });
  }, [theaterId]);
  const handleClose = useCallback(() => setSelectedPlan(null), []);
  const retryList = useCallback(() => setListRetry((attempt) => attempt + 1), []);
  const retryReader = useCallback(() => setReaderRetry((attempt) => attempt + 1), []);

  return (
    <div className="plans-panel-shell">
      <div className={`plans-root${selectedName ? " is-reader-open" : ""}`}>
        {selectedName && <PlanReader state={readerState} onClose={handleClose} onRetry={retryReader} />}
        {selectedName && <div className="plans-divider" aria-hidden="true" />}
        <PlansList
          selectedName={selectedName}
          state={listState}
          onRetry={retryList}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}

function PlansList({ selectedName, state, onRetry, onSelect }: PlansListProps) {
  if (state.kind === "no-theater") {
    return <div className="plans-list-pane"><EmptyState>Select a Theater to browse plans.</EmptyState></div>;
  }

  if (state.kind === "loading") {
    return <div className="plans-list-pane"><div className="plans-loading">Loading plans…</div></div>;
  }

  if (state.kind === "error") {
    return (
      <div className="plans-list-pane">
        <ErrorState message="Unable to load plans." onRetry={onRetry} />
      </div>
    );
  }

  if (state.plans.length === 0) {
    return (
      <div className="plans-list-pane">
        <EmptyState detail="Execution plans in .fleet/plans/ appear here.">No plans yet.</EmptyState>
      </div>
    );
  }

  return (
    <div className="plans-list-pane">
      <div className="plans-list" aria-label="Plans">
        {state.plans.map((plan) => {
          const progress = getProgressPercent(plan.tasksDone, plan.tasksTotal);
          const isComplete = progress === 100;
          return (
            <button
              key={plan.name}
              type="button"
              className={`plans-row${selectedName === plan.name ? " is-selected" : ""}`}
              onClick={() => onSelect(plan.name)}
            >
              <span className="plans-row-name">{plan.name}</span>
              <span className="plans-row-meta">
                {plan.waveCount} waves · {plan.tasksDone}/{plan.tasksTotal} tasks · {formatRelativeTime(plan.updatedAt)}
              </span>
              {progress !== null && (
                <span className="plans-progress-track" aria-label={`${progress}% complete`}>
                  <span
                    className={`plans-progress-fill${isComplete ? " is-complete" : ""}`}
                    style={{ width: `${progress}%` }}
                  />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PlanReader({ state, onClose, onRetry }: PlanReaderProps) {
  if (state.kind === "loading") {
    return (
      <div className="plans-reader-pane">
        <div className="plans-reader-head">
          <span className="plans-reader-title">Plan</span>
          <CloseButton onClose={onClose} />
        </div>
        <div className="plans-loading">Loading plan…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="plans-reader-pane">
        <div className="plans-reader-head">
          <span className="plans-reader-title">Plan</span>
          <CloseButton onClose={onClose} />
        </div>
        <ErrorState message="Unable to load plan." onRetry={onRetry} />
      </div>
    );
  }

  return <PlanDocument plan={state.plan} onClose={onClose} />;
}

function PlanDocument({ plan, onClose }: PlanDocumentProps) {
  const html = useMemo(() => renderMarkdown(plan.content).html, [plan.content]);

  return (
    <div className="plans-reader-pane">
      <div className="plans-reader-head">
        <div className="plans-reader-heading">
          <h2 className="plans-reader-title">{plan.title}</h2>
          <span className="plans-reader-meta">
            {plan.waves.length} waves · {plan.tasksDone}/{plan.tasksTotal} tasks · updated {formatRelativeTime(plan.updatedAt)}
          </span>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="plans-reader-body">
        <div className="plans-wave-strip" aria-label="Wave progress">
          {plan.waves.map((wave) => {
            const progressState = getWaveProgressState(wave.tasksDone, wave.tasksTotal);
            return (
              <span key={wave.index} className={`plans-wave is-${progressState}`}>
                <span className="plans-wave-heading">{wave.heading}</span>
                {wave.tasksTotal > 0 && <span className="plans-wave-count">{wave.tasksDone}/{wave.tasksTotal}</span>}
              </span>
            );
          })}
        </div>
        <div
          className="plans-markdown markdown-body"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

function CloseButton({ onClose }: CloseButtonProps) {
  return (
    <button className="plans-close" type="button" aria-label="Close plan" onClick={onClose}>
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
  return (
    <div className="plans-error-state">
      <span>{message}</span>
      <button className="plans-retry" type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

function PlansIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 6h10M9 12h10M9 18h10M4 6.5l1.5 1.5L8 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12.5l1.5 1.5L8 10.5M4 18.5l1.5 1.5L8 16.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
