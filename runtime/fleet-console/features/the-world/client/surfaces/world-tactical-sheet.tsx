import { useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorSpec } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT } from "../i18n/index.js";
import {
  closeWorldDrawer,
  exitTheWorld,
  pushActorSpeech,
  spawnExtraDemoOutpost,
  triggerWorldChoreography,
} from "../world-store.js";

/**
 * 월드 내 에이전트 클릭 또는 `[E]` 근접 상호작용 시 열리는 전술 도킹 시트.
 *
 * 실제 사령관·Objective 세션 메시지 전송과 콘솔 대화창 직결 이동을 수행한다.
 */
export function WorldTacticalSheet({
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
  const t = getWorldT(deps.commodore.language());

  const handleOpenInConsole = () => {
    exitTheWorld({
      reducedMotion: deps.isReducedMotion(),
      onExited: () => {
        if (actor.role === "commodore" && actor.commodoreId) {
          deps.openCommodoreInConsole(actor.commodoreId);
        } else if (actor.commodoreId && (actor.rootObjectiveId ?? actor.objectiveId)) {
          deps.openObjectiveInConsole(actor.commodoreId, (actor.rootObjectiveId ?? actor.objectiveId)!);
        }
      },
    });
  };

  const handleSend = async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      let delivered = false;
      if (!actor.isDemo) {
        if (actor.role === "commodore" && actor.commodoreId) {
          delivered = await deps.sendMessageToCommodore(actor.commodoreId, trimmed);
        } else if (actor.objectiveId) {
          delivered = await deps.sendMessageToObjective(actor.objectiveId, trimmed);
        }
      } else {
        delivered = true;
      }

      pushActorSpeech(actor.id, `💬 "${trimmed.slice(0, 20)}" ${delivered ? "접수!" : "확인!"}`);
      onStatusBanner(
        actor.isDemo
          ? `💬 [시뮬레이션] ${actor.name}에게 메시지를 전달했습니다: "${trimmed}"`
          : delivered
            ? `✓ ${actor.name} 세션에 실제 메시지를 전송했습니다.`
            : `ℹ️ 현재 세션이 비활성 상태입니다. [콘솔 대화창에서 열기]로 시작할 수 있습니다.`,
      );
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="the-world-sheet" aria-label={t("theWorld.sheet.aria", { name: actor.name })}>
      <div className="the-world-sheet-head">
        <div className="the-world-sheet-title-wrap">
          <MongleAvatar
            base={actor.baseId}
            tone={actor.tone}
            role={actor.role}
            state={actor.state}
            activity={actor.activity}
            size={34}
            label={actor.name}
            decorative
          />
          <div className="the-world-sheet-meta">
            <div className="the-world-sheet-title">{actor.name}</div>
            <div className="the-world-sheet-sub">{actor.subtitle}</div>
          </div>
        </div>
        <button type="button" className="the-world-btn" aria-label={t("theWorld.sheet.closeAria")} onClick={closeWorldDrawer}>
          ✕
        </button>
      </div>

      <div className="the-world-sheet-body">
        {!actor.isDemo && (actor.commodoreId || actor.objectiveId) ? (
          <button type="button" className="the-world-secondary-action" onClick={handleOpenInConsole}>
            ↗ 2D 콘솔 대화창에서 전체 열기
          </button>
        ) : null}

        {actor.role === "commodore" ? (
          <div className="the-world-card">
            <div className="the-world-card-title">🏕️ 사령관 작전 지휘</div>
            <div className="the-world-card-line">
              아래 입력창으로 사령관에게 직접 지시를 내리거나, 넓은 초원 오솔길 끝에 새 공방 캠프를 개설해 연출을 시험할 수 있습니다.
            </div>
            <button
              type="button"
              className="the-world-primary-action"
              onClick={() => {
                spawnExtraDemoOutpost();
                triggerWorldChoreography("delegate");
                onStatusBanner(`⛺ ${actor.name} 사령관이 초원 오솔길에 새 공방 캠프를 개설하고 작전 청사진을 발송했습니다!`);
              }}
            >
              + 신규 초원 캠프 개설 & 하달 연출
            </button>
          </div>
        ) : null}

        {actor.missions && actor.missions.length > 0 ? (
          <div className="the-world-card">
            <div className="the-world-card-title">🗺️ Objective 임무 보드</div>
            {actor.missions.map((m) => (
              <div key={m.id} className={`the-world-mission-row${m.done ? " is-done" : ""}`}>
                <span>{m.done ? "✓" : m.active ? "●" : "○"}</span>
                <span>{m.label}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="the-world-card">
          <div className="the-world-card-title">⚡ 실시간 상태 요약</div>
          {actor.summaryLines.map((line, i) => (
            <div key={i} className="the-world-card-line">
              • {line}
            </div>
          ))}
        </div>
      </div>

      <div className="the-world-sheet-foot">
        <input
          type="text"
          className="the-world-input"
          value={draft}
          placeholder={t("theWorld.sheet.inputPlaceholder", { name: actor.name })}
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
          전송
        </button>
      </div>
    </aside>
  );
}
