import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { OperationClusterProgress } from "@fleet-console/sdk/plugin";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLayout } from "./operation-clusters.js";

type RootActivity = "idle" | "running" | "awaiting" | "background" | "ended" | null;

const CoordGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="4" r="2" />
    <circle cx="4" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <path d="M7 5.7L5 10.3M9 5.7l2 4.6" />
  </svg>
);

const ChevDown = () => (
  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
    <path d="M2 3.5l3 3 3-3" />
  </svg>
);

/**
 * 본문 위 세션 줄 — 캡션 바로 아래 frame 흐름 안에 26px 높이로 서는 가로 탭 줄.
 * 지휘관 + 살아 있는 구성원 세션으로 이루어지며, 누르면 패널 본문(selectNestedBody)을 전환한다.
 * 지금 보고 있는 탭은 brass 워시와 테두리 전체로 표시된다(왼쪽 강조 띠 금지).
 * 폭이 좁으면 뒤쪽 탭을 「+N」 메뉴로 넘기되, 허용 요청(awaiting)이 있는 구성원은 넘기지 않고 앞에 남긴다.
 */
export function ClusterNodeRail({ layout, current, rootActivity, onPick }: {
  readonly layout: ClusterLayout;
  /** 지금 지휘관 패널이 보이는 세션 — 지휘관 자신이면 뿌리 id. */
  readonly current: string;
  readonly rootActivity: RootActivity;
  readonly onPick: (operationId: string) => void;
}) {
  const t = useT();
  const railRef = useRef<HTMLDivElement | null>(null);
  const commanderTabRef = useRef<HTMLButtonElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const naturalWidthsRef = useRef(new Map<string, number>());

  const root = layout.cluster.root;
  const nodes = layout.cluster.members
    .map((member, index) => ({ member, n: index + 1 }))
    .filter(({ member }) => layout.formation.byOperationId.has(member.operationId));

  const nodeName = (node: { readonly member: { readonly name?: string }; readonly n: number }) =>
    node.member.name ?? t("cluster.nodes.node", { n: node.n });

  // 폭 측정 및 +N 접힘 계산
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const measure = () => {
      const railWidth = rail.clientWidth;
      if (railWidth <= 0) return;

      const tabEls = Array.from(rail.querySelectorAll<HTMLElement>("[data-member-op-id]"));
      for (const el of tabEls) {
        const opId = el.dataset.memberOpId;
        if (opId && el.offsetWidth > 0) {
          naturalWidthsRef.current.set(opId, el.offsetWidth);
        }
      }

      const commanderWidth = commanderTabRef.current?.offsetWidth || 76;
      const dividerWidth = 7;
      const padding = 16;
      const moreWidth = 44;
      const used = commanderWidth + dividerWidth + padding;

      const hidden = new Set<string>();

      // 허용 요청 탭의 너비를 먼저 확보
      let reservedForAwaiting = 0;
      for (const node of nodes) {
        if (node.member.progress === "awaiting") {
          const w = naturalWidthsRef.current.get(node.member.operationId) || 72;
          reservedForAwaiting += w + 2;
        }
      }

      const availableForRest = railWidth - used - reservedForAwaiting - moreWidth;
      let accumulated = 0;

      for (const node of nodes) {
        const opId = node.member.operationId;
        if (node.member.progress === "awaiting") {
          // 허용 요청은 넘기지 않고 앞에 남긴다
          continue;
        }
        const w = naturalWidthsRef.current.get(opId) || 72;
        if (accumulated + w > availableForRest) {
          hidden.add(opId);
        } else {
          accumulated += w + 2;
        }
      }

      setHiddenIds((prev) => {
        if (prev.size === hidden.size && [...prev].every((id) => hidden.has(id))) return prev;
        return hidden;
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [nodes]);

  // 바깥 클릭 / Escape 로 +N 팝오버 닫기
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!menuRef.current?.contains(target) && !moreBtnRef.current?.contains(target)) {
        setMoreOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [moreOpen]);

  if (nodes.length === 0) return null;

  const chefLabel = t("cluster.picker.coordinator");
  const currentNode = nodes.find(({ member }) => member.operationId === current);
  const currentLabel = currentNode ? nodeName(currentNode) : chefLabel;

  const stateWord = (progress: OperationClusterProgress): string | null => {
    if (progress === "done") return t("cluster.nodes.state.done");
    if (progress === "running") return t("cluster.picker.state.running");
    if (progress === "awaiting") return t("cluster.picker.state.awaiting");
    if (progress === "open") return t("cluster.picker.state.open");
    return null;
  };

  const chefTip = rootActivity ? `${chefLabel} · ${t(`cluster.picker.activity.${rootActivity}`)}` : chefLabel;
  const showingSuffix = ` · ${t("cluster.nodes.current")}`;

  const stop = (event: ReactPointerEvent) => event.stopPropagation();

  // W3C ARIA Tablist 화살표 키(←/→, Home, End) 내비게이션
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([hidden])') ?? []);
      const currentIndex = tabs.indexOf(event.currentTarget as HTMLButtonElement);
      if (currentIndex >= 0) {
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
        tabs[nextIndex]?.focus();
        tabs[nextIndex]?.click();
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([hidden])') ?? []);
      tabs[0]?.focus();
      tabs[0]?.click();
    } else if (event.key === "End") {
      event.preventDefault();
      const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([hidden])') ?? []);
      tabs[tabs.length - 1]?.focus();
      tabs[tabs.length - 1]?.click();
    }
  };

  const hiddenNodes = nodes.filter(({ member }) => hiddenIds.has(member.operationId));
  const hiddenCount = hiddenNodes.length;
  const moreHasAwaiting = hiddenNodes.some(({ member }) => member.progress === "awaiting");

  return (
    <div
      ref={railRef}
      className="cluster-node-rail"
      role="tablist"
      aria-label={t("cluster.nodes.aria", { current: currentLabel })}
      onPointerDown={stop}
      data-canvas-blocker
    >
      <button
        ref={commanderTabRef}
        type="button"
        role="tab"
        className={`cluster-node-tab${current === root ? " is-current" : ""}`}
        aria-selected={current === root}
        tabIndex={current === root ? 0 : -1}
        title={chefTip}
        aria-label={current === root ? chefTip + showingSuffix : chefTip}
        onClick={() => onPick(root)}
        onKeyDown={onKeyDown}
      >
        <span className="cluster-member-glyph is-commander" aria-hidden="true">
          <CoordGlyph />
          <i className={`cluster-member-status is-${rootActivity ?? "unknown"}`} />
        </span>
        <span>{chefLabel}</span>
      </button>
      <span className="cluster-node-div" aria-hidden="true" />
      {nodes.map((node) => {
        const { member } = node;
        const on = member.operationId === current;
        const isHidden = hiddenIds.has(member.operationId);
        const word = stateWord(member.progress);
        const name = nodeName(node);
        const tip = word ? `${member.label} · ${word}` : member.label;
        const firstChar = Array.from(name)[0] ?? "?";
        return (
          <button
            key={member.operationId}
            type="button"
            role="tab"
            hidden={isHidden}
            className={`cluster-node-tab${on ? " is-current" : ""}`}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={tip}
            aria-label={on ? tip + showingSuffix : tip}
            data-member-op-id={member.operationId}
            onClick={() => onPick(member.operationId)}
            onKeyDown={onKeyDown}
          >
            <span className={`cluster-member-glyph is-tone-${member.tone ?? "teal"}`} aria-hidden="true">
              {firstChar}
              <i className={`cluster-member-status is-${member.progress}`} />
            </span>
            <span>{name}</span>
          </button>
        );
      })}
      {hiddenCount > 0 ? (
        <>
          <button
            ref={moreBtnRef}
            type="button"
            className={`cluster-node-more${moreHasAwaiting ? " has-awaiting" : ""}`}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label={t("cluster.nodes.more", { count: hiddenCount })}
            title={t("cluster.nodes.more", { count: hiddenCount })}
            onClick={() => setMoreOpen((prev) => !prev)}
          >
            <span>+{hiddenCount}</span>
            <ChevDown />
          </button>
          {moreOpen ? (
            <div ref={menuRef} className="cluster-node-overflow-menu" role="menu">
              {hiddenNodes.map((node) => {
                const { member } = node;
                const on = member.operationId === current;
                const word = stateWord(member.progress);
                const name = nodeName(node);
                const firstChar = Array.from(name)[0] ?? "?";
                return (
                  <button
                    key={member.operationId}
                    type="button"
                    role="menuitem"
                    className={`cluster-node-overflow-item${on ? " is-current" : ""}`}
                    onClick={() => {
                      setMoreOpen(false);
                      onPick(member.operationId);
                    }}
                  >
                    <span className={`cluster-member-glyph is-tone-${member.tone ?? "teal"}`} aria-hidden="true">
                      {firstChar}
                      <i className={`cluster-member-status is-${member.progress}`} />
                    </span>
                    <span className="cluster-node-overflow-name">{name}</span>
                    {word ? <span className={`cluster-node-overflow-state is-${member.progress}`}>{word}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
