import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import {
  ExperimentalBadge,
  SettingsCard,
  SettingsRow,
  SettingsSlider,
  SettingsToggle,
  defineSettingsSection,
} from "@fleet-console/sdk/settings/browser";

import {
  BIRD_WIDTH_STEP,
  DEFAULT_BIRD_WIDTH,
  MAX_BIRD_WIDTH,
  MIN_BIRD_WIDTH,
} from "./roaming.js";
import { getT } from "./scuttlebutt-catalog.js";
import {
  getScuttlebuttSettings,
  previewAideSize,
  subscribeScuttlebuttSettings,
  writeAideSize,
  writeScuttlebuttSettings,
  type ScuttlebuttAideId,
} from "./settings-store.js";

const AIDES = ["tori", "bori", "dori"] as const;

export const scuttlebuttSettingsSection = defineSettingsSection({
  id: "scuttlebutt",
  title: (locale) => getT(locale)("settings.section.title"),
  group: "work",
  keywords: [
    (locale) => [
      getT(locale)("settings.section.roster"),
      getT(locale)("settings.section.departure"),
      getT(locale)("settings.section.size"),
    ].join(" "),
    "aide quaker tori bori dori mascot bell announce chat size scale figure px",
    "부관 퀘이커 마스코트 알림 대화 크기 조절 슬라이더",
  ],
  render: () => <ScuttlebuttSettingsSection />,
});

