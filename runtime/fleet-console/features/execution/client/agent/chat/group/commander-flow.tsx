import type { ConsoleLocale } from "@fleet-console/i18n";
import * as React from "react";
import { ChevronGlyph, useChromeHeightProperty } from "@fleet-console/ui/react";

import { getT as getCoreT } from "../../../../../../core/client/src/i18n/index.js";
import { useAvatarAccent } from "../../../../../workspace/client/avatar-accent.js";
import { useConversationDockHeight } from "../../../../../workspace/client/conversation/conversation-dock-height.js";
import { objectiveRecordAvatarKey } from "../../../../../workspace/shared/avatars.js";
import { conversationActivityPhrase, useObjectiveMongleActivities } from "../../../avatar-activity.js";
import { getT } from "../../i18n/index.js";
import { StreamedMarkdown } from "../../streamed-markdown.js";
import { ChatDispatchAttachments } from "../chat-dispatch-attachments.js";
import { useCodeBlockCopy } from "../code-block-copy.js";
import type { ConversationSpeaker, GroupTimelineSnapshot } from "../../../../shared/conversation/types.js";
import {
  buildCommanderFlow,
  type FlowEdge,
  type FlowErrorItem,
  type FlowLoop,
  type FlowNode,
} from "./commander-flow-model.js";
import { getGroupT } from "./group-chat-i18n.js";
import { SpeakerMark, SpeakerName, speakerKey } from "./speaker-mark.js";
import "@fleet-console/markdown/styles.css";
import "../chat.css";
import "./group-chat.css";
import "./commander-flow.css";

/**
 * 지휘관 Inner Loop Flow 표면 — 데스크톱은 n8n 워크플로우 캔버스(시안 D), 모바일은 수직 Quiet Thread(시안 A)로 적응한다.
 *
 * - 1:1 사령관 대화(`AgentConversation`)는 기존 `GroupConversation` 을 그대로 쓰고, 목표의 지휘관·구성원 Inner Loop 만
 *   이 플로우 표면으로 보여준다.
 * - 어떤 노드나 오류 카드를 눌러도 기존 읽기 전용 원장(`onOpenLedger`) 또는 인라인 세부 검사로 직결된다.
 * - 모든 오류(`session-error`·전달 실패·실패/미보고 `plugin-notice`·CLI 차단)는 절대 접지 않고 즉시 드러낸다.
 */
export interface CommanderFlowConversationProps {
  readonly snapshot: GroupTimelineSnapshot;
  readonly language: ConsoleLocale | undefined;
  readonly variant: "canvas" | "thread";
  readonly awaitingCheckpoint?: boolean;
  readonly onOpenLedger?: (objectiveId: string) => void;
  readonly onOpenSplitLedger?: () => void;
  readonly cards?: React.ReactNode;
  readonly composer?: React.ReactNode;
  readonly overlay?: React.ReactNode;
  readonly onOpenUISend?: (reply: string, speaker: ConversationSpeaker) => void;
  readonly onOpenUIDraft?: (draft: string, speaker: ConversationSpeaker) => void;
}

interface InspectedItem {
  readonly loopId: string;
  readonly title: string;
  readonly body: string;
  readonly ledgerObjectiveId: string | null;
  readonly ledgerName?: string;
}

const USER_SCROLL_MS = 250;

