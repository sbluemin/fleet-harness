import { renderMarkdown } from "@fleet-console/markdown/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorSpec, WorldChatFeedEntry } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { playCompanionCall, playDistrictSelect, playMongleChirp } from "../engine/world-audio.js";
import { formatDialogueAria, getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  addCompanionActorId,
  closeActorInteraction,
  openActorPanel,
  pushActorSpeech,
  removeCompanionActorId,
  useWorldStore,
} from "../world-store.js";
import { WorldIcon } from "./world-icons.js";

const STATE_LABEL_KEY: Record<WorldActorSpec["state"], TheWorldMessageKey> = {
  idle: "theWorld.state.idle",
  fresh: "theWorld.state.fresh",
  unseen: "theWorld.state.unseen",
  running: "theWorld.state.running",
  awaiting: "theWorld.state.awaiting",
  decision: "theWorld.state.decision",
  review: "theWorld.state.review",
  done: "theWorld.state.done",
  ended: "theWorld.state.ended",
  error: "theWorld.state.error",
};

const QUICK_PROMPT_KEYS: Record<WorldActorSpec["role"], readonly TheWorldMessageKey[]> = {
  commodore: ["theWorld.rpg.promptCommodore1", "theWorld.rpg.promptCommodore2"],
  commander: ["theWorld.rpg.promptCommander1", "theWorld.rpg.promptCommander2"],
  member: ["theWorld.rpg.promptMember1", "theWorld.rpg.promptMember2"],
};

const MAX_MARKDOWN_CACHE = 256;
const markdownHtmlCache = new Map<string, string>();

function renderCachedMarkdownHtml(text: string): string {
  const cached = markdownHtmlCache.get(text);
  if (cached !== undefined) return cached;
  const html = renderMarkdown(text).html;
  if (markdownHtmlCache.size >= MAX_MARKDOWN_CACHE) {
    const oldestKey = markdownHtmlCache.keys().next().value;
    if (oldestKey !== undefined) markdownHtmlCache.delete(oldestKey);
  }
  markdownHtmlCache.set(text, html);
  return html;
}

function isNpcSpeechEntry(entry: WorldChatFeedEntry): boolean {
  return entry.kind === "speech" || entry.kind === "ask" || entry.kind === "peer";
}

function isDialogueTurnEntry(entry: WorldChatFeedEntry): boolean {
  return isNpcSpeechEntry(entry) || entry.kind === "player";
}

