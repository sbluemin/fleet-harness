import { renderMarkdown } from "@fleet-console/markdown/core";
import { memo, useEffect, useRef, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorSpec, WorldChatFeedEntry } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT } from "../i18n/index.js";
import {
  closeActorInteraction,
  openActorPanel,
  openActorRadialMenu,
  pushActorSpeech,
} from "../world-store.js";
import { WorldIcon } from "./world-icons.js";

const ROLE_LABEL: Record<WorldActorSpec["role"], string> = {
  commodore: "사령관",
  commander: "지휘관",
  member: "구성원",
};

const STATE_LABEL: Record<WorldActorSpec["state"], string> = {
  idle: "대기 중",
  fresh: "준비됨",
  unseen: "새 소식",
  running: "작업 중",
  awaiting: "승인 대기",
  decision: "확인 필요",
  review: "검토 대기",
  done: "완료",
  ended: "종료됨",
  error: "오류",
};

const QUICK_PROMPTS: Record<WorldActorSpec["role"], readonly string[]> = {
  commodore: ["현재 상태 요약해줘", "진행 중인 작업 확인해줘"],
  commander: ["진행 현황 보고해줘", "다음 단계 우선순위 알려줘"],
  member: ["현재 진행 상황 알려줘", "막힌 부분이 있으면 보고해줘"],
};

function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

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

const DialogueEntryRow = memo(function DialogueEntryRow({ entry }: { readonly entry: WorldChatFeedEntry }) {
  const time = formatClock(entry.at);
  if (entry.kind === "system-wake" || entry.kind === "system-info" || entry.kind === "system-error") {
    const iconName = entry.kind === "system-wake"
      ? "systemWake"
      : entry.kind === "system-error"
        ? "warning"
        : "systemInfo";
    const iconTone = entry.kind === "system-error" ? "warn" : "amber";
    return (
      <div
        className={`the-world-msg-system${entry.kind === "system-wake" ? " is-wake" : ""}${entry.kind === "system-error" ? " is-error" : ""}`}
      >
        <span className="the-world-msg-sys-badge">
          <WorldIcon name={iconName} size={13} tone={iconTone} />
          <span>[시스템] {entry.badge ?? "알림"}</span>
        </span>
        <span className="the-world-msg-sys-text">{entry.text}</span>
        <span className="the-world-msg-time">{time}</span>
      </div>
    );
  }

  if (entry.kind === "action") {
    return (
      <div className={`the-world-msg-action${entry.failed ? " is-error" : ""}`}>
        <span className="the-world-msg-act-badge">
          <WorldIcon name="tool" size={12} tone={entry.failed ? "warn" : "cerulean"} />
          <span>{entry.badge ?? "도구"}</span>
        </span>
        <span className="the-world-msg-act-text">{entry.text}{entry.streaming ? " ⋯" : ""}</span>
        <span className="the-world-msg-time">{time}</span>
      </div>
    );
  }

  if (entry.kind === "player") {
    return (
      <div className="the-world-msg-row is-player">
        <div className="the-world-msg-bubble is-player">
          {entry.badge ? <div className="the-world-msg-kicker">{entry.badge}</div> : null}
          <div className="the-world-msg-body">{entry.text}</div>
          <div className="the-world-msg-foot">{time}</div>
        </div>
      </div>
    );
  }

  if (entry.kind === "peer") {
    return (
      <div className="the-world-msg-row is-npc">
        <div className="the-world-msg-bubble is-peer">
          <div className="the-world-msg-kicker">
            <WorldIcon name="mail" size={12} tone="cerulean" />
            <span>
              {entry.actorName}{entry.targetName ? ` → ${entry.targetName}` : ""}
              {entry.badge ? ` · ${entry.badge}` : ""}
            </span>
          </div>
          <div className="the-world-msg-body">{entry.text}</div>
          <div className="the-world-msg-foot">{time}</div>
        </div>
      </div>
    );
  }

  const html = renderCachedMarkdownHtml(entry.text);
  return (
    <div className="the-world-msg-row is-npc">
      <div className={`the-world-msg-bubble is-npc${entry.kind === "ask" ? " is-ask" : ""}${entry.streaming ? " is-streaming" : ""}`}>
        <div className="the-world-msg-kicker">
          {entry.kind === "ask" ? (
            <>
              <WorldIcon name="question" size={13} tone="amber" />
              <span>확인 필요 · </span>
            </>
          ) : null}
          <span>{entry.actorName}</span>
        </div>
        <div className="the-world-msg-body the-world-msg-markdown">
          <div
            // renderMarkdown은 @fleet-console/markdown/core의 정제된 HTML을 생성한다.
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {entry.streaming ? <span className="the-world-chat-cursor">▌</span> : null}
        </div>
        <div className="the-world-msg-foot">{time}</div>
      </div>
    </div>
  );
});

