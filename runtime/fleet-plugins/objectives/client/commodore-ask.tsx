import { useEffect, useMemo, useState } from "react";

import type { ConversationDecision, ConversationSpeaker } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { CommodoreAsk } from "../server/commodore/types.js";
import { MAX_DECISION_ANSWER_INPUT } from "../server/types.js";
import { answerCommodoreAsk, askObjectiveTitle, commodoreDecisionCardRenderer, openAsks, useCommodore } from "./commodore-state.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { openObjectiveFromCluster, openObjectiveOnPhone, revealObjective, useObjectiveTheater } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 질문이 이미 끝났다는 거절 — 상태를 다시 읽으면 카드가 곧 걷히므로 그 사유는 카드 밖(기록 칸의 실패 줄)이 말한다.
 * 기록 칸의 실패 문구 함수가 이 코드를 그 사유 낱말(`errorWord`)로 옮긴다.
 */
export const ENDED_ASK_CODES: ReadonlySet<string> = new Set(["ask_withdrawn", "ask_already_answered"]);

/**
 * 사령관의 질문 — 사령관이 보드 항목이 아닌 일을 사람에게 직접 물은 것. 사령관 기록(시트·대화 중심 화면·폰)의 최신 글 뒤에 서서 함께 스크롤되고,
 * 카드는 지휘관·구성원 그룹 대화의 결정 카드 그대로다(호스트 `ctx.chat.DecisionCard`): 묻는 이유는 넘긴 이유 칸, 답이 갈 곳은
 * 보내기 곁 한 줄, 목표에 매인 질문이면 그 목표로 가는 열기. 보내는 길은 사령관 질문 답하기 하나다. 보내거나 사령관이 거두면
 * 질문이 끝나 카드가 내려가고, 기록에는 「사람에게 물음」·「사람이 답함」 줄이 남는다.
 *
 * `onEnded` — 질문이 이미 끝났다는 거절을 카드 밖에 남기는 기록 칸의 실패 경로.
 */
export function CommodoreAskCards({ theaterId, t, language, phone = false, onEnded }: {
  readonly theaterId: string;
  readonly t: T;
  readonly language: "en" | "ko";
  readonly phone?: boolean;
  readonly onEnded?: (error: unknown) => void;
}) {
  const { view } = useCommodore(theaterId);
  const board = useObjectiveTheater(theaterId);
  const asks = openAsks(theaterId);
  // 답이 받아들여진 질문은 상태가 다시 읽히기 전에도 내린다 — 그룹 대화의 결정 카드와 같은 규칙.
  const [answered, setAnswered] = useState<readonly string[]>([]);
  useEffect(() => setAnswered([]), [theaterId]);
  const asker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name: t("objectives.commodore.name") }), [t]);
  const Card = commodoreDecisionCardRenderer();
  const shown = asks.filter((ask) => !answered.includes(ask.id));
  if (!Card || shown.length === 0) return null;
  const titleOf = (objectiveId: string) => askObjectiveTitle(board, view?.asks?.objectives, objectiveId);
  return (
    <div className={phone ? "objectives-cm-asks" : "objectives-asks"}>
      {shown.map((ask) => (
        <Card
          key={ask.id}
          decision={askDecision(ask, { theaterId, t, phone, onEnded, objectiveOnBoard: ask.objectiveId ? titleOf(ask.objectiveId) !== null : false })}
          asker={asker}
          language={language}
          theaterId={theaterId}
          mobile={phone}
          onAnswered={(id) => setAnswered((current) => (current.includes(id) ? current : [...current, id]))}
        />
      ))}
    </div>
  );
}

/** 사령관의 질문 → 그룹 대화 결정 카드의 계약. 질문·선택지는 그대로 옮기고, 이미 끝난 질문의 거절만 카드 밖으로 돌린다. */
function askDecision(ask: CommodoreAsk, { theaterId, t, phone, onEnded, objectiveOnBoard }: {
  readonly theaterId: string;
  readonly t: T;
  readonly phone: boolean;
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
    handed: { label: t("objectives.ask.reason"), reason: ask.reason },
    route: t("objectives.ask.route"),
    ...(objectiveId && objectiveOnBoard ? {
      open: () => {
        if (phone) { openObjectiveOnPhone(objectiveId, theaterId); return; }
        revealObjective({ objectiveId });
        openObjectiveFromCluster(theaterId, objectiveId);
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
