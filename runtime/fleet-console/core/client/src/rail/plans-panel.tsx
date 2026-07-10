import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "@fleet-console/markdown/styles.css";
import { fetchPlanRead, fetchPlansList, type PlanListItem, type PlanReadResult } from "../api.js";
import "./plans.css";
import { formatRelativeTime, getLaneDispatchState, getProgressPercent, getWaveProgressState } from "./plans-helpers.js";

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
  const { requestExtraWidth, theaterId } = ctx;
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
    void fetchPlansList(theaterId).then((result) => {
      if (!cancelled) setListState({ kind: "ready", plans: result.plans });
    }).catch(() => {
      if (!cancelled) setListState({ kind: "error" });
    });

    return () => { cancelled = true; };
  }, [theaterId, listRetry]);

  useEffect(() => {
    let cancelled = false;

    if (!theaterId || !selectedName) return () => { cancelled = true; };

    setReaderState({ kind: "loading" });
    void fetchPlanRead(theaterId, selectedName).then((result) => {
      if (!cancelled) setReaderState({ kind: "ready", plan: result });
    }).catch(() => {
      if (!cancelled) setReaderState({ kind: "error" });
    });

    return () => { cancelled = true; };
  }, [readerRetry, selectedName, theaterId]);

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
                {plan.executionMode === "parallel" ? " · parallel" : ""}
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
  // plan 본문은 신뢰 불가 입력이다 — 렌더 HTML을 mount하기 전에 원격 이미지(추적 픽셀·IP 노출)와
  // 비-http 로컬 href(SPA hijack)를 무력화한다. 준거: file-explorer MarkdownViewer의 mount-전 처리.
  const html = useMemo(() => {
    const doc = new DOMParser().parseFromString(renderMarkdown(plan.content).html, "text/html");
    neutralizePlanDom(doc.body);
    return doc.body.innerHTML;
  }, [plan.content]);
  const markdownRootRef = useRef<HTMLDivElement | null>(null);

  // 공유 렌더러가 코드 블록에 주입하는 Copy 버튼(data-action="copy-code")을 위임 처리한다 — 준거: file-explorer.
  const handleCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = original;
    }, 1200);
  }, []);

  // mermaid 블록은 하이드레이터가 비동기로 SVG를 삽입한다 — mount-전 중화만으로는 비동기 삽입분이
  // 누락되므로, 삽입/속성 변화를 관찰해 즉시 재중화한다. 준거: file-explorer MarkdownViewer.
  useEffect(() => {
    const root = markdownRootRef.current;
    if (!root) return;
    installDiagramHydrator(root);
    neutralizePlanDom(root);
    const observer = new MutationObserver(() => neutralizePlanDom(root));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src", "srcset"] });
    return () => observer.disconnect();
  }, [html]);

  return (
    <div className="plans-reader-pane">
      <div className="plans-reader-head">
        <div className="plans-reader-heading">
          <h2 className="plans-reader-title">{plan.title}</h2>
          <span className="plans-reader-meta">
            {plan.executionMode === "parallel" && <span className="plans-mode-badge">PARALLEL</span>}
            {plan.waves.length} waves · {plan.tasksDone}/{plan.tasksTotal} tasks · updated {formatRelativeTime(plan.updatedAt)}
          </span>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="plans-reader-body">
        <div className="plans-wave-strip" aria-label="Wave progress">
          {plan.waves.map((wave, waveIndex) => {
            const progressState = getWaveProgressState(wave.tasksDone, wave.tasksTotal);
            return (
              <span key={wave.index} className={`plans-wave is-${progressState}`}>
                <span className="plans-wave-heading">{wave.heading}</span>
                {wave.tasksTotal > 0 && <span className="plans-wave-count">{wave.tasksDone}/{wave.tasksTotal}</span>}
                {wave.lanes.length > 0 && (
                  <span className="plans-lane-list">
                    {wave.lanes.map((lane, laneIndex) => {
                      const laneState = getLaneDispatchState(plan.waves, waveIndex, lane);
                      return (
                        <span key={lane.id ?? `${wave.index}-${laneIndex}`} className={`plans-lane is-${laneState}`}>
                          <span className="plans-lane-id">{lane.id ?? lane.heading}</span>
                          {lane.tasksTotal > 0 && <span className="plans-lane-count">{lane.tasksDone}/{lane.tasksTotal}</span>}
                          {laneState === "ready" && <span className="plans-lane-ready">READY</span>}
                        </span>
                      );
                    })}
                  </span>
                )}
              </span>
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

function neutralizePlanDom(root: ParentNode): void {
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
    const noun = element.tagName === "IMG" ? "Image" : "Media";
    const placeholder = element.ownerDocument.createElement("span");
    placeholder.className = "plans-md-blocked-image";
    placeholder.textContent = label ? `${noun} blocked: ${label}` : `${noun} blocked`;
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