/**
 * 더 월드 인게임 RPG 실시간 대화창.
 *
 * 2D 콘솔로 이동하지 않고 사령관·지휘관·구성원의 실제 대화 내역, 실시간 스트리밍 응답,
 * 감시자 깨우기(구상 요청 등) 시스템 줄, 도구 활동, 확인 필요(Ask) 응답 카드를
 * 게임 대화창 감각으로 한자리에서 확인하고 이어간다.
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const t = getWorldT(deps.commodore.language());

  const conversation = deps.useActorConversation(actor);

  useEffect(() => {
    setFeedback(null);
    stickToBottomRef.current = true;
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  }, [actor.id]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [conversation.entries, conversation.working, conversation.openAsksCount]);

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
        pushActorSpeech(actor.id, `[chat] "${trimmed.slice(0, 24)}" 접수!`);
        onStatusBanner(`${actor.name}에게 메시지를 전송했습니다.`);
        setDraft("");
      } else {
        const reason = result.error === "mention_target_gone"
          ? "사령관 보드가 아직 준비 중입니다. 잠시 후 다시 시도하거나 [설정]에서 상태를 확인해 주세요."
          : `전송 실패 (${result.error ?? "unknown"})`;
        setFeedback({ tone: "error", text: reason });
        onStatusBanner(`${actor.name} 전송 실패: ${reason}`);
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

  const hasErrorEntry = conversation.entries.at(-1)?.kind === "system-error" || actor.state === "error";

  return (
    <section
      className="the-world-dialogue"
      role="dialog"
      aria-label={t("theWorld.dialogue.aria", { name: actor.name })}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="the-world-crest" aria-hidden="true" />
      <div className="the-world-dialogue-head">
        <div className="the-world-dialogue-speaker">
          <div className="the-world-dialogue-portrait" data-tone={actor.tone}>
            <MongleAvatar
              base={actor.baseId}
              tone={actor.tone}
              role={actor.role}
              state={conversation.working ? "running" : actor.state}
              activity={actor.activity}
              size={40}
              label={actor.name}
              decorative
            />
          </div>
          <div className="the-world-dialogue-meta">
            <div className="the-world-dialogue-name-row">
              <span className="the-world-dialogue-name">{actor.name}</span>
              <span className="the-world-dialogue-badge">{ROLE_LABEL[actor.role]}</span>
              <span className={`the-world-dialogue-badge${actor.needsAttention || conversation.openAsksCount > 0 ? " is-attention" : conversation.working ? " is-working" : ""}`}>
                {conversation.working ? (conversation.stepLabel ?? "작업 중") : STATE_LABEL[actor.state]}
              </span>
              {actor.modelLabel ? (
                <span className="the-world-dialogue-badge is-code">{actor.modelLabel}</span>
              ) : null}
            </div>
            {actor.subtitle !== ROLE_LABEL[actor.role] ? (
              <div className="the-world-dialogue-sub">{actor.subtitle}</div>
            ) : null}
          </div>
        </div>

        <div className="the-world-dialogue-controls">
          {actor.role === "commodore" && actor.commodoreId ? (
            <>
              <button
                type="button"
                className="the-world-btn"
                onClick={() => openActorPanel(actor.id, "goals")}
              >
                <WorldIcon name="questMap" size={14} tone="moss" />
                <span>목표</span>
              </button>
              <button
                type="button"
                className="the-world-btn"
                onClick={() => openActorPanel(actor.id, "info")}
              >
                <WorldIcon name="inspect" size={14} tone="cerulean" />
                <span>정보</span>
              </button>
              <button
                type="button"
                className="the-world-btn"
                onClick={() => openActorPanel(actor.id, "settings")}
              >
                <WorldIcon name="settings" size={14} tone="indigo" />
                <span>설정</span>
              </button>
            </>
          ) : actor.commodoreId && (actor.rootObjectiveId ?? actor.objectiveId) ? (
            <button
              type="button"
              className="the-world-btn"
              onClick={() => openActorPanel(actor.id, "goals", actor.rootObjectiveId ?? actor.objectiveId)}
            >
              <WorldIcon name="questMap" size={14} tone="moss" />
              <span>목표 보드</span>
            </button>
          ) : null}
          <button
            type="button"
            className="the-world-btn"
            aria-label={t("theWorld.dialogue.backAria")}
            onClick={() => openActorRadialMenu(actor.id)}
          >
            <WorldIcon name="wheelBack" size={14} />
            <span>휠</span>
          </button>
          <button
            type="button"
            className="the-world-btn"
            aria-label={t("theWorld.dialogue.closeAria")}
            onClick={closeActorInteraction}
          >
            <WorldIcon name="close" size={14} />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="the-world-dialogue-transcript"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        {conversation.hasOlder ? (
          <div className="the-world-dialogue-older">
            <button
              type="button"
              className="the-world-dialogue-chip"
              onClick={conversation.loadOlder}
            >
              이전 대화 불러오기
            </button>
          </div>
        ) : null}

        {conversation.loading && conversation.entries.length === 0 ? (
          <div className="the-world-dialogue-empty">대화 기록을 불러오는 중입니다...</div>
        ) : conversation.entries.length === 0 ? (
          <div className="the-world-dialogue-empty">
            “{actor.role === "commodore"
              ? "대기 중입니다, 제독님. 무엇을 함께 진행해 볼까요?"
              : "지시 대기 중입니다. 필요한 내용을 말씀해 주세요."}”
          </div>
        ) : (
          conversation.entries.map((entry) => (
            <DialogueEntryRow key={entry.id} entry={entry} />
          ))
        )}

        {conversation.working ? (
          <div className="the-world-msg-working">
            <span className="the-world-working-dot" aria-hidden="true" />
            <span>{conversation.stepLabel ?? `${actor.name} 응답 작성 중...`}</span>
          </div>
        ) : null}
      </div>

      {actor.role === "commodore" && actor.commodoreId && conversation.openAsksCount > 0 ? (
        <div className="the-world-dialogue-asks">
          {deps.renderCommodoreAsks(actor.commodoreId)}
        </div>
      ) : null}

      <div className="the-world-dialogue-footer">
        <div className="the-world-dialogue-chips">
          {QUICK_PROMPTS[actor.role].map((prompt) => (
            <button
              key={prompt}
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
          ))}
          {conversation.working && conversation.stopTurn ? (
            <button
              type="button"
              className="the-world-dialogue-chip is-danger"
              disabled={actionBusy}
              onClick={() => runControl(conversation.stopTurn, `${actor.name} 턴 중지를 요청했습니다.`)}
            >
              <WorldIcon name="stop" size={12} tone="warn" />
              <span>턴 중지</span>
            </button>
          ) : null}
          {!conversation.working && hasErrorEntry && conversation.retryTurn ? (
            <button
              type="button"
              className="the-world-dialogue-chip is-warn"
              disabled={actionBusy}
              onClick={() => runControl(conversation.retryTurn, `${actor.name} 재시도를 요청했습니다.`)}
            >
              <WorldIcon name="retry" size={12} tone="amber" />
              <span>다시 시도</span>
            </button>
          ) : null}
        </div>

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
            {sending ? "전송 중..." : "전송"}
          </button>
        </div>
      </div>
    </section>
  );
});