function actorVoiceSeed(actorId: string): number {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) {
    hash = ((hash << 5) - hash + actorId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 97;
}

/**
 * 더 월드 하단 중앙 시네마틱 RPG 2샷 대화 바.
 *
 * 시스템 로그·도구 줄을 덜어내고 가장 최근 NPC 대사 1턴만 따뜻한 게임 대화창 감각으로 보여주며,
 * 필요할 때 우측 사령관 작전 수첩 드로어의 실제 콘솔 채팅(`전체 채팅 ↗`)으로 즉시 확장한다.
 */
export const WorldDialogueBox = memo(function WorldDialogueBox({
  actor,
  deps,
  onStatusBanner,
}: {
  readonly actor: WorldActorSpec;
  readonly deps: TheWorldClientDeps;
  readonly onStatusBanner: (msg: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly tone: "ok" | "error"; readonly text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const speechScrollRef = useRef<HTMLDivElement | null>(null);
  const lastSpokenKeyRef = useRef<string | null>(null);
  const store = useWorldStore();
  const t = getWorldT(deps.commodore.language());
  const isCompanion = store.companionActorIds.includes(actor.id);

  const conversation = deps.useActorConversation(actor);
  const voiceSeed = useMemo(() => actorVoiceSeed(actor.id), [actor.id]);

  useEffect(() => {
    setFeedback(null);
    lastSpokenKeyRef.current = null;
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  }, [actor.id]);

  const { latestNpc, recentPlayerQuote, historyCount, hasErrorEntry } = useMemo(() => {
    let lastNpc: WorldChatFeedEntry | null = null;
    let lastNpcIdx = -1;
    let lastPlayer: WorldChatFeedEntry | null = null;
    let lastPlayerIdx = -1;
    let turnCount = 0;

    for (let i = 0; i < conversation.entries.length; i += 1) {
      const entry = conversation.entries[i]!;
      if (isDialogueTurnEntry(entry)) turnCount += 1;
      if (isNpcSpeechEntry(entry)) {
        lastNpc = entry;
        lastNpcIdx = i;
      } else if (entry.kind === "player") {
        lastPlayer = entry;
        lastPlayerIdx = i;
      }
    }

    // 방금 플레이어가 질문해 응답 대기 중이거나, 직전 플레이어 질문에 대한 답변일 때만 1줄 인용 노출
    const showPlayerQuote = lastPlayer !== null && (
      lastNpcIdx === -1
      || lastPlayerIdx > lastNpcIdx
      || lastNpcIdx - lastPlayerIdx <= 2
    );

    const lastEntry = conversation.entries.at(-1);
    const hasErr = lastEntry?.kind === "system-error" || actor.state === "error";

    return {
      latestNpc: lastNpc,
      recentPlayerQuote: showPlayerQuote ? lastPlayer : null,
      historyCount: turnCount,
      hasErrorEntry: hasErr,
    };
  }, [actor.state, conversation.entries]);

  const latestNpcHtml = useMemo(
    () => (latestNpc ? renderCachedMarkdownHtml(latestNpc.text) : null),
    [latestNpc],
  );

  // 대화 바 오픈 또는 새 NPC 발화 도착 시 부드러운 몽글 보이스 치프 재생
  const activeSpeechKey = latestNpc?.id ?? `greeting:${actor.id}`;
  useEffect(() => {
    if (conversation.loading && !latestNpc) return;
    if (lastSpokenKeyRef.current === activeSpeechKey) return;
    lastSpokenKeyRef.current = activeSpeechKey;
    playMongleChirp(voiceSeed);
  }, [activeSpeechKey, conversation.loading, latestNpc, voiceSeed]);

  // 스트리밍 중 최신 대사 끝부분이 자연스럽게 보이도록 하단 유지
  useEffect(() => {
    if (!latestNpc?.streaming) return;
    const el = speechScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [latestNpc?.text, latestNpc?.streaming]);

  const handleSend = async (explicitText?: string) => {
    const trimmed = (explicitText ?? draft).trim();
    if (!trimmed || sending) return;
    setSending(true);
    setFeedback(null);
    try {
      const result = actor.role === "commodore" && actor.commodoreId
        ? await deps.sendMessageToCommodore(actor.commodoreId, trimmed)
        : actor.objectiveId
          ? await deps.sendMessageToObjective(actor.objectiveId, trimmed)
          : { ok: false, error: "no_target" };

      if (result.ok) {
        pushActorSpeech(actor.id, t("theWorld.chat.receivedSpeech", { text: trimmed.slice(0, 24) }));
        onStatusBanner(t("theWorld.rpg.sentToast", { name: actor.name }));
        setDraft("");
      } else {
        const reason = result.error === "mention_target_gone"
          ? t("theWorld.rpg.boardNotReady")
          : t("theWorld.rpg.sendFailed", { error: result.error ?? "unknown" });
        setFeedback({ tone: "error", text: reason });
        onStatusBanner(t("theWorld.rpg.sendFailedBanner", { name: actor.name, reason }));
      }
    } finally {
      setSending(false);
    }
  };

  const runControl = (work?: () => Promise<void>, label?: string) => {
    if (!work || actionBusy) return;
    setActionBusy(true);
    setFeedback(null);
    void work()
      .then(() => {
        if (label) onStatusBanner(label);
      })
      .catch((err) => {
        setFeedback({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => setActionBusy(false));
  };

  const isAttention = actor.needsAttention || conversation.openAsksCount > 0;
  const statusKind = hasErrorEntry
    ? "error"
    : isAttention
      ? "attention"
      : conversation.working
        ? "working"
        : "idle";
  const statusText = conversation.working
    ? (conversation.stepLabel ?? t(STATE_LABEL_KEY.running))
    : t(STATE_LABEL_KEY[actor.state]);
  const objectiveTargetId = actor.rootObjectiveId ?? actor.objectiveId;
  const hasOpenAsks = actor.role === "commodore" && Boolean(actor.commodoreId) && conversation.openAsksCount > 0;
  const showQuickChips = !conversation.working && !hasOpenAsks && draft.trim().length === 0;
  const showHistoryLink = historyCount >= 2 || conversation.hasOlder;

  return (
    <section
      className="the-world-rpg-dialogue"
      data-tone={actor.tone}
      data-has-asks={hasOpenAsks ? "true" : undefined}
      role="dialog"
      aria-label={formatDialogueAria(deps.commodore.language(), actor.name)}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* 좌상단 카드 경계에 살짝 걸쳐 떠 있는 RPG 화자 이름표 리본 */}
      <div className="the-world-rpg-ribbon" data-tone={actor.tone}>
        <div className="the-world-rpg-avatar">
          <MongleAvatar
            base={actor.baseId}
            tone={actor.tone}
            role={actor.role}
            state={conversation.working ? "running" : actor.state}
            activity={actor.activity}
            size={36}
            label={actor.name}
            decorative
          />
        </div>
        <span className="the-world-rpg-speaker-name">{actor.name}</span>
        <span className={`the-world-rpg-status is-${statusKind}`}>
          <span className="the-world-rpg-status-dot" aria-hidden="true" />
          <span>{statusText}</span>
        </span>
      </div>

      {/* 상단 우측 퀵 확장 & 수첩 이동 바 */}
      <div className="the-world-rpg-topbar">
        <div className="the-world-rpg-actions">
          <button
            type="button"
            className="the-world-rpg-action-btn is-primary"
            aria-label={t("theWorld.rpg.fullChatAria", { name: actor.name })}
            onClick={() => openActorPanel(actor.id, "chat", actor.role === "commodore" ? null : objectiveTargetId)}
          >
            <WorldIcon name="chat" size={13} tone="amber" />
            <span>{t("theWorld.rpg.fullChat")} ↗</span>
          </button>

          {actor.role === "commodore" && actor.commodoreId ? (
            <>
              <button
                type="button"
                className={`the-world-rpg-action-btn${isCompanion ? " is-primary" : ""}`}
                aria-pressed={isCompanion}
                onClick={() => {
                  if (isCompanion) {
                    removeCompanionActorId(actor.id);
                    playDistrictSelect();
                    onStatusBanner(t("theWorld.companion.leftToast", { name: actor.name }));
                  } else {
                    addCompanionActorId(actor.id);
                    playCompanionCall();
                    onStatusBanner(t("theWorld.companion.joinedToast", { name: actor.name }));
                  }
                }}
              >
                <WorldIcon name={isCompanion ? "close" : "approach"} size={13} tone={isCompanion ? "amber" : "teal"} />
                <span>{isCompanion ? t("theWorld.companion.endWalk") : t("theWorld.companion.walkTogether")}</span>
              </button>
              <button
                type="button"
                className="the-world-rpg-action-btn"
                onClick={() => openActorPanel(actor.id, "goals")}
              >
                <WorldIcon name="questMap" size={13} tone="moss" />
                <span>{t("theWorld.rpg.goals")}</span>
              </button>
              <button
                type="button"
                className="the-world-rpg-action-btn"
                onClick={() => openActorPanel(actor.id, "info")}
              >
                <WorldIcon name="inspect" size={13} tone="cerulean" />
                <span>{t("theWorld.rpg.profile")}</span>
              </button>
              <button
                type="button"
                className="the-world-rpg-action-btn"
                onClick={() => openActorPanel(actor.id, "settings")}
              >
                <WorldIcon name="settings" size={13} tone="indigo" />
                <span>{t("theWorld.rpg.settings")}</span>
              </button>
            </>
          ) : actor.commodoreId && objectiveTargetId ? (
            <>
              <button
                type="button"
                className="the-world-rpg-action-btn"
                onClick={() => openActorPanel(actor.id, "goals", objectiveTargetId)}
              >
                <WorldIcon name="questMap" size={13} tone="moss" />
                <span>{t("theWorld.rpg.goals")}</span>
              </button>
              <button
                type="button"
                className="the-world-rpg-action-btn"
                onClick={() => openActorPanel(actor.id, "info", objectiveTargetId)}
              >
                <WorldIcon name="crew" size={13} tone="cerulean" />
                <span>{t("theWorld.rpg.crew")}</span>
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="the-world-rpg-action-btn is-icon-only"
            aria-label={t("theWorld.dialogue.closeAria")}
            onClick={closeActorInteraction}
          >
            <WorldIcon name="close" size={13} />
          </button>
        </div>
      </div>

      {/* 단일 턴 RPG 대사 무대 */}
      <div className="the-world-rpg-stage">
        {recentPlayerQuote ? (
          <div className="the-world-rpg-player-quote">
            <span className="the-world-rpg-player-label">{t("theWorld.rpg.youPrefix")}:</span>
            <span className="the-world-rpg-player-text">“{recentPlayerQuote.text}”</span>
          </div>
        ) : null}

        <div ref={speechScrollRef} className="the-world-rpg-speech-wrap">
          {conversation.loading && !latestNpc ? (
            <p className="the-world-rpg-greeting">{t("theWorld.rpg.loading")}</p>
          ) : latestNpc && latestNpcHtml !== null ? (
            <div
              key={latestNpc.id}
              className={`the-world-rpg-speech the-world-rpg-line-reveal${latestNpc.kind === "ask" ? " is-ask" : ""}`}
            >
              {latestNpc.kind === "ask" ? (
                <span className="the-world-rpg-ask-tag">
                  <WorldIcon name="question" size={12} tone="amber" />
                  <span>{t("theWorld.rpg.askBadge")}</span>
                </span>
              ) : null}
              <div
                className="the-world-rpg-markdown"
                // renderMarkdown은 @fleet-console/markdown/core의 정제된 HTML을 생성한다.
                dangerouslySetInnerHTML={{ __html: latestNpcHtml }}
              />
              {latestNpc.streaming ? <span className="the-world-chat-cursor">▌</span> : null}
            </div>
          ) : (
            <p key={`greeting:${actor.id}`} className="the-world-rpg-greeting the-world-rpg-line-reveal">
              “{actor.role === "commodore"
                ? t("theWorld.rpg.greetingCommodore")
                : t("theWorld.rpg.greetingOther")}”
            </p>
          )}
        </div>

        {(conversation.working || (!conversation.working && hasErrorEntry && conversation.retryTurn) || showHistoryLink) ? (
          <div className="the-world-rpg-stage-meta">
            <div className="the-world-rpg-stage-status">
              {conversation.working ? (
                <span className="the-world-rpg-working-pill">
                  <span className="the-world-working-dot" aria-hidden="true" />
                  <span>{conversation.stepLabel ?? t("theWorld.rpg.thinking")}</span>
                </span>
              ) : null}
              {conversation.working && conversation.stopTurn ? (
                <button
                  type="button"
                  className="the-world-dialogue-chip is-danger"
                  disabled={actionBusy}
                  onClick={() => runControl(conversation.stopTurn, t("theWorld.rpg.stopRequested", { name: actor.name }))}
                >
                  <WorldIcon name="stop" size={11} tone="warn" />
                  <span>{t("theWorld.rpg.stop")}</span>
                </button>
              ) : null}
              {!conversation.working && hasErrorEntry && conversation.retryTurn ? (
                <button
                  type="button"
                  className="the-world-dialogue-chip is-warn"
                  disabled={actionBusy}
                  onClick={() => runControl(conversation.retryTurn, t("theWorld.rpg.retryRequested", { name: actor.name }))}
                >
                  <WorldIcon name="retry" size={11} tone="amber" />
                  <span>{t("theWorld.rpg.retry")}</span>
                </button>
              ) : null}
            </div>

            {showHistoryLink ? (
              <button
                type="button"
                className="the-world-rpg-history-link"
                onClick={() => openActorPanel(actor.id, "chat", actor.role === "commodore" ? null : objectiveTargetId)}
              >
                <span>{t("theWorld.rpg.viewHistory", { count: historyCount })} ↗</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 사령관 대기 질문 (Ask) 인라인 RPG 선택지 도크 */}
      {hasOpenAsks && actor.commodoreId ? (
        <div className="the-world-dialogue-asks">
          {deps.renderCommodoreAsks(actor.commodoreId)}
        </div>
      ) : null}

      {/* 하단 퀵 프롬프트 칩 + 한 줄 입력창 */}
      <div className="the-world-rpg-foot">
        {showQuickChips ? (
          <div className="the-world-dialogue-chips">
            {QUICK_PROMPT_KEYS[actor.role].map((promptKey) => {
              const prompt = t(promptKey);
              return (
                <button
                  key={promptKey}
                  type="button"
                  className="the-world-dialogue-chip"
                  disabled={sending}
                  onClick={() => {
                    setDraft(prompt);
                    inputRef.current?.focus();
                  }}
                >
                  {prompt}
                </button>
              );
            })}
          </div>
        ) : null}

        {feedback ? (
          <div className={`the-world-dialogue-feedback${feedback.tone === "error" ? " is-error" : ""}`}>
            {feedback.text}
          </div>
        ) : null}

        <div className="the-world-dialogue-composer">
          <input
            ref={inputRef}
            type="text"
            className="the-world-input"
            value={draft}
            placeholder={t("theWorld.dialogue.inputPlaceholder", { name: actor.name })}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            type="button"
            className="the-world-primary-action"
            disabled={sending || draft.trim().length === 0}
            onClick={() => void handleSend()}
          >
            {sending ? t("theWorld.rpg.sending") : t("theWorld.rpg.send")}
          </button>
        </div>
      </div>
    </section>
  );
});