function ScuttlebuttSettingsSection() {
  const t = getT(document.documentElement.lang === "ko" ? "ko" : "en");
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const [saving, setSaving] = React.useState(false);
  // 끌기 시작 전의 저장값. 저장이 실패하면 미리보기를 여기로 되돌려야, 화면에 남은 크기와
  // 실제 저장된 크기가 갈리지 않는다.
  const committedRef = React.useRef<Partial<Record<ScuttlebuttAideId, number>>>({});
  const generationRef = React.useRef<Partial<Record<ScuttlebuttAideId, number>>>({});

  const save = async (patch: Parameters<typeof writeScuttlebuttSettings>[0]) => {
    setSaving(true);
    try {
      await writeScuttlebuttSettings(patch);
    } finally {
      setSaving(false);
    }
  };

  // 끌리는 동안에는 저장하지 않고 화면만 바꾼다 — 부관은 설정 화면 위에도 떠 있으므로
  // 그 자리에서 바로 커지고 작아지는 것이 이 컨트롤이 성립하는 이유다.
  const previewSize = (aide: ScuttlebuttAideId, width: number) => {
    if (committedRef.current[aide] === undefined) {
      committedRef.current[aide] = getScuttlebuttSettings().sizes[aide];
      bumpGeneration(aide);
    }
    previewAideSize(aide, width);
  };

  /**
   * 부관마다 세는 조작 세대. 크기 컨트롤은 저장 중에도 잠기지 않으므로(그것이 카드 전역 잠금을
   * 쓰지 않는 이유다) 앞선 저장이 아직 떠 있는 동안 같은 부관을 또 조절할 수 있다. 되돌리기는
   * 그 사이에 더 새로운 조작이 없었을 때만 유효하다.
   */
  const bumpGeneration = (aide: ScuttlebuttAideId): number => {
    const next = (generationRef.current[aide] ?? 0) + 1;
    generationRef.current[aide] = next;
    return next;
  };

  /**
   * 크기 저장은 카드 전역 `saving`을 건드리지 않는다. 그 플래그는 켜져 있는 동안 카드의 모든
   * 토글을 비활성으로 만드는데, 슬라이더가 그것을 쓰면 크기를 한 번 조절할 때마다 출근 스위치
   * 세 개가 함께 잠긴다. 정박 스위치가 이미 채팅 카드에서 같은 이유로 자기 쓰기 경로를 쓴다.
   */
  const commitSize = (aide: ScuttlebuttAideId, width: number) => {
    const revertTo = committedRef.current[aide];
    delete committedRef.current[aide];
    // 한 번의 드래그가 내는 pointerup·blur 중복은 SettingsSlider가 이미 걸러 낸다 — 여기서 또
    // 거르면 같은 규칙을 두 곳이 갖게 되고, 언젠가 한쪽만 바뀐다.
    const generation = bumpGeneration(aide);
    void writeAideSize(aide, width).catch(() => {
      // 이 실패가 났을 때 같은 부관에 더 새로운 조작(다음 저장이든 진행 중인 드래그든)이 이미
      // 올라갔다면 되돌리지 않는다. 옛 실패가 새 값을 덮으면 화면과 저장이 갈린 채로 남는다.
      if (generationRef.current[aide] !== generation) return;
      // 저장이 실패하면 미리보기를 거둔다. 그대로 두면 화면은 새 크기인데 저장된 값은 옛 크기라,
      // 다음 새로고침에 영문 없이 되돌아간다.
      if (revertTo !== undefined) previewAideSize(aide, revertTo);
    });
  };

  const onDuty = AIDES.filter((aide) => settings[aide]);

  return (
    <SettingsCard
      title={
        <>
          {t("settings.section.title")}
          <ExperimentalBadge>{t("settings.section.experimental")}</ExperimentalBadge>
        </>
      }
    >
      <SettingsRow label={t("settings.section.roster")} hint={t("settings.section.rosterHint")}>
        <div className="scuttlebutt-settings-roster">
          {AIDES.map((aide) => (
            <SettingsToggle
              key={aide}
              label={t(`bird.${aide}`)}
              checked={settings[aide]}
              disabled={saving}
              onChange={(enabled) => void save({ [aide]: enabled })}
            />
          ))}
        </div>
      </SettingsRow>
      {/* 근무 중인 부관의 크기만 낸다 — 퇴근한 부관의 슬라이더는 아무것도 바꾸지 않는 줄이다. */}
      {onDuty.length > 0 ? (
        <SettingsRow label={t("settings.section.size")} hint={t("settings.section.sizeHint")}>
          <div className="scuttlebutt-settings-sizes">
            {onDuty.map((aide) => {
              const shown = settings.sizes[aide];
              const name = t(`bird.${aide}`);
              return (
                <div className="scuttlebutt-settings-size" key={aide}>
                  <span className="scuttlebutt-settings-size-name">{name}</span>
                  <SettingsSlider
                    value={shown}
                    min={MIN_BIRD_WIDTH}
                    max={MAX_BIRD_WIDTH}
                    step={BIRD_WIDTH_STEP}
                    label={t("settings.section.sizeAria", { name })}
                    decreaseLabel={t("settings.section.sizeDecrease", { name })}
                    increaseLabel={t("settings.section.sizeIncrease", { name })}
                    formatValue={(value) => `${value}px`}
                    onPreview={(next) => previewSize(aide, next)}
                    onCommit={(next) => commitSize(aide, next)}
                  />
                  {/* 기본값으로 돌아가는 길은 항상 설정 안에 있어야 한다 — 부관 위의 조작면은
                      모달이 열리면 죽고, 화면을 가린 부관은 그때 되돌릴 방법이 없다. */}
                  <button
                    type="button"
                    className="scuttlebutt-settings-size-reset"
                    disabled={shown === DEFAULT_BIRD_WIDTH}
                    title={t("settings.section.sizeReset", { name })}
                    aria-label={t("settings.section.sizeReset", { name })}
                    onClick={() => commitSize(aide, DEFAULT_BIRD_WIDTH)}
                  >
                    {t("settings.section.sizeResetShort")}
                  </button>
                </div>
              );
            })}
          </div>
        </SettingsRow>
      ) : null}
      <SettingsRow label={t("settings.section.departure")} hint={t("settings.section.departureHint")}>
        <SettingsToggle
          label={t("settings.section.departureToggle")}
          checked={settings.departureBell}
          disabled={saving}
          onChange={(enabled) => void save({ departureBell: enabled })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
