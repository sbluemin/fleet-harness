import type { Translate } from "@fleet-console/sdk/i18n";

import type { Objective, ObjectiveActor } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 보드가 남긴 행위자를 사람의 말로 — 사람·지휘관·사령관·다른 세션. 행위자는 문자열이거나 객체이므로 그대로 그리지 않고,
 * 사람/지휘관 두 갈래로 가정하지 않는다. 옛 기록의 생략은 사람이다.
 */
export type ActorKind = "human" | "commander" | "commodore" | "operation";

export function actorKind(actor: ObjectiveActor | undefined): ActorKind {
  if (actor === undefined || actor === "human") return "human";
  if (actor === "commander") return "commander";
  return actor.kind;
}

/** 이름만 — 「사람」 「지휘관」 「사령관」 또는 그 세션의 제목. */
export function actorName(t: T, actor: ObjectiveActor | undefined): string {
  switch (actorKind(actor)) {
    case "human": return t("objectives.actor.human");
    case "commander": return t("objectives.actor.commander");
    case "commodore": return t("objectives.actor.commodore");
    case "operation": {
      const title = typeof actor === "object" && actor.kind === "operation" ? actor.title : null;
      return title ?? t("objectives.actor.agent");
    }
  }
}

/** 문장의 주어 — 「사령관이」 「지휘관이」 「「…」 세션이」. */
function actorSubject(t: T, actor: ObjectiveActor | undefined): string {
  switch (actorKind(actor)) {
    case "human": return t("objectives.actor.subject.human");
    case "commander": return t("objectives.actor.subject.commander");
    case "commodore": return t("objectives.actor.subject.commodore");
    case "operation": {
      const title = typeof actor === "object" && actor.kind === "operation" ? actor.title : null;
      return title ? t("objectives.actor.subject.operation", { title }) : t("objectives.actor.subject.agent");
    }
  }
}

export type ActorVerb = "answered" | "approved" | "rejected" | "completed" | "handedOff";

/**
 * 「사령관이 답함」 같은 한 마디. 사람이 한 일은 지금까지처럼 따로 적지 않는다(null) — 보드의 기본 주인은 사람이고,
 * 적을 것은 사람 아닌 손이 한 일이다.
 */
export function actorDid(t: T, actor: ObjectiveActor | undefined, verb: ActorVerb): string | null {
  if (actorKind(actor) === "human") return null;
  return t(`objectives.actor.did.${verb}`, { who: actorSubject(t, actor) });
}

/** 회고 없이 넘긴 손 — 사람이면 지금 문구, 아니면 그 손을 적는다. */
export function handedOffWithoutRetro(t: T, actor: ObjectiveActor): string {
  return actorKind(actor) === "human" ? t("objectives.retro.byHuman") : t("objectives.retro.byActor", { who: actorSubject(t, actor) });
}

/** 기준을 받아들인 마지막 행위 — 추가 제안은 같은 글로, 고침 제안은 대상 id 로 기준과 잇는다. */
export function criterionApproval(objective: Objective, criterion: { readonly id: string; readonly text: string }): ObjectiveActor | undefined {
  const actions = objective.actions ?? [];
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]!;
    if (action.kind !== "criteria-approved" || !action.proposal) continue;
    const proposal = action.proposal;
    if ((proposal.kind === "add" && proposal.text === criterion.text) || (proposal.kind !== "add" && proposal.target === criterion.id)) return action.by;
  }
  return undefined;
}

/** 편집한 손들 중 사람 아닌 이름 — 띠의 「바뀐 보드(…)」 뒤에 붙는다. */
export function nonHumanEditors(t: T, actors: readonly ObjectiveActor[] | undefined): string[] {
  const names = (actors ?? []).filter((actor) => actorKind(actor) !== "human").map((actor) => actorName(t, actor));
  return [...new Set(names)];
}
