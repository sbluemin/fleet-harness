import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

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

const TONE_ORDER: readonly string[] = ["teal", "amber", "plum", "moss", "cerulean", "rose", "indigo", "crimson"];
const EMPTY_HIDDEN_IDS: ReadonlySet<string> = new Set();

/**
 * 본문 위 세션 줄 — 캡션 바로 아래 frame 흐름 안에 26px 높이로 서는 가로 탭 줄.
 * WAI-ARIA APG 수동 활성화(Manual Activation) 방식:
 * 방향키(←/→/Home/End)는 탭 사이의 포커스(roving tabindex)만 이동하며, 본문은 바꾸지 않는다.
 * 클릭이나 Enter/Space 입력 시에만 활성화(onPick)되어 본문 전환 및 터미널 포커스가 일어난다.
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

  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(EMPTY_HIDDEN_IDS);
  const [moreOpen, setMoreOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string>(current);
  const naturalWidthsRef = useRef(new Map<string, number>());

  // current 변경 시 focusedId 도 동기화
  useEffect(() => {
    setFocusedId(current);
  }, [current]);

  const root = layout.cluster.root;
  // 구성원 세션 순서는 Objectives 명단(roster) 선언 순서를 따른다.
  const nodes = useMemo(() => {
    return layout.cluster.members
      .map((member, index) => ({ member, n: index + 1 }))
      .filter(({ member }) => layout.formation.byOperationId.has(member.operationId))
      .sort((a, b) => {
        if (a.member.order !== undefined && b.member.order !== undefined) {
          return a.member.order - b.member.order;
        }
        if (a.member.tone && b.member.tone) {
          return TONE_ORDER.indexOf(a.member.tone) - TONE_ORDER.indexOf(b.member.tone);
        }
        return a.n - b.n;
      });
  }, [layout.cluster.members, layout.formation.byOperationId]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const nodesKey = useMemo(
    () => nodes.map((n) => `${n.member.operationId}:${n.member.progress}:${n.member.name}:${n.member.order}`).join("|"),
    [nodes],
  );

  const nodeName = (node: { readonly member: { readonly name?: string }; readonly n: number }) =>
    node.member.name ?? t("cluster.nodes.node", { n: node.n });

  const applyHidden = (next: Set<string>) => {
    setHiddenIds((prev) => {
      if (prev.size === next.size && (prev.size === 0 || [...prev].every((id) => next.has(id)))) {
        return prev;
      }
      return next;
    });
  };

  // 폭 측정 및 +N 접힘 계산
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const measure = () => {
      const railWidth = rail.clientWidth;
      if (railWidth <= 0) return;
      const currentNodes = nodesRef.current;

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
      const baseWidth = commanderWidth + dividerWidth + padding;

      // 1단계: 모든 탭이 +N 버튼 없이 전부 들어가는지 먼저 확인
      let totalNeeded = baseWidth;
      for (const node of currentNodes) {
        const w = naturalWidthsRef.current.get(node.member.operationId) || 72;
        totalNeeded += w + 2;
      }

      if (totalNeeded <= railWidth) {
        applyHidden(EMPTY_HIDDEN_IDS as Set<string>);
        return;
      }

      // 2단계: 다 들어가지 않는 경우 — +N 버튼 공간(44px)을 확보하고 넘치는 탭 가리기.
      // 우선순위:
      // 1) 지휘관 (baseWidth 에 포함)
      // 2) 허용 요청(awaiting) 탭 (반드시 포함)
      // 3) 현재 선택된 탭(current) (반드시 포함)
      // 4) 현재 포커스된 탭(focusedId) (가능하면 포함)
      const moreWidth = 44;
      const hidden = new Set<string>();

      let reservedForPriority = 0;
      for (const node of currentNodes) {
        const isPriority = node.member.progress === "awaiting" || node.member.operationId === current;
        if (isPriority) {
          const w = naturalWidthsRef.current.get(node.member.operationId) || 72;
          reservedForPriority += w + 2;
        }
      }

      if (baseWidth + reservedForPriority + moreWidth > railWidth) {
        // 필수 유지 탭마저도 가용 폭을 넘는 극단적인 경우: 허용 요청 탭부터 들어가는 만큼만 남기고,
        // 남은 자리에 나머지를 순서대로 채운다. 넘긴 허용 요청은 +N 버튼의 has-awaiting 표시가 대신 알린다.
        const avail = railWidth - baseWidth - moreWidth;
        let acc = 0;
        const awaitingFirst = [
          ...currentNodes.filter((node) => node.member.progress === "awaiting"),
          ...currentNodes.filter((node) => node.member.progress !== "awaiting"),
        ];
        for (const node of awaitingFirst) {
          const w = naturalWidthsRef.current.get(node.member.operationId) || 72;
          if (acc + w > avail) {
            hidden.add(node.member.operationId);
          } else {
            acc += w + 2;
          }
        }
      } else {
        // 일반적인 경우: awaiting 과 current 는 무조건 남기고, 나머지 비우선순위 탭만 뒤에서부터 넘긴다
        const availableForRest = railWidth - baseWidth - reservedForPriority - moreWidth;
        let acc = 0;
        for (const node of currentNodes) {
          const isPriority = node.member.progress === "awaiting" || node.member.operationId === current;
          if (isPriority) continue;
          const w = naturalWidthsRef.current.get(node.member.operationId) || 72;
          if (acc + w > availableForRest) {
            hidden.add(node.member.operationId);
          } else {
            acc += w + 2;
          }
        }
      }

      applyHidden(hidden);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [nodesKey, current]);

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

  // W3C ARIA Tablist 수동 활성화: 방향키는 탭 간 포커스만 이동, Enter/Space 는 본문 전환
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([hidden])') ?? []);
      const currentIndex = tabs.indexOf(event.currentTarget as HTMLButtonElement);
      if (currentIndex >= 0) {
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
        const nextTab = tabs[nextIndex];
        if (nextTab) {
          nextTab.focus();
          const nextId = nextTab.dataset.memberOpId ?? root;
          setFocusedId(nextId);
        }
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([hidden])') ?? []);
      const firstTab = tabs[0];
      if (firstTab) {
        firstTab.focus();
        setFocusedId(root);
      }
    } else if (event.key === "End") {
      event.preventDefault();
      const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([hidden])') ?? []);
      const lastTab = tabs[tabs.length - 1];
      if (lastTab) {
        lastTab.focus();
        const lastId = lastTab.dataset.memberOpId ?? root;
        setFocusedId(lastId);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const targetOpId = (event.currentTarget as HTMLElement).dataset.memberOpId ?? root;
      setFocusedId(targetOpId);
      onPick(targetOpId);
    }
  };

  const hiddenNodes = nodes.filter(({ member }) => hiddenIds.has(member.operationId));
  const hiddenCount = hiddenNodes.length;
  const moreHasAwaiting = hiddenNodes.some(({ member }) => member.progress === "awaiting");
  const moreHasCurrent = hiddenNodes.some(({ member }) => member.operationId === current);

  // Roving tabindex: 포커스된 탭이 가시 영역에 있으면 그 탭이 tabIndex=0, 없으면 current(가시 시) 또는 root 가 0
  const visibleOpIds = [root, ...nodes.filter((n) => !hiddenIds.has(n.member.operationId)).map((n) => n.member.operationId)];
  const activeFocusId = visibleOpIds.includes(focusedId) ? focusedId : (visibleOpIds.includes(current) ? current : root);

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
        tabIndex={activeFocusId === root ? 0 : -1}
        title={chefTip}
        aria-label={current === root ? chefTip + showingSuffix : chefTip}
        onClick={() => {
          setFocusedId(root);
          onPick(root);
        }}
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
            tabIndex={activeFocusId === member.operationId ? 0 : -1}
            title={tip}
            aria-label={on ? tip + showingSuffix : tip}
            data-member-op-id={member.operationId}
            onClick={() => {
              setFocusedId(member.operationId);
              onPick(member.operationId);
            }}
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
            className={`cluster-node-more${moreHasAwaiting ? " has-awaiting" : ""}${moreHasCurrent ? " is-current" : ""}`}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-selected={moreHasCurrent ? "true" : undefined}
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
                      setFocusedId(member.operationId);
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
