import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import {
  ExperimentalBadge,
  ModelPicker,
  SettingsCard,
  SettingsHelpTip,
  SettingsRow,
  SettingsSlider,
  SettingsToggle,
  defineSettingsSection,
  useMobileSettingsHost,
  useModelPickerOptions,
} from "@fleet-console/sdk/settings/browser";

import { readModelOptions } from "./console-read.js";

import {
  BIRD_WIDTH_STEP,
  DEFAULT_BIRD_WIDTH,
  MAX_BIRD_WIDTH,
  MIN_BIRD_WIDTH,
} from "./roaming.js";
import { getT } from "./scuttlebutt-catalog.js";
import {
  AIDE_EFFORTS,
  getScuttlebuttSettings,
  previewAideSize,
  subscribeScuttlebuttSettings,
  writeAideSize,
  writeScuttlebuttSettings,
  type AideEffort,
  type ScuttlebuttAideId,
} from "./settings-store.js";

const AIDES = ["tori", "bori", "dori"] as const;

export const scuttlebuttSettingsSection = defineSettingsSection({
  id: "scuttlebutt",
  title: (locale) => getT(locale)("settings.section.title"),
  // 실험 그룹 — 자기 칩 없이 코어의 「실험 기능」 페이지 안에 카드로 선다.
  group: "experiments",
  keywords: [
    (locale) => [
      getT(locale)("settings.section.roster"),
      getT(locale)("settings.section.departure"),
      getT(locale)("settings.section.size"),
      getT(locale)("settings.section.model"),
    ].join(" "),
    "aide quaker tori bori dori mascot bell announce chat size scale figure px model effort",
    "부관 퀘이커 마스코트 알림 대화 크기 조절 슬라이더 모델 강도",
  ],
  render: () => <ScuttlebuttSettingsSection />,
});

function ScuttlebuttSettingsSection() {
  const t = getT(document.documentElement.lang === "ko" ? "ko" : "en");
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const [saving, setSaving] = React.useState(false);
  const mobile = useMobileSettingsHost() !== null;

  const save = async (patch: Parameters<typeof writeScuttlebuttSettings>[0]) => {
    setSaving(true);
    try {
      await writeScuttlebuttSettings(patch);
    } catch {
      // 실패한 저장의 화면 복구는 스토어가 진다. 여기서 받아 두지 않으면 호출부가 fire-and-forget
      // 이라 거절이 unhandled rejection으로 새어 나간다.
    } finally {
      setSaving(false);
    }
  };

  // 끌리는 동안에는 저장하지 않고 화면만 바꾼다 — 부관은 설정 화면 위에도 떠 있으므로
  // 그 자리에서 바로 커지고 작아지는 것이 이 컨트롤이 성립하는 이유다. 저장이 실패하면 스토어가
  // 마지막으로 확인된 값으로 되돌리므로, 여기서 따로 기준값을 들고 있지 않는다.
  const previewSize = (aide: ScuttlebuttAideId, width: number) => {
    previewAideSize(aide, width);
  };

  /**
   * 크기 저장은 카드 전역 `saving`을 건드리지 않는다. 그 플래그는 켜져 있는 동안 카드의 모든
   * 토글을 비활성으로 만드는데, 슬라이더가 그것을 쓰면 크기를 한 번 조절할 때마다 출근 스위치
   * 세 개가 함께 잠긴다. 정박 스위치가 이미 채팅 카드에서 같은 이유로 자기 쓰기 경로를 쓴다.
   */
  const commitSize = (aide: ScuttlebuttAideId, width: number) => {
    // 한 번의 드래그가 내는 pointerup·blur 중복은 SettingsSlider가 이미 걸러 낸다.
    // 실패 시 화면 복구도 스토어가 진다 — 미리보기가 섞인 값을 이 자리에서 되돌리려 하면
    // 아직 저장된 적 없는 값을 "저장된 값"으로 착각해 화면과 저장이 갈린다.
    writeAideSize(aide, width).catch(() => undefined);
  };

  const onDuty = AIDES.filter((aide) => settings[aide]);

  // 폰에서는 같은 상태·같은 저장 경로를 모바일 문법(묶음 행·토글 행·라디오 묶음)으로 그린다.
  const sizeSlider = (aide: ScuttlebuttAideId) => {
    const name = t(`bird.${aide}`);
    return (
      <SettingsSlider
        value={settings.sizes[aide]}
        min={MIN_BIRD_WIDTH}
        max={MAX_BIRD_WIDTH}
        step={BIRD_WIDTH_STEP}
        label={t("settings.section.sizeAria", { name })}
        decreaseLabel={t("settings.section.sizeDecrease", { name })}
        increaseLabel={t("settings.section.sizeIncrease", { name })}
        formatValue={(value) => `${value}px`}
        onPreview={(next) => previewSize(aide, next)}
        onCommit={(next) => commitSize(aide, next)}
        /* 기본값으로 돌아가는 길은 항상 설정 안에 있어야 한다 — 부관 위의 조작면은
           모달이 열리면 죽고, 화면을 가린 부관은 그때 되돌릴 방법이 없다. */
        defaultValue={DEFAULT_BIRD_WIDTH}
        resetLabel={t("settings.section.sizeResetShort")}
        resetAriaLabel={t("settings.section.sizeReset", { name })}
      />
    );
  };
  const title = (
    <>
      {t("settings.section.title")}
      <ExperimentalBadge>{t("settings.section.experimental")}</ExperimentalBadge>
    </>
  );

  // 폰: SDK 설정 키트가 모바일 문법으로 그린다. 데스크톱의 복수 선택 세그먼트만 키트에 없어, 부관마다 토글 행으로 세우고
  // 크기도 부관마다 슬라이더 행 하나로 나눈다. 도움말(「?」)은 묶음 아래 설명이 된다. 상태·저장은 데스크톱과 같다.
  if (mobile) {
    return (
      <>
        <SettingsCard title={title} description={t("settings.section.rosterHint")}>
          {AIDES.map((aide) => (
            <SettingsRow key={aide} label={t(`bird.${aide}`)}>
              <SettingsToggle ariaLabel={t(`bird.${aide}`)} checked={settings[aide]} busy={saving} onChange={(next) => void save({ [aide]: next })} />
            </SettingsRow>
          ))}
        </SettingsCard>
        {onDuty.length > 0 ? (
          <SettingsCard title={t("settings.section.size")} description={t("settings.section.sizeHint")}>
            {onDuty.map((aide) => <SettingsRow key={aide} label={t(`bird.${aide}`)}>{sizeSlider(aide)}</SettingsRow>)}
          </SettingsCard>
        ) : null}
        <SettingsCard>
          <ModelRow t={t} saving={saving} model={settings.model} effort={settings.effort} onSave={save} />
          <DepartureRow t={t} saving={saving} checked={settings.departureBell} onSave={save} />
        </SettingsCard>
      </>
    );
  }

  return (
    <SettingsCard title={title}>
      <SettingsRow
        label={t("settings.section.roster")}
        helpTip={
          <SettingsHelpTip ariaLabel={t("settings.helpTipAria", { title: t("settings.section.roster") })}>
            {t("settings.section.rosterHint")}
          </SettingsHelpTip>
        }
      >
        {/* 복수 선택 — 스위치 세 개 대신 누른 만큼 켜지는 세그먼트 한 줄. 코어의 선택 문법(.segmented)을
            그대로 입되 미끄러지는 썸 없이 각 옵션이 자기 face를 세운다. aria-pressed가 상태이고 색은 위치 채널이다. */}
        <div className="segmented is-multi" role="group" aria-label={t("settings.section.roster")}>
          {AIDES.map((aide) => (
            <button
              key={aide}
              type="button"
              className={`segmented-option ${settings[aide] ? "is-active" : ""}`}
              aria-pressed={settings[aide]}
              disabled={saving}
              onClick={() => void save({ [aide]: !settings[aide] })}
            >
              {t(`bird.${aide}`)}
            </button>
          ))}
        </div>
      </SettingsRow>
      {/* 근무 중인 부관의 크기만 낸다 — 퇴근한 부관의 슬라이더는 아무것도 바꾸지 않는 줄이다. */}
      {onDuty.length > 0 ? (
        <SettingsRow
          label={t("settings.section.size")}
          helpTip={
            <SettingsHelpTip ariaLabel={t("settings.helpTipAria", { title: t("settings.section.size") })}>
              {t("settings.section.sizeHint")}
            </SettingsHelpTip>
          }
        >
          <div className="scuttlebutt-settings-sizes">
            {onDuty.map((aide) => {
              return (
                <div className="scuttlebutt-settings-size" key={aide}>
                  <span className="scuttlebutt-settings-size-name">{t(`bird.${aide}`)}</span>
                  {sizeSlider(aide)}
                </div>
              );
            })}
          </div>
        </SettingsRow>
      ) : null}
      <ModelRow t={t} saving={saving} model={settings.model} effort={settings.effort} onSave={save} />
      <DepartureRow t={t} saving={saving} checked={settings.departureBell} onSave={save} />
    </SettingsCard>
  );
}