export function CommanderFlowConversation({
  snapshot,
  language,
  variant,
  awaitingCheckpoint = false,
  onOpenLedger,
  cards,
  composer,
  overlay,
  onOpenUISend,
  onOpenUIDraft,
}: CommanderFlowConversationProps) {
  const t = getGroupT(language);
  const coreT = getCoreT(language ?? "en");
  const { onClick: onCodeCopyClick, announcement: codeCopyAnnouncement } = useCodeBlockCopy(getT(language));
  const commanderId = snapshot.rootObjectiveId
    ?? snapshot.participants.find(({ speaker }) => speaker.kind === "commander" || speaker.kind === "objectiveRecord")?.speaker.objectiveId
    ?? null;
  const accent = useAvatarAccent(commanderId ? objectiveRecordAvatarKey(commanderId) : null);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const dockRef = React.useRef<HTMLDivElement | null>(null);
  useChromeHeightProperty(dockRef, rootRef, "--m-dock-h");
  useConversationDockHeight(dockRef);

  // 바닥 자동 따라가기 — 사용자가 위로 스크롤하면 따라가기를 풀고 바닥 60px 안으로 돌아오면 다시 켠다.
  const nearBottomRef = React.useRef(true);
  const userScrollAt = React.useRef(-Infinity);
  const markUserScroll = React.useCallback(() => { userScrollAt.current = performance.now(); }, []);

  React.useEffect(() => {
    const log = logRef.current;
    const column = log?.firstElementChild;
    if (!log || !column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (log.closest("[inert]") || log.clientHeight === 0) return;
      if (nearBottomRef.current) log.scrollTop = log.scrollHeight;
    });
    observer.observe(column);
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  // 실시간 작업 중인 참여자들의 활동 문구("파일 읽는 중", "명령 실행 중" 등)를 구독한다.
  const objectiveParticipantIds = React.useMemo(
    () => snapshot.participants.map((p) => (p.speaker.kind !== "commodore" && p.speaker.kind !== "human" ? (p.speaker.objectiveId ?? null) : null)),
    [snapshot.participants],
  );
  const rawActivities = useObjectiveMongleActivities(objectiveParticipantIds);
  const activityPhrases = React.useMemo(() => {
    const map = new Map<string, string>();
    objectiveParticipantIds.forEach((id, index) => {
      const activity = rawActivities[index];
      if (id && activity) map.set(id, conversationActivityPhrase(coreT, activity));
    });
    return map;
  }, [objectiveParticipantIds, rawActivities, coreT]);

  const model = React.useMemo(
    () => buildCommanderFlow(snapshot, { language, awaitingCheckpoint, activityPhrases }),
    [snapshot, language, awaitingCheckpoint, activityPhrases],
  );

  const [toggledLoops, setToggledLoops] = React.useState<Readonly<Record<string, boolean>>>({});
  const [inspected, setInspected] = React.useState<InspectedItem | null>(null);

  // 다른 Objective 로 전환하면 펼침·검사 상태를 비운다.
  React.useEffect(() => {
    setToggledLoops({});
    setInspected(null);
  }, [snapshot.rootObjectiveId]);

  const toggleLoop = React.useCallback((loopId: string, currentlyOpen: boolean) => {
    setToggledLoops((current) => ({ ...current, [loopId]: !currentlyOpen }));
  }, []);

  const unavailableNames = snapshot.unavailableObjectiveIds
    .map((id) => snapshot.participants.find((p) => p.speaker.objectiveId === id)?.speaker.name)
    .filter((name): name is string => typeof name === "string");

  const handleNodeClick = React.useCallback((loopId: string, node: FlowNode) => {
    // 원장이 있고, 별도 세부 텍스트 검사보다 원장 직결이 자연스러운 구성원/지휘관 노드라면 바로 원장을 연다.
    // 단, 오류/단절/자문/트리거 노드는 인라인 검사를 먼저 띄우고 원장 버튼으로 직결할 수 있게 한다.
    const hasDetail = Boolean(node.detailBody && node.detailBody.trim().length > 0);
    if (node.ledgerObjectiveId && onOpenLedger && node.role === "branch" && node.status !== "error" && node.status !== "warn") {
      onOpenLedger(node.ledgerObjectiveId);
      return;
    }
    if (hasDetail) {
      setInspected((current) => (
        current?.loopId === loopId && current.title === (node.detailTitle ?? node.title)
          ? null
          : {
              loopId,
              title: node.detailTitle ?? node.title,
              body: node.detailBody!,
              ledgerObjectiveId: node.ledgerObjectiveId,
              ...(node.speaker ? { ledgerName: node.speaker.name } : {}),
            }
      ));
      return;
    }
    if (node.ledgerObjectiveId && onOpenLedger) {
      onOpenLedger(node.ledgerObjectiveId);
    }
  }, [onOpenLedger]);

  const handleEdgeClick = React.useCallback((loopId: string, edge: FlowEdge) => {
    if (edge.detailBody && edge.detailBody.trim().length > 0) {
      setInspected((current) => (
        current?.loopId === loopId && current.title === (edge.detailTitle ?? edge.label)
          ? null
          : {
              loopId,
              title: edge.detailTitle ?? edge.label,
              body: edge.detailBody!,
              ledgerObjectiveId: edge.ledgerObjectiveId ?? null,
            }
      ));
      return;
    }
    if (edge.ledgerObjectiveId && onOpenLedger) {
      onOpenLedger(edge.ledgerObjectiveId);
    }
  }, [onOpenLedger]);

  return (
    <div ref={rootRef} className="group-chat commander-flow" style={accent} onClick={onCodeCopyClick}>
      <span className="agent-chat-sr-only" aria-live="polite" aria-atomic="true">{codeCopyAnnouncement}</span>
      <div
        ref={logRef}
        className="commander-flow-log"
        role="log"
        aria-label={t("group.flow.aria")}
        aria-busy={snapshot.loading}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        onScroll={(event) => {
          const log = event.currentTarget;
          if (log.closest("[inert]") || log.clientHeight === 0) return;
          const byUser = performance.now() - userScrollAt.current < USER_SCROLL_MS;
          if (!byUser && nearBottomRef.current) return;
          nearBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
        }}
      >
        <div className="commander-flow-column">
          {snapshot.truncated ? <p className="commander-flow-notice">{t("group.truncated")}</p> : null}
          {snapshot.unavailableObjectiveIds.length > 0 ? (
            <p className="commander-flow-notice">
              {unavailableNames.length > 0 ? t("group.unavailable", { names: unavailableNames.join(", ") }) : t("group.unavailableOne")}
            </p>
          ) : null}

          {model.loops.length === 0 && model.pendingPrompts.length === 0 ? (
            <p className="commander-flow-empty">{snapshot.loading ? t("group.loading") : t("group.flow.empty")}</p>
          ) : model.loops.map((loop, index) => {
            const isLast = index === model.loops.length - 1;
            const forcedOpen = loop.status === "live" || loop.hasErrors || loop.status === "await";
            const defaultOpen = forcedOpen || isLast;
            const isOpen = forcedOpen ? true : (toggledLoops[loop.id] ?? defaultOpen);
            const activeInspector = inspected?.loopId === loop.id ? inspected : null;

            return (
              <FlowLoopSection
                key={loop.id}
                loop={loop}
                variant={variant}
                isOpen={isOpen}
                canCollapse={!forcedOpen}
                language={language}
                inspector={activeInspector}
                onToggle={() => toggleLoop(loop.id, isOpen)}
                onNodeClick={(node) => handleNodeClick(loop.id, node)}
                onEdgeClick={(edge) => handleEdgeClick(loop.id, edge)}
                onCloseInspector={() => setInspected(null)}
                onOpenLedger={onOpenLedger}
                onOpenUISend={onOpenUISend}
                onOpenUIDraft={onOpenUIDraft}
              />
            );
          })}

          {model.pendingPrompts.length > 0 ? (
            <div className="commander-flow-pending-list" role="status">
              {model.pendingPrompts.map((entry) => (
                <div key={entry.id} className="commander-flow-pending" data-entry-id={entry.id}>
                  <span className="commander-flow-human-mark" aria-hidden="true">
                    {Array.from(t("group.you"))[0] ?? "Y"}
                  </span>
                  <span className="commander-flow-pending-text">{entry.text}</span>
                  <span className="commander-flow-ribbon-meta">{t("group.pending")}</span>
                </div>
              ))}
            </div>
          ) : null}

          {cards}
        </div>
      </div>

      <div ref={dockRef} className="group-chat-dock">
        {composer ? <div className="group-chat-dock-composer">{composer}</div> : null}
      </div>
      {overlay}
    </div>
  );
}

function FlowLoopSection({
  loop,
  variant,
  isOpen,
  canCollapse,
  language,
  inspector,
  onToggle,
  onNodeClick,
  onEdgeClick,
  onCloseInspector,
  onOpenLedger,
  onOpenUISend,
  onOpenUIDraft,
}: {
  readonly loop: FlowLoop;
  readonly variant: "canvas" | "thread";
  readonly isOpen: boolean;
  readonly canCollapse: boolean;
  readonly language: ConsoleLocale | undefined;
  readonly inspector: InspectedItem | null;
  readonly onToggle: () => void;
  readonly onNodeClick: (node: FlowNode) => void;
  readonly onEdgeClick: (edge: FlowEdge) => void;
  readonly onCloseInspector: () => void;
  readonly onOpenLedger?: (objectiveId: string) => void;
  readonly onOpenUISend?: (reply: string, speaker: ConversationSpeaker) => void;
  readonly onOpenUIDraft?: (draft: string, speaker: ConversationSpeaker) => void;
}) {
  const t = getGroupT(language);

  return (
    <article className="commander-flow-loop" data-flow-loop={loop.id} data-flow-status={loop.status}>
      {variant === "canvas" ? (
        isOpen ? (
          <div className="commander-flow-shell">
            <div className="commander-flow-head">
              <div className="commander-flow-head-left">
                <span className={`commander-flow-status-dot is-${loop.status}`} aria-hidden="true" />
                <span className="commander-flow-head-prompt" title={loop.prompt}>{loop.prompt}</span>
              </div>
              <div className="commander-flow-head-right">
                {loop.durationLabel ? (
                  <span className={`commander-flow-head-dur is-${loop.status}`}>{loop.durationLabel}</span>
                ) : null}
                {canCollapse ? (
                  <button type="button" className="commander-flow-collapse-btn" onClick={onToggle}>
                    <span>{t("group.flow.collapse")}</span>
                    <ChevronGlyph direction="up" />
                  </button>
                ) : null}
              </div>
            </div>

            <N8nFlowBoard
              loop={loop}
              language={language}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
            />

            {inspector ? (
              <div className="commander-flow-inspector" role="region" aria-label={inspector.title}>
                <div className="commander-flow-inspector-head">
                  <span className="commander-flow-inspector-title">{inspector.title}</span>
                  <div className="commander-flow-inspector-actions">
                    {inspector.ledgerObjectiveId && onOpenLedger ? (
                      <button
                        type="button"
                        className="commander-flow-action-btn"
                        onClick={() => onOpenLedger(inspector.ledgerObjectiveId!)}
                      >
                        {t("group.flow.error.openLedger", { name: inspector.ledgerName ?? inspector.title })}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="commander-flow-collapse-btn"
                      onClick={onCloseInspector}
                      aria-label={t("group.flow.inspectorClose")}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="commander-flow-inspector-body">{inspector.body}</div>
              </div>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className="commander-flow-ribbon"
            aria-expanded={false}
            onClick={onToggle}
          >
            <span className="commander-flow-ribbon-check" aria-hidden="true">✓</span>
            <span className="commander-flow-ribbon-prompt">{loop.prompt}</span>
            <span className="commander-flow-ribbon-chain" aria-hidden="true">
              {loop.miniActors.slice(0, 4).map((actor, idx) => (
                <React.Fragment key={speakerKey(actor)}>
                  {idx > 0 ? <span className="commander-flow-mini-sep">→</span> : null}
                  <span className="commander-flow-mini-chip">
                    <SpeakerMark speaker={actor} size="sm" />
                    <span>{actor.name}</span>
                  </span>
                </React.Fragment>
              ))}
            </span>
            {loop.durationLabel ? <span className="commander-flow-ribbon-meta">{loop.durationLabel}</span> : null}
            <span className="commander-flow-ribbon-toggle">
              <span>{t("group.flow.expand")}</span>
              <ChevronGlyph direction="down" />
            </span>
          </button>
        )
      ) : (
        <QuietThreadLoop
          loop={loop}
          isOpen={isOpen}
          language={language}
          onToggle={onToggle}
          onOpenLedger={onOpenLedger}
        />
      )}

      {loop.triggerMessage?.attachments?.length ? (
        <div className="commander-flow-outcome">
          <ChatDispatchAttachments attachments={loop.triggerMessage.attachments} language={language ?? "en"} />
        </div>
      ) : null}

      {loop.errors.length > 0 ? (
        <div className="commander-flow-errors">
          {loop.errors.map((err) => (
            <FlowErrorCard key={err.id} error={err} language={language} onOpenLedger={onOpenLedger} />
          ))}
        </div>
      ) : null}

      {loop.outcome ? (
        <FlowOutcomeBlock
          entry={loop.outcome}
          language={language}
          onOpenLedger={onOpenLedger}
          onOpenUISend={onOpenUISend}
          onOpenUIDraft={onOpenUIDraft}
        />
      ) : null}
    </article>
  );
}

function N8nFlowBoard({
  loop,
  language,
  onNodeClick,
  onEdgeClick,
}: {
  readonly loop: FlowLoop;
  readonly language: ConsoleLocale | undefined;
  readonly onNodeClick: (node: FlowNode) => void;
  readonly onEdgeClick: (edge: FlowEdge) => void;
}) {
  const t = getGroupT(language);
  const incoming = React.useMemo(() => new Set(loop.edges.map((edge) => edge.to)), [loop.edges]);
  const outgoing = React.useMemo(() => new Set(loop.edges.map((edge) => edge.from)), [loop.edges]);

  return (
    <div className="commander-flow-board-scroll">
      <div className="commander-flow-board" style={{ width: `${loop.width}px`, height: `${loop.height}px` }}>
        <svg className="commander-flow-svg" viewBox={`0 0 ${loop.width} ${loop.height}`} aria-hidden="true">
          {loop.edges.map((edge) => (
            <React.Fragment key={edge.id}>
              <path d={edge.path} className={`commander-flow-wire is-${edge.status}`} />
              {edge.status === "live" ? (
                <>
                  <path d={edge.path} className="commander-flow-wire-flow" />
                  <circle r="3.2" className="commander-flow-packet">
                    <animateMotion dur="1.7s" repeatCount="indefinite" path={edge.path} />
                  </circle>
                </>
              ) : null}
              {edge.status === "await" ? (
                <circle r="2.8" className="commander-flow-packet is-await">
                  <animateMotion dur="2.4s" repeatCount="indefinite" path={edge.path} />
                </circle>
              ) : null}
            </React.Fragment>
          ))}
        </svg>

        {loop.nodes.map((node) => {
          const isLive = node.status === "live";
          return (
            <button
              key={node.id}
              type="button"
              className={`commander-flow-node is-${node.status}`}
              style={{
                left: `${node.x}px`,
                top: `${node.y}px`,
                width: `${node.w}px`,
                height: `${node.h}px`,
              }}
              data-flow-node={node.role}
              data-flow-node-status={node.status}
              onClick={() => onNodeClick(node)}
            >
              {incoming.has(node.id) ? <span className={`commander-flow-port is-in is-${node.status}`} aria-hidden="true" /> : null}
              {outgoing.has(node.id) ? <span className={`commander-flow-port is-out is-${node.status}`} aria-hidden="true" /> : null}
              <div className="commander-flow-node-head">
                <span className="commander-flow-node-who">
                  {node.speaker && node.speaker.kind !== "human" ? (
                    <SpeakerMark speaker={node.speaker} size="sm" state={isLive ? "running" : "idle"} acting={isLive} />
                  ) : (
                    <span className="commander-flow-human-mark" aria-hidden="true">
                      {Array.from(t("group.you"))[0] ?? "Y"}
                    </span>
                  )}
                  {node.speaker && node.speaker.kind !== "human" && (node.role === "commander" || node.role === "branch") && node.status !== "error" && node.status !== "warn" && node.status !== "await" ? (
                    <SpeakerName speaker={node.speaker} className="commander-flow-node-title" avatarTone />
                  ) : (
                    <span className="commander-flow-node-title">{node.title}</span>
                  )}
                </span>
                {node.meta ? <span className="commander-flow-node-meta">{node.meta}</span> : null}
              </div>
              <div className={`commander-flow-node-sub${isLive ? " agent-chat-live-text" : ""}`}>{node.subtitle}</div>
            </button>
          );
        })}

        {loop.edges.map((edge) => (
          edge.label ? (
            <button
              key={`${edge.id}:badge`}
              type="button"
              className={`commander-flow-wire-badge is-${edge.status}`}
              style={{ left: `${edge.midX}px`, top: `${edge.midY}px` }}
              onClick={() => onEdgeClick(edge)}
            >
              {edge.label}
            </button>
          ) : null
        ))}
      </div>
    </div>
  );
}

function QuietThreadLoop({
  loop,
  isOpen,
  language,
  onToggle,
  onOpenLedger,
}: {
  readonly loop: FlowLoop;
  readonly isOpen: boolean;
  readonly language: ConsoleLocale | undefined;
  readonly onToggle: () => void;
  readonly onOpenLedger?: (objectiveId: string) => void;
}) {
  const t = getGroupT(language);
  const actorNames = loop.miniActors.map((actor) => actor.name).join(" · ");

  return (
    <>
      <div className="commander-flow-thread-anchor">
        <span className="commander-flow-thread-prompt">{loop.triggerMessage?.text || loop.prompt}</span>
        {loop.durationLabel ? <span className="commander-flow-ribbon-meta">{loop.durationLabel}</span> : null}
      </div>

      {loop.steps.length > 0 ? (
        <div className="commander-flow-thread-block">
          <div className="commander-flow-thread-rail" aria-hidden="true">
            <span className={`commander-flow-thread-dot is-${loop.status}`} />
            <span className="commander-flow-thread-spine" />
          </div>
          <div className="commander-flow-thread-body">
            <button type="button" className="commander-flow-thread-toggle" aria-expanded={isOpen} onClick={onToggle}>
              <span className={loop.status === "live" ? "agent-chat-live-text" : undefined}>
                {t("group.flow.stepCount", { count: loop.steps.length })}
                {actorNames ? ` · ${actorNames}` : ""}
              </span>
              <ChevronGlyph direction={isOpen ? "up" : "down"} />
            </button>

            {isOpen ? (
              <div className="commander-flow-thread-steps">
                {loop.steps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`commander-flow-thread-step is-${step.status}`}
                    onClick={() => { if (step.ledgerObjectiveId && onOpenLedger) onOpenLedger(step.ledgerObjectiveId); }}
                  >
                    <SpeakerMark speaker={step.actor} size="sm" state={step.status === "live" ? "running" : "idle"} />
                    <SpeakerName speaker={step.actor} avatarTone />
                    {step.target ? (
                      <>
                        <span className="commander-flow-mini-sep" aria-hidden="true">→</span>
                        <SpeakerName speaker={step.target} avatarTone />
                      </>
                    ) : null}
                    <span className="commander-flow-thread-step-text">{step.summary}</span>
                    {step.meta ? <span className="commander-flow-ribbon-meta">{step.meta}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function FlowErrorCard({
  error,
  language,
  onOpenLedger,
}: {
  readonly error: FlowErrorItem;
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger?: (objectiveId: string) => void;
}) {
  const t = getGroupT(language);
  const isWarn = error.severity === "warn";
  const timeText = error.at !== null
    ? new Date(error.at).toLocaleTimeString(language === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "";

  return (
    <div className={`commander-flow-alert${isWarn ? " is-warn" : ""}`} role="alert" data-flow-error={error.code}>
      <div className="commander-flow-alert-head">
        <span className="commander-flow-alert-title">
          <span aria-hidden="true">{isWarn ? "▲" : "●"}</span>
          <span>{error.title}</span>
        </span>
        <span className="commander-flow-alert-code">
          {error.code}{timeText ? ` · ${timeText}` : ""}
        </span>
      </div>
      <div className="commander-flow-alert-detail">{error.detail}</div>
      {error.ledgerObjectiveId && onOpenLedger ? (
        <div className="commander-flow-alert-actions">
          <button
            type="button"
            className={`commander-flow-action-btn${isWarn ? "" : " is-coral"}`}
            onClick={() => onOpenLedger(error.ledgerObjectiveId!)}
          >
            {t("group.flow.error.openLedger", { name: error.speaker?.name ?? t("group.commander") })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FlowOutcomeBlock({
  entry,
  language,
  onOpenLedger,
  onOpenUISend,
  onOpenUIDraft,
}: {
  readonly entry: Extract<GroupTimelineSnapshot["entries"][number], { kind: "message" }>;
  readonly language: ConsoleLocale | undefined;
  readonly onOpenLedger?: (objectiveId: string) => void;
  readonly onOpenUISend?: (reply: string, speaker: ConversationSpeaker) => void;
  readonly onOpenUIDraft?: (draft: string, speaker: ConversationSpeaker) => void;
}) {
  const t = getGroupT(language);
  const speaker = entry.speaker;
  const openui = speaker.kind === "commander" || speaker.kind === "commodore";
  const reply = React.useMemo(() => (onOpenUISend ? (text: string) => onOpenUISend(text, speaker) : undefined), [onOpenUISend, speaker]);
  const draft = React.useMemo(() => (onOpenUIDraft ? (text: string) => onOpenUIDraft(text, speaker) : undefined), [onOpenUIDraft, speaker]);

  return (
    <div className="commander-flow-outcome" data-entry-id={entry.id}>
      <div className="commander-flow-outcome-head">
        <SpeakerMark speaker={speaker} size="sm" state={entry.streaming ? "running" : "idle"} />
        {speaker.objectiveId && onOpenLedger ? (
          <button
            type="button"
            className="group-chat-speaker-hit is-name"
            onClick={() => onOpenLedger(speaker.objectiveId!)}
          >
            <SpeakerName speaker={speaker} avatarTone />
          </button>
        ) : (
          <SpeakerName speaker={speaker} avatarTone />
        )}
        <span className="commander-flow-outcome-tag">· {t("group.flow.outcome")}</span>
      </div>
      <div className="commander-flow-outcome-body">
        {entry.attachments?.length ? <ChatDispatchAttachments attachments={entry.attachments} language={language ?? "en"} /> : null}
        {entry.text.trim().length === 0
          ? (entry.streaming ? <span className="agent-chat-live-text">{t("group.streaming")}</span> : null)
          : (
            <StreamedMarkdown
              text={entry.text}
              streaming={entry.streaming}
              preserveStreamingDom
              className="agent-chat-answer-body markdown-body group-chat-md"
              language={language}
              siteLinks
              openui={openui}
              {...(openui && reply ? { onOpenUISend: reply } : {})}
              {...(openui && draft ? { onOpenUIDraft: draft } : {})}
            />
          )}
      </div>
    </div>
  );
}
