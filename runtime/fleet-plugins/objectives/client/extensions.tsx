import type { Translate, ConsoleLocale } from "@fleet-console/sdk/i18n";

import type { Objective } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { Retrospective } from "./retrospective.js";

type T = Translate<ObjectiveMessageKey>;

export function ExtensionChip({ n, t }: { readonly n: number | null; readonly t: T }) {
  return n === null ? null : <span className="objectives-extension-chip">{t("objectives.extend.chip", { n })}</span>;
}

export function ExtensionDivider({ n, t }: { readonly n: number | null; readonly t: T }) {
  return <div className="objectives-extension-divider">{n === null ? t("objectives.extend.original") : t("objectives.extend.chip", { n })}</div>;
}

/** 회차 시작 때 동결한 인계·회고 — 현재 보드를 고쳐도 남고, 이전 회차는 접힌 채 읽는다. */
export function ExtensionHistory({ objective, t, language }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale }) {
  if (!objective.extensions.length) return null;
  return <div className="objectives-extension-history">
    {objective.extensions.map((round, index) => {
      const handoff = round.previousHandoff;
      const retro = handoff?.by === "commander" ? handoff.retrospective : null;
      const label = round.n === 1 ? t("objectives.extend.original") : t("objectives.extend.chip", { n: round.n - 1 });
      const previous = objective.extensions[index - 1];
      return <details key={round.n} className="objectives-extension-past">
        <summary>{t("objectives.extend.previousRetro", { round: label })}</summary>
        {previous ? <p className="objectives-extension-request"><b>{t("objectives.extend.request")}</b><LinkText text={previous.context} /></p> : null}
        {handoff ? <>
          <time className="objectives-extension-time" dateTime={new Date(handoff.at).toISOString()}>{new Date(handoff.at).toLocaleString(language === "ko" ? "ko-KR" : "en-US")}</time>
          <Retrospective t={t} by={handoff.by} good={retro?.wentWell.map((pair) => ({ text: pair.point, aside: pair.because })) ?? []} regret={retro?.fellShort.map((pair) => ({ text: pair.point, aside: pair.ifOnly })) ?? []} />
        </> : null}
      </details>;
    })}
  </div>;
}
