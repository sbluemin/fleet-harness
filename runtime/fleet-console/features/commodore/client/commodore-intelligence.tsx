import { lowestQualifyingEffort, type AiGatewayRole, type AiGatewayRoleThresholds } from "@fleet-console/ai-gateway/model-family";
import type { Translate } from "@fleet-console/i18n";

import type { ObjectiveLaunchVariantRow } from "../../objectives/shared/records/types.js";
import type { CommodoreMessageKey } from "./i18n/index.js";

/**
 * 지능 점수 안내 — 사령관·지휘관 선택기와 라우팅 풀이 같이 쓰는 표시 부품.
 *
 * 점수·기준값은 Gateway 레지스트리가 원천이고(로스터 칩의 `intelligence`, 카탈로그의 `intelligence`·`roleThresholds`),
 * 「기준에 닿는 가장 낮은 강도」 규칙은 `@fleet-console/ai-gateway/model-family` 한 곳에 있다. 표시 전용이다 —
 * 라우팅·저장값은 이 모듈을 읽지 않는다. 점수가 없는 강도·모델은 낮은 점수로 치지 않는다(추천도 경고도 없다).
 */

type T = Translate<CommodoreMessageKey>;

export type IntelligenceScores = Readonly<Partial<Record<string, number>>>;

/** 화면에 기준선을 그릴 역할과 그 기준값. 기준값을 아직 모르면 안내 전체가 서지 않는다. */
export interface RoleGuide {
  readonly role: AiGatewayRole;
  readonly threshold: number;
}

export function roleGuide(role: AiGatewayRole, thresholds: AiGatewayRoleThresholds | null): RoleGuide | null {
  return thresholds ? { role, threshold: thresholds[role] } : null;
}

export function roleName(t: T, role: AiGatewayRole): string {
  return role === "overseer" ? t("commodore.intel.role.overseer") : t("commodore.intel.role.lead");
}

/** 런치 메뉴 칩과 같은 강도 낱말(MED). 칩이 없는 라우팅 풀 카탈로그 행도 같은 낱말을 쓴다. */
const EFFORT_WORDS: Readonly<Record<string, string>> = { low: "LOW", medium: "MED", high: "HIGH", xhigh: "XHIGH", max: "MAX" };

export function effortWord(effort: string): string {
  return EFFORT_WORDS[effort] ?? effort.toUpperCase();
}

/** 로스터 행의 강도 사다리(칩 순서)와 강도별 점수. */
export function rowLadder(row: ObjectiveLaunchVariantRow): readonly string[] {
  return (row.chips ?? []).map((chip) => chip.id);
}

export function rowScores(row: ObjectiveLaunchVariantRow): IntelligenceScores {
  return Object.fromEntries((row.chips ?? []).flatMap((chip) => (typeof chip.intelligence === "number" ? [[chip.id, chip.intelligence] as const] : [])));
}

export function hasAnyScore(scores: IntelligenceScores): boolean {
  return Object.values(scores).some((score) => typeof score === "number");
}

/** 강도 셋 안에서 기준에 닿는 가장 낮은 강도와 그 점수. */
export function qualifying(scores: IntelligenceScores, efforts: readonly string[], threshold: number): { readonly effort: string; readonly score: number } | null {
  const effort = lowestQualifyingEffort(scores, efforts, threshold);
  const score = effort ? scores[effort] : undefined;
  return effort && typeof score === "number" ? { effort, score } : null;
}

/** 위쪽을 가리키는 셰브런 — 지휘관 추천은 한 줄, 사령관 추천은 두 줄. */
export function RankMark({ role, className = "" }: { readonly role: AiGatewayRole; readonly className?: string }) {
  return (
    <svg className={`commodore-intel-rank${className ? ` ${className}` : ""}`} viewBox="0 0 12 12" aria-hidden="true">
      {role === "overseer" ? <><path d="M2.5 5.5 6 2.5l3.5 3" /><path d="M2.5 9.5 6 6.5l3.5 3" /></> : <path d="M2.5 8 6 4.5 9.5 8" />}
    </svg>
  );
}

const BAR_AXIS = ["low", "medium", "high", "xhigh", "max"] as const;
const BAR_FLOOR = 10;
const BAR_CEIL = 70;
const BAR_HEIGHT = 16;
const barHeight = (score: number) => Math.max(2, Math.round(((Math.min(BAR_CEIL, Math.max(BAR_FLOOR, score)) - BAR_FLOOR) / (BAR_CEIL - BAR_FLOOR)) * BAR_HEIGHT));

/**
 * 강도 다섯 칸 막대. 칸 높이는 점수, 점선은 역할 기준선이고 기준에 닿는 칸만 진하다. 사다리에 없는 강도는 빈자리,
 * 사다리에는 있지만 점수가 없는 강도는 속 빈 네모다.
 */
