import { ModelCoordinatePicker, rosterCoordinateWords, type ModelCoordinateValue } from "@fleet-console/sdk/components/model-coordinate-picker";
import type { Translate } from "@fleet-console/sdk/i18n";
import { isAgentEffort, type ModelRosterTarget } from "@fleet-console/sdk/models";

import type { CommodorePatrolMinutes } from "../server/commodore/types.js";
import { useCommodoreRoster, type useCommodore } from "./commodore-state.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { DEFAULT_LAUNCH, useScopedModels } from "./launch-control.js";

/**
 * 사령관 설정의 값과 선택기 — 데스크톱 Theater Inbox 의 사령관 「설정」 칸과 폰 사령관 화면이 함께 쓴다.
 */

type T = Translate<ObjectiveMessageKey>;
type CommodoreView = NonNullable<ReturnType<typeof useCommodore>["view"]>;

/** 순찰 간격 사다리 — 서버 `COMMODORE_PATROL_MINUTES` 와 같다(서버 모듈은 브라우저 번들에 싣지 않는다). */
export const PATROL_STEPS: readonly CommodorePatrolMinutes[] = [15, 30, 60, 120, 240, 480];
export const DEFAULT_PATROL: CommodorePatrolMinutes = 60;

/**
 * 사령관·지휘관 좌표 한 칸 — Console 공유 선택기(설정 행의 선택 상자). 사령관 세션은 `agent` 대상이라 ULTRACODE가 서지 않고,
 * 지휘관은 Agent CLI 실행 대상이라 선다. 로스터 밖 저장값은 「꺼짐」으로 남아 보이고, 실행만 폴백한다. 폰 설정 화면 안에서는
 * 호스트의 좌표 시트로 열린다. 값이 비면 `fallback`(기본 좌표)을 보이고, `reset`은 그 기본값의 낱말을 설명으로 단다.
 */
export function CommodoreCoordinateField({ t, target, label, value, fallback, disabled, reset, onChange }: {
  readonly t: T;
  readonly target: ModelRosterTarget;
  readonly label: string;
  readonly value: ModelCoordinateValue;
  readonly fallback: ModelCoordinateValue;
  readonly disabled?: boolean;
  readonly reset?: { readonly label: string; readonly onSelect: () => void };
  readonly onChange: (next: { readonly model?: string; readonly effort?: string }) => void;
}) {
  const roster = useCommodoreRoster(target, useScopedModels());
  const auto = t("objectives.commander.effortAuto");
  const fallbackWords = rosterCoordinateWords(roster, fallback, auto);
  return (
    <ModelCoordinatePicker
      roster={roster}
      value={value}
      fallback={fallback}
      onChange={onChange}
      startAt="list"
      {...(disabled ? { disabled } : {})}
      {...(reset ? { reset: { ...reset, description: [fallbackWords.model, fallbackWords.effort].filter(Boolean).join(" · ") } } : {})}
      labels={{
        menu: label,
        effort: t("objectives.commander.effortAria"),
        auto,
        back: t("objectives.launch.backToModels"),
        loading: t("objectives.launch.loading"),
        empty: t("objectives.launch.empty"),
        off: t("objectives.launch.off"),
        fallback: t("objectives.launch.fallback"),
      }}
      trigger={{ variant: "field" }}
    />
  );
}

export type CommodoreStateFields = CommodoreView["state"];

/** 사령관 좌표의 저장값 — 비어 있으면 선택기가 실험 기능 행의 기본값을 보인다. */
export function commodoreValue(state: CommodoreStateFields): ModelCoordinateValue {
  return { ...(state.model ? { model: state.model } : {}), ...(state.effort ? { effort: state.effort } : {}) };
}

/**
 * 고른 사령관 좌표 — 모델과 강도를 함께 저장한다. 트랙의 「자동」이나 강도를 받지 않는 모델이면 지금 강도(없으면 실험 기능
 * 행의 강도)를 남긴다: 실행은 행 사다리 안으로 클램프되고, 강도 있는 모델로 돌아오면 그 값이 산다.
 */
export function commodoreCoordinates(state: CommodoreStateFields, defaults: CommodoreView["defaults"], next: { readonly model?: string; readonly effort?: string }) {
  const model = next.model ?? state.model ?? defaults.model;
  const effort = isAgentEffort(next.effort) ? next.effort : state.effort ?? defaults.effort;
  return { model, effort };
}

/** 지휘관 좌표의 저장값 — 비어 있으면 선택기가 보드 기본값(DEFAULT_LAUNCH)을 보인다. */
export function commanderValue(state: CommodoreStateFields): ModelCoordinateValue {
  return state.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}) } : {};
}

export function commanderCoordinates(state: CommodoreStateFields, next: { readonly model?: string; readonly effort?: string }) {
  const model = next.model ?? state.commanderModel ?? DEFAULT_LAUNCH.model;
  const effort = next.effort ?? (next.model ? undefined : state.commanderEffort);
  return { model, ...(effort ? { effort } : {}) };
}

/* ── 순찰 간격 ───────────────────────────────────────────────────────── */

export function patrolWord(t: T, minutes: number): string {
  if (minutes < 60) return t("objectives.commodore.patrol.minutes", { n: minutes });
  return minutes === 60 ? t("objectives.commodore.patrol.hour") : t("objectives.commodore.patrol.hours", { n: minutes / 60 });
}
