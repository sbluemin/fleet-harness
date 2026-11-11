import { ModelCoordinatePicker, rosterCoordinateWords, type ModelCoordinatePickerExtra, type ModelCoordinateValue } from "../../ai-gateway/client/components/model-coordinate-picker.js";
import type { Translate } from "@fleet-console/i18n";
import { isAgentEffort, type ModelRosterTarget } from "../../ai-gateway/shared/models.js";

import { useCommodoreRoster, type useCommodore } from "./commodore-state.js";
import type { CommodoreMessageKey } from "./i18n/index.js";
import { COMMANDER_PRESET } from "../../objectives/shared/types.js";
import { CommodoreJudgmentMark } from "./commodore-judgment-glyph.js";

/**
 * 사령관 설정의 값과 선택기 — 데스크톱 Theater Inbox 의 사령관 「설정」 칸과 폰 사령관 화면이 함께 쓴다.
 */

type T = Translate<CommodoreMessageKey>;
type CommodoreView = NonNullable<ReturnType<typeof useCommodore>["view"]>;

/**
 * 사령관·지휘관 좌표 한 칸 — Console 공유 선택기(설정 행의 선택 상자). 로스터 밖 저장값은 「꺼짐」으로 남아 보이고, 실행만 폴백한다. 폰 설정 화면 안에서는
 * 호스트의 좌표 시트로 열린다. 값이 비면 `fallback`(기본 좌표)을 보이고, `reset`은 그 기본값의 낱말을 설명으로 단다.
 * `judgment`를 넘기면 메뉴 맨 위에 「라우팅」이 서고, 활성이면 트리거도 글리프와 그 낱말이다(`fallback`을 보이지 않는다). 저장값 null은 그대로다.
 */
export function CommodoreCoordinateField({ t, target, label, value, fallback, disabled, reset, judgment, onChange }: {
  readonly t: T;
  readonly target: ModelRosterTarget;
  readonly label: string;
  readonly value: ModelCoordinateValue;
  readonly fallback: ModelCoordinateValue;
  readonly disabled?: boolean;
  readonly reset?: { readonly label: string; readonly onSelect: () => void };
  readonly judgment?: { readonly active: boolean; readonly onPick: () => void };
  readonly onChange: (next: { readonly model?: string; readonly effort?: string; readonly fast?: boolean }) => void;
}) {
  const roster = useCommodoreRoster(target);
  const auto = t("commodore.board.commander.effortAuto");
  const fallbackWords = rosterCoordinateWords(roster, fallback, auto);
  const judgmentLabel = t("commodore.settings.commanderJudgment");
  const judgmentHint = t("commodore.settings.commanderJudgmentHint");
  const extras: readonly ModelCoordinatePickerExtra[] | undefined = judgment
    ? [{ id: "commodore-judgment", label: judgmentLabel, hint: judgmentHint, icon: <CommodoreJudgmentMark />, active: judgment.active, ...(disabled ? { disabled } : {}), onPick: judgment.onPick }]
    : undefined;
  const judgmentActive = judgment?.active === true;
  return (
    <ModelCoordinatePicker
      roster={roster}
      value={value}
      fallback={fallback}
      onChange={onChange}
      startAt="list"
      speed={{ fastLabel: t("commodore.settings.fast") }}
      {...(disabled ? { disabled } : {})}
      {...(reset ? { reset: { ...reset, description: [fallbackWords.model, fallbackWords.effort].filter(Boolean).join(" · ") } } : {})}
      labels={{
        menu: label,
        effort: t("commodore.board.commander.effortAria"),
        auto,
        back: t("commodore.board.launch.backToModels"),
        loading: t("commodore.board.launch.loading"),
        empty: t("commodore.board.launch.empty"),
        off: t("commodore.board.launch.off"),
        providerRemoved: t("commodore.board.launch.providerRemoved"),
        chooseAnotherModel: t("commodore.board.launch.chooseAnotherModel"),
        fallback: t("commodore.board.launch.fallback"),
      }}
      {...(extras ? { extras } : {})}
      trigger={judgmentActive
        ? { variant: "field", title: judgmentHint, text: <><CommodoreJudgmentMark /><span className="fc-coord-trigger-model">{judgmentLabel}</span></> }
        : { variant: "field" }}
    />
  );
}

export type CommodoreStateFields = CommodoreView["state"];

/** 사령관 좌표의 저장값 — 비어 있으면 선택기가 실험 기능 행의 기본값을 보인다. */
export function commodoreValue(state: CommodoreStateFields): ModelCoordinateValue {
  return { ...(state.model ? { model: state.model } : {}), ...(state.effort ? { effort: state.effort } : {}), ...(state.model && typeof state.fast === "boolean" ? { fast: state.fast } : {}) };
}

/**
 * 고른 사령관 좌표 — 모델과 강도를 함께 저장한다. 트랙의 「자동」이나 강도를 받지 않는 모델이면 지금 강도(없으면 실험 기능
 * 행의 강도)를 남긴다: 실행은 행 사다리 안으로 클램프되고, 강도 있는 모델로 돌아오면 그 값이 산다.
 */
export function commodoreCoordinates(state: CommodoreStateFields, defaults: CommodoreView["defaults"], next: { readonly model?: string; readonly effort?: string; readonly fast?: boolean }) {
  const model = next.model ?? state.model ?? defaults.model;
  const effort = isAgentEffort(next.effort) ? next.effort : state.effort ?? defaults.effort;
  // 모델을 고르면 그 선택의 속도로 덮는다(Fast를 받지 않는 모델은 속도를 싣지 않는다).
  const fast = next.model !== undefined ? next.fast : state.fast;
  return { model, effort, ...(typeof fast === "boolean" ? { fast } : {}) };
}

/** 지휘관 좌표의 저장값 — 비어 있으면 「라우팅」이다(AI Gateway가 이 사령관 세션의 모델로 고른다). */
export function commanderValue(state: CommodoreStateFields): ModelCoordinateValue {
  return state.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}), ...(typeof state.commanderFast === "boolean" ? { fast: state.commanderFast } : {}) } : {};
}

export const commanderByJudgment = (state: CommodoreStateFields): boolean => state.commanderModel === undefined;

export function commanderCoordinates(state: CommodoreStateFields, next: { readonly model?: string; readonly effort?: string; readonly fast?: boolean }) {
  const model = next.model ?? state.commanderModel ?? COMMANDER_PRESET.model;
  const effort = next.effort ?? (next.model ? undefined : state.commanderEffort);
  const fast = next.model !== undefined ? next.fast : state.commanderFast;
  return { model, ...(effort ? { effort } : {}), ...(typeof fast === "boolean" ? { fast } : {}) };
}