export function ScoreBars({ t, guide, ladder, scores }: {
  readonly t: T;
  readonly guide: RoleGuide;
  readonly ladder: readonly string[];
  readonly scores: IntelligenceScores;
}) {
  return (
    <span
      className="commodore-intel-bars"
      style={{ ["--commodore-intel-th" as string]: `${barHeight(guide.threshold)}px` }}
      role="img"
      aria-label={t("commodore.intel.barsAria", { role: roleName(t, guide.role), n: guide.threshold })}
    >
      {BAR_AXIS.map((effort) => {
        if (!ladder.includes(effort)) return <i key={effort} className="is-off" />;
        const score = scores[effort];
        if (typeof score !== "number") return <i key={effort} className="is-none" title={t("commodore.intel.effortTitleNone", { effort: effortWord(effort) })} />;
        return (
          <i
            key={effort}
            className={score >= guide.threshold ? "is-met" : undefined}
            style={{ height: barHeight(score) }}
            title={t("commodore.intel.effortTitle", { effort: effortWord(effort), n: score })}
          />
        );
      })}
    </span>
  );
}

/** 선택기 행 오른쪽 — 「MED부터」 배지와 막대, 점수가 하나도 없으면 「점수 없음」. */
export function RowIntelligence({ t, guide, row }: { readonly t: T; readonly guide: RoleGuide; readonly row: ObjectiveLaunchVariantRow }) {
  const scores = rowScores(row);
  if (!hasAnyScore(scores)) return <span className="commodore-intel-meta"><span className="commodore-intel-none">{t("commodore.intel.noScore")}</span></span>;
  const ladder = rowLadder(row);
  const pick = qualifying(scores, ladder, guide.threshold);
  return (
    <span className="commodore-intel-meta">
      {pick ? (
        <span className="commodore-intel-from" aria-label={t("commodore.intel.fromAria", { role: roleName(t, guide.role), effort: effortWord(pick.effort) })}>
          <RankMark role={guide.role} />
          {t("commodore.intel.from", { effort: effortWord(pick.effort) })}
        </span>
      ) : null}
      <ScoreBars t={t} guide={guide} ladder={ladder} scores={scores} />
    </span>
  );
}

/** 모바일 좌표 시트의 행 설명 — 막대 없이 배지 글자만. 추천이 없으면 아무것도 싣지 않는다. */
export function mobileRowNote(t: T, guide: RoleGuide | null, row: ObjectiveLaunchVariantRow): string | null {
  if (!guide) return null;
  const pick = qualifying(rowScores(row), rowLadder(row), guide.threshold);
  return pick ? t("commodore.intel.mobileNote", { role: roleName(t, guide.role), effort: effortWord(pick.effort) }) : null;
}

/**
 * 고른 행 아래 한 줄 — 지금 강도의 점수와 기준. 기준 아래면 기준에 닿는 가장 낮은 강도로 올리는 단추를 둔다.
 * `effort`가 null이면 「자동」 강도다.
 */
export function ScoreReadout({ t, guide, row, effort, onRaise }: {
  readonly t: T;
  readonly guide: RoleGuide;
  readonly row: ObjectiveLaunchVariantRow;
  readonly effort: string | null;
  readonly onRaise: (effort: string) => void;
}) {
  const scores = rowScores(row);
  const role = roleName(t, guide.role);
  const pick = qualifying(scores, rowLadder(row), guide.threshold);
  if (!hasAnyScore(scores)) return <p className="commodore-intel-read is-none"><span className="commodore-intel-ring" aria-hidden="true" />{t("commodore.intel.readNone")}</p>;
  if (effort === null) {
    return (
      <p className="commodore-intel-read">
        {pick ? t("commodore.intel.readAutoRec", { role, effort: effortWord(pick.effort) }) : t("commodore.intel.readAutoNever", { role, t: guide.threshold })}
      </p>
    );
  }
  const score = scores[effort];
  if (typeof score !== "number") {
    return (
      <p className="commodore-intel-read is-none">
        <span className="commodore-intel-ring" aria-hidden="true" />
        {pick
          ? t("commodore.intel.readMissingRec", { effort: effortWord(effort), rec: effortWord(pick.effort), role, n: pick.score })
          : t("commodore.intel.readMissing", { effort: effortWord(effort) })}
      </p>
    );
  }
  if (score >= guide.threshold) {
    return (
      <p className="commodore-intel-read">
        <svg className="commodore-intel-ok" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
        {t("commodore.intel.readOk", { n: score, role, t: guide.threshold })}
      </p>
    );
  }
  return (
    <p className="commodore-intel-read is-low">
      <span className="commodore-intel-ring" aria-hidden="true" />
      {pick ? t("commodore.intel.readLow", { n: score, role, t: guide.threshold }) : t("commodore.intel.readLowNever", { n: score, role, t: guide.threshold })}
      {pick ? (
        <button type="button" className="commodore-intel-link" onClick={() => onRaise(pick.effort)}>
          {t("commodore.intel.raise", { effort: effortWord(pick.effort), n: pick.score })}
        </button>
      ) : null}
    </p>
  );
}

/** 선택기 칩의 고리 — 고른 좌표의 점수가 기준 아래일 때만. 점수가 없으면 고리도 없다. */
export function belowGuide(guide: RoleGuide | null, row: ObjectiveLaunchVariantRow | null, effort: string | null | undefined): boolean {
  if (!guide || !row || !effort) return false;
  const score = rowScores(row)[effort];
  return typeof score === "number" && score < guide.threshold;
}
