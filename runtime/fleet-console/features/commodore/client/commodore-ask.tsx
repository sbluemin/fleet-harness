import { useMemo } from "react";

import type { ConversationDecision, ConversationSpeaker } from "../../execution/shared/conversation/types.js";
import type { Translate } from "@fleet-console/i18n";

import type { CommodoreAsk } from "../shared/contracts/types.js";
import { MAX_DECISION_ANSWER_INPUT } from "../shared/contracts/questions.js";
import { answerCommodoreAsk, askObjectiveTitle, commodoreDecisionCardRenderer, useCommodore, useCommodoreName } from "./commodore-state.js";
import type { CommodoreMessageKey } from "./i18n/index.js";
import { openObjectiveFromCluster, openObjectiveOnPhone, useObjectiveTheater } from "./board.js";

type T = Translate<CommodoreMessageKey>;

/**
 * 질문이 이미 끝났다는 거절 — 상태를 다시 읽으면 카드가 곧 걷히므로 그 사유는 카드 밖(기록 칸의 실패 줄)이 말한다.
 * 기록 칸의 실패 문구 함수가 이 코드를 그 사유 낱말(`errorWord`)로 옮긴다.
 */
export const ENDED_ASK_CODES: ReadonlySet<string> = new Set(["ask_withdrawn", "ask_already_answered"]);

/**
 * 사령관의 질문 한 장 — 대기함이 펼친 행 안에 세운다. 카드는 그룹 대화의 결정 카드(호스트 `ctx.chat.DecisionCard`)다.
 * 보내는 길은 사령관 질문 답하기 하나다. `onEnded`는 이미 끝난 질문의 거절을 카드 밖에 남긴다.
 */
export function CommodoreAskCard({ ask, theaterId, contextTheaterId = "", t, language, phone = false, leave, onEnded, onAnswered }: {
  readonly ask: CommodoreAsk;
  readonly theaterId: string;
  readonly contextTheaterId?: string;
  readonly t: T;
  readonly language: "en" | "ko";
  readonly phone?: boolean;
  readonly leave?: (run: () => void) => void;
  readonly onEnded?: (error: unknown) => void;
  readonly onAnswered?: (id: string) => void;
}) {
  const { view } = useCommodore(theaterId);
  const board = useObjectiveTheater(theaterId);
  const name = useCommodoreName(theaterId, t);
  const asker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name }), [name]);
  const Card = commodoreDecisionCardRenderer();
  if (!Card) return null;
  const titleOf = (objectiveId: string) => askObjectiveTitle(board, view?.asks?.objectives, objectiveId);
  return (
    <Card
      decision={askDecision(ask, { theaterId, contextTheaterId: board.objectives.find((row) => row.id === ask.objectiveId)?.theaterId ?? contextTheaterId, t, phone, leave, onEnded, objectiveOnBoard: ask.objectiveId ? titleOf(ask.objectiveId) !== null : false })}
      asker={asker}
      language={language}
      commodoreId={theaterId}
      mobile={phone}
      onAnswered={(id) => onAnswered?.(id)}
    />
  );
}

/** 사령관의 질문 → 그룹 대화 결정 카드의 계약. 질문·선택지는 그대로 옮기고, 이미 끝난 질문의 거절만 카드 밖으로 돌린다. */
function askDecision(ask: CommodoreAsk, { theaterId, contextTheaterId, t, phone, leave, onEnded, objectiveOnBoard }: {
  readonly theaterId: string;
  readonly contextTheaterId: string;
  readonly t: T;
  readonly phone: boolean;
  readonly leave: ((run: () => void) => void) | undefined;
  readonly onEnded: ((error: unknown) => void) | undefined;
  readonly objectiveOnBoard: boolean;
}): ConversationDecision {
  const objectiveId = ask.objectiveId;
  return {
    id: ask.id,
    title: ask.questions[0]?.text ?? "",
    createdAt: ask.at,
    questions: ask.questions.map((question) => ({
      id: question.id,
      ...(question.header ? { header: question.header } : {}),
      text: question.text,
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({ id: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) })),
    })),
    answerMaxLength: MAX_DECISION_ANSWER_INPUT,
    handed: { label: t("commodore.board.ask.reason"), reason: ask.reason },
    route: t("commodore.board.ask.route"),
    ...(objectiveId && objectiveOnBoard ? {
      open: () => {
        if (phone) { const open = () => openObjectiveOnPhone(objectiveId, contextTheaterId); if (leave) leave(open); else open(); return; }
        openObjectiveFromCluster(contextTheaterId, objectiveId);
      },
    } : {}),
    answer: async (answers) => {
      try {
        await answerCommodoreAsk(theaterId, ask.id, answers);
      } catch (error) {
        // 이미 끝난 질문 — 카드는 곧 걷히므로 사유는 기록 칸이 말하고 카드는 내린다. 그 밖의 거절은 카드가 고른 것을 지키며 말한다.
        const code = error instanceof Error ? error.message : "";
        if (onEnded && ENDED_ASK_CODES.has(code)) { onEnded(error); return; }
        throw error;
      }
    },
  };
}
