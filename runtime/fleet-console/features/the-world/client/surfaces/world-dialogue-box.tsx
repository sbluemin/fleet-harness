import { useEffect, useRef, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorEmote, WorldActorSpec } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT } from "../i18n/index.js";
import {
  closeActorInteraction,
  exitTheWorld,
  openActorDialogue,
  openActorRadialMenu,
  pushActorSpeech,
  requestActorEmote,
} from "../world-store.js";

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

/**
 * 하단 중앙 플로팅 MMORPG NPC 대화·상태 살피기 창.
 *
 * 기존 우측 사이드 시트를 대체하며, 방사형 메뉴에서 `말 걸기` 또는 `상태 살피기`를 선택했을 때만
 * 화면 하단에 콤팩트하게 떠올라 3D 초원과 캐릭터 표정을 가리지 않고 자연스럽게 소통한다.
 */
export function WorldDialogueBox({
  actor,
  mode,
  deps,
  onStatusBanner,
}: {
  readonly actor: WorldActorSpec;
  readonly mode: "dialogue" | "inspect";
  readonly deps: TheWorldClientDeps;
  readonly onStatusBanner: (msg: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly tone: "ok" | "error"; readonly text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = getWorldT(deps.commodore.language());

  useEffect(() => {
    setFeedback(null);
    if (mode === "dialogue") {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [actor.id, mode]);

  const handleOpenInConsole = (tab?: "log" | "info" | "memory" | "settings" | "goals") => {
    exitTheWorld({
      reducedMotion: deps.isReducedMotion(),
      onExited: () => {
        if (actor.role === "commodore" && actor.commodoreId) {
          deps.openCommodoreInConsole(actor.commodoreId, tab ? { tab } : undefined);
        } else if (actor.commodoreId && (actor.rootObjectiveId ?? actor.objectiveId)) {
          deps.openObjectiveInConsole(actor.commodoreId, (actor.rootObjectiveId ?? actor.objectiveId)!);
        }
      },
    });
  };

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
        pushActorSpeech(actor.id, `💬 "${trimmed.slice(0, 22)}" 접수!`);
        setFeedback({ tone: "ok", text: `✓ ${actor.name} 세션으로 실제 메시지를 전달했습니다.` });
        onStatusBanner(`✓ ${actor.name}에게 메시지를 전송했습니다.`);
        setDraft("");
      } else {
        const reason = result.error === "mention_target_gone"
          ? "사령관 보드가 아직 준비되지 않았습니다. [↗ 2D 콘솔]에서 상태를 확인해 주세요."
          : "현재 세션에 바로 전송할 수 없습니다. [↗ 2D 콘솔]에서 대화를 시작해 보세요.";
        setFeedback({ tone: "error", text: reason });
        onStatusBanner(`⚠️ ${actor.name} 전송 실패: ${reason}`);
      }
    } finally {
      setSending(false);
    }
  };

  const emoteKind: WorldActorEmote =
    actor.role === "commodore" ? "greet" : actor.role === "commander" ? "cheer" : "highfive";
  const emoteLabel =
    actor.role === "commodore" ? "👋 인사하기" : actor.role === "commander" ? "👏 격려하기" : "🙌 하이파이브";

  const npcLine = actor.state === "decision" || actor.state === "awaiting"
    ? "제독님의 확인을 기다리고 있어요! 아래에서 바로 답장하거나 2D 콘솔에서 상세 내용을 볼 수 있습니다."
    : actor.state === "running"
      ? "지금 열심히 작전을 수행 중이에요! 추가 지시가 있으면 언제든 말씀해 주세요."
      : actor.role === "commodore"
        ? "대기 중입니다, 제독님. 어떤 작전을 시작해 볼까요?"
        : "지시 대기 중입니다. 필요한 내용을 말씀해 주세요.";

  return (
    <section
      className="the-world-dialogue"
      role="dialog"
      aria-label={t("theWorld.dialogue.aria", { name: actor.name })}
    >
      <div className="the-world-dialogue-head">
        <div className="the-world-dialogue-speaker">
          <div className="the-world-dialogue-portrait" data-tone={actor.tone}>
            <MongleAvatar
              base={actor.baseId}
              tone={actor.tone}
              role={actor.role}
              state={actor.state}
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
              <span className={`the-world-dialogue-badge${actor.needsAttention ? " is-attention" : ""}`}>
                {STATE_LABEL[actor.state]}
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
          <button
            type="button"
            className="the-world-btn"
            aria-label={t("theWorld.dialogue.backAria")}
            onClick={() => openActorRadialMenu(actor.id)}
          >
            ↩ 휠
          </button>
          {actor.commodoreId || actor.objectiveId ? (
            <button type="button" className="the-world-btn" onClick={() => handleOpenInConsole()}>
              ↗ 콘솔
            </button>
          ) : null}
          <button
            type="button"
            className="the-world-btn"
            aria-label={t("theWorld.dialogue.closeAria")}
            onClick={closeActorInteraction}
          >
            ✕
          </button>
        </div>
      </div>

      {mode === "dialogue" ? (
        <div className="the-world-dialogue-body">
          <p className="the-world-dialogue-line">“{npcLine}”</p>
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
      ) : (
        <div className="the-world-dialogue-body">
          <div className="the-world-inspect-grid">
            {actor.summaryLines.map((line, i) => (
              <div key={i} className="the-world-inspect-item">
                • {line}
              </div>
            ))}
          </div>

          {actor.missions && actor.missions.length > 0 ? (
            <div className="the-world-inspect-missions">
              {actor.missions.map((m) => (
                <div key={m.id} className={`the-world-mission-row${m.done ? " is-done" : ""}`}>
                  <span>{m.done ? "✓" : m.active ? "●" : "○"}</span>
                  <span>{m.label}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="the-world-dialogue-actions">
            <button
              type="button"
              className="the-world-primary-action"
              onClick={() => openActorDialogue(actor.id)}
            >
              💬 바로 말 걸기
            </button>
            <button
              type="button"
              className="the-world-secondary-action"
              onClick={() => {
                requestActorEmote(actor.id, emoteKind);
                closeActorInteraction();
              }}
            >
              {emoteLabel}
            </button>
            {actor.role === "commodore" && actor.commodoreId ? (
              <button
                type="button"
                className="the-world-secondary-action"
                onClick={() => handleOpenInConsole("settings")}
              >
                ⚙️ 사령관 설정
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
