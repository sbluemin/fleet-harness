import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { OperationClusterProgress } from "@fleet-console/sdk/plugin";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLayout } from "./operation-clusters.js";

type RootActivity = "idle" | "running" | "awaiting" | "background" | "ended" | null;

/**
 * 노드 줄 — 지휘관 패널 본문의 오른쪽 위에 세로로 쌓인 세션 버튼. 맨 위가 지휘관, 그 아래 Operation 이 떠 있는 단계마다
 * 버튼 하나 — 구성원이 준 이름(`name`)이 있으면 그 이름, 없으면 「N 노드」(N = 묶음 안의 단계 번호). 제목은 말풍선·낭독에만. 누르면 지휘관 패널의 본문만 그 세션으로 바뀌고
 * 세션은 뒤에서 계속 돈다. 지금 보고 있는 버튼은 비활성화된 brass 워시로 서서 현재 자리를 말한다.
 *
 * 평소엔 흐리게 있다가 패널에 올리거나 포커스가 들어오면 선명해진다. 지휘관이 아닌 세션을 보는 동안과 결정을 기다리는
 * 노드가 있는 동안도 선명하다. 패널 본문에 타이핑하는 동안은 비켜 선다 — 포인터가 움직이면 돌아온다.
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
  const [typing, setTyping] = useState(false);
  const root = layout.cluster.root;
  // 번호는 편성(선언) 순서의 자리 — 자리표시 단계도 번호를 차지하므로 지휘관이 직접 하는 단계가 끼어도 번호가 밀리지 않는다.
  const nodes = layout.cluster.members
    .map((member, index) => ({ member, n: index + 1 }))
    .filter(({ member }) => layout.formation.byOperationId.has(member.operationId));

  useEffect(() => {
    const host = railRef.current?.closest(".canvas-operation");
    if (!host) return;
    const onKey = (event: Event) => { if (!railRef.current?.contains(event.target as Node)) setTyping(true); };
    const onMove = () => setTyping(false);
    host.addEventListener("keydown", onKey, true);
    host.addEventListener("pointermove", onMove);
    return () => { host.removeEventListener("keydown", onKey, true); host.removeEventListener("pointermove", onMove); };
  }, []);

  if (nodes.length === 0) return null;
  const stateWord = (progress: OperationClusterProgress): string | null => {
    if (progress === "done") return t("cluster.nodes.state.done");
    if (progress === "running") return t("cluster.picker.state.running");
    if (progress === "awaiting") return t("cluster.picker.state.awaiting");
    if (progress === "open") return t("cluster.picker.state.open");
    return null;
  };
  const chefLabel = t("cluster.picker.coordinator");
  const currentNode = nodes.find(({ member }) => member.operationId === current);
  const nodeName = (node: { readonly member: { readonly name?: string }; readonly n: number }) => node.member.name ?? t("cluster.nodes.node", { n: node.n });
  const currentLabel = currentNode ? nodeName(currentNode) : chefLabel;
  const awaiting = nodes.some(({ member }) => member.progress === "awaiting");
  const className = [
    "cluster-node-rail",
    current !== root ? "is-away" : "",
    awaiting ? "has-await" : "",
    typing ? "is-typing" : "",
  ].filter(Boolean).join(" ");
  const stop = (event: ReactPointerEvent) => event.stopPropagation();
  const chefTip = rootActivity ? `${chefLabel} · ${t(`cluster.picker.activity.${rootActivity}`)}` : chefLabel;
  const showingSuffix = ` · ${t("cluster.nodes.current")}`;
  return (
    <div
      ref={railRef}
      className={className}
      role="group"
      aria-label={t("cluster.nodes.aria", { current: currentLabel })}
      onPointerDown={stop}
      data-canvas-blocker
    >
      <button
        type="button"
        className="cluster-node"
        disabled={current === root}
        aria-current={current === root ? "true" : undefined}
        title={chefTip}
        aria-label={current === root ? chefTip + showingSuffix : chefTip}
        onClick={() => onPick(root)}
      >
        <i className={`cluster-node-dot is-${rootActivity ?? "unknown"}`} aria-hidden="true" />
        {chefLabel}
      </button>
      <span className="cluster-node-sep" aria-hidden="true" />
      {nodes.map((node) => {
        const { member } = node;
        const on = member.operationId === current;
        const word = stateWord(member.progress);
        const tip = word ? `${member.label} · ${word}` : member.label;
        return (
          <button
            key={member.operationId}
            type="button"
            className="cluster-node"
            disabled={on}
            aria-current={on ? "true" : undefined}
            title={tip}
            aria-label={on ? tip + showingSuffix : tip}
            onClick={() => onPick(member.operationId)}
          >
            <i className={`cluster-node-dot is-${member.progress}`} aria-hidden="true" />
            {nodeName(node)}
          </button>
        );
      })}
    </div>
  );
}
