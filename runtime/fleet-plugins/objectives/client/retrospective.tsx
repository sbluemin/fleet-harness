/**
 * 회고 — 인계 때 지휘관이 올린 잘한 점·아쉬운 점을 두 표로 읽기 전용 표시한다. 사람이 넘긴 인계는 회고 없이 한 줄로 구분한다.
 * 각 쌍은 목표의 맥락 없이 따로 읽히므로 줄마다 두 칸을 나란히 둔다.
 */

import type { Translate } from "@fleet-console/sdk/i18n";

import type { ObjectiveMessageKey } from "./i18n/index.js";

type T = Translate<ObjectiveMessageKey>;

/** 한 쌍 — 내용과 그 옆 칸(무엇 때문에 / 만약 이랬다면). 서버 필드 이름과 무관하게 호출하는 쪽이 맞춘다. */
export interface RetroPair {
  readonly text: string;
  readonly aside: string;
}

export interface RetrospectiveProps {
  readonly t: T;
  /** 누가 넘겼나 — 사람이면 회고가 없다. */
  readonly by: "commander" | "human";
  readonly good: readonly RetroPair[];
  readonly regret: readonly RetroPair[];
}

function RetroTable({ head, asideHead, pairs }: { readonly head: string; readonly asideHead: string; readonly pairs: readonly RetroPair[] }) {
  return (
    <table className="objectives-retro-table">
      <thead><tr><th scope="col">{head}</th><th scope="col">{asideHead}</th></tr></thead>
      <tbody>
        {pairs.map((pair, at) => <tr key={at}><td>{pair.text}</td><td>{pair.aside}</td></tr>)}
      </tbody>
    </table>
  );
}

export function Retrospective({ t, by, good, regret }: RetrospectiveProps) {
  if (by === "human" || (good.length === 0 && regret.length === 0)) return <div className="objectives-retro-none">{t("objectives.retro.byHuman")}</div>;
  return (
    <div className="objectives-retro">
      {good.length ? <RetroTable head={t("objectives.retro.good")} asideHead={t("objectives.retro.goodWhy")} pairs={good} /> : null}
      {regret.length ? <RetroTable head={t("objectives.retro.regret")} asideHead={t("objectives.retro.regretIf")} pairs={regret} /> : null}
    </div>
  );
}

/** 회고 구획 머리 글리프 — 되돌아보는 화살. */
export const RetroGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5M8 5.5V8l1.8 1.3" /></svg>;