/**
 * 부관단 공통 모델·강도. 실험 페이지의 규약 — 모델을 쓰는 기능은 자기 선택기를 갖는다 — 를
 * 이 카드도 따른다. 부관마다 다르게 두지 않는다: 셋의 정체성은 목소리이지 모델이 아니다.
 */
function ModelRow({ t, saving, model, effort, onSave }: {
  readonly t: ReturnType<typeof getT>;
  readonly saving: boolean;
  readonly model: string;
  readonly effort: AideEffort;
  readonly onSave: (patch: Parameters<typeof writeScuttlebuttSettings>[0]) => Promise<void>;
}) {
  const options = useModelPickerOptions(readModelOptions);
  return (
    <SettingsRow
      label={t("settings.section.model")}
      helpTip={
        <SettingsHelpTip ariaLabel={t("settings.helpTipAria", { title: t("settings.section.model") })}>
          {t("settings.section.modelHint")}
        </SettingsHelpTip>
      }
    >
      <ModelPicker
        value={model}
        options={options}
        disabled={saving}
        label={t("settings.section.modelAria")}
        onChange={(next) => void onSave({ model: next })}
        effort={{
          value: effort,
          levels: AIDE_EFFORTS,
          ariaLabel: t("settings.section.effortAria"),
          labelOf: (level) => t(`effort.${level as AideEffort}`),
          onChange: (next) => void onSave({ effort: next as AideEffort }),
        }}
      />
    </SettingsRow>
  );
}

function DepartureRow({ t, saving, checked, onSave }: {
  readonly t: ReturnType<typeof getT>;
  readonly saving: boolean;
  readonly checked: boolean;
  readonly onSave: (patch: Parameters<typeof writeScuttlebuttSettings>[0]) => Promise<void>;
}) {
  return (
    <SettingsRow
      label={t("settings.section.departure")}
      helpTip={
        <SettingsHelpTip ariaLabel={t("settings.helpTipAria", { title: t("settings.section.departure") })}>
          {t("settings.section.departureHint")}
        </SettingsHelpTip>
      }
    >
      <SettingsToggle
        ariaLabel={t("settings.section.departureToggle")}
        checked={checked}
        busy={saving}
        onChange={(enabled) => void onSave({ departureBell: enabled })}
      />
    </SettingsRow>
  );
}
