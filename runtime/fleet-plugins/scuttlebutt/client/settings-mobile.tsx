import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import { readMobileScheme, subscribeMobileScheme } from "@fleet-console/sdk/settings/mobile-scheme";
import { useModelPickerOptions } from "@fleet-console/sdk/settings/browser";

import { readModelOptions } from "./console-read.js";
import { BIRD_WIDTH_STEP, DEFAULT_BIRD_WIDTH, MAX_BIRD_WIDTH, MIN_BIRD_WIDTH } from "./roaming.js";
import type { getT } from "./scuttlebutt-catalog.js";
import { AIDE_EFFORTS, previewAideSize, writeAideSize, writeScuttlebuttSettings, type AideEffort, type ScuttlebuttAideId, type ScuttlebuttSettings } from "./settings-store.js";
import "./settings-mobile.css";

/**
 * 폰(모바일 배치)의 「퀘이커 부관단」 카드 — 설정 상세의 모바일 문법(impl-spec S-02·S-48): 묶음 머리, 이름 + 보조 줄 +
 * 44×26 토글 행, 라디오 묶음. 박스형 선택기·「?」 칩·데스크톱 토글·슬라이더는 쓰지 않는다. 상태와 저장 경로는
 * 데스크톱 카드와 같다(같은 스토어·같은 쓰기 함수).
 *
 * 플러그인은 코어의 모바일 시트를 쓸 수 없어(경계) 모델·강도는 시트 대신 같은 카드 안의 라디오 묶음으로 선다.
 */

type T = ReturnType<typeof getT>;
type Save = (patch: Parameters<typeof writeScuttlebuttSettings>[0]) => Promise<void>;

const AIDES: readonly ScuttlebuttAideId[] = ["tori", "bori", "dori"];

const isMobileLayout = () => readMobileScheme() !== null;
const subscribeLayout = (listener: () => void) => subscribeMobileScheme(() => listener());

/** 지금 모바일 배치인가 — SDK의 공개 신호(`data-view-mode`·`data-mobile-scheme`)를 따른다. */
export function useMobileLayout(): boolean {
  return useStoreSnapshot(subscribeLayout, isMobileLayout);
}

function Switch({ checked, busy, label, onChange }: { readonly checked: boolean; readonly busy: boolean; readonly label: string; readonly onChange: (next: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={busy} className={`scuttlebutt-m-switch${checked ? " is-on" : ""}`} onClick={(event) => { event.stopPropagation(); onChange(!checked); }}>
      <i aria-hidden="true" />
    </button>
  );
}

/** 행 전체가 토글을 뒤집는다 — 표적은 44px 손잡이가 아니라 행이다. */
function ToggleRow({ title, sub, checked, busy, onChange }: { readonly title: string; readonly sub?: string; readonly checked: boolean; readonly busy: boolean; readonly onChange: (next: boolean) => void }) {
  return (
    <div className={`scuttlebutt-m-row${sub ? " is-two" : ""}`} onClick={() => { if (!busy) onChange(!checked); }}>
      <span className="scuttlebutt-m-copy">{title}{sub ? <small>{sub}</small> : null}</span>
      <Switch checked={checked} busy={busy} label={title} onChange={onChange} />
    </div>
  );
}

function RadioRow({ checked, label, busy, onSelect }: { readonly checked: boolean; readonly label: string; readonly busy: boolean; readonly onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} disabled={busy} className="scuttlebutt-m-row" onClick={onSelect}>
      <span className={`scuttlebutt-m-radio${checked ? " is-on" : ""}`} aria-hidden="true" />
      <span className="scuttlebutt-m-copy">{label}</span>
    </button>
  );
}

export function MobileScuttlebuttSettings({ t, settings, saving, save }: { readonly t: T; readonly settings: ScuttlebuttSettings; readonly saving: boolean; readonly save: Save }) {
  const options = useModelPickerOptions(readModelOptions);
  const listed = options.some((option) => option.id === settings.model) || settings.model === ""
    ? options
    : [...options, { id: settings.model, label: settings.model }];
  const onDuty = AIDES.filter((aide) => settings[aide]);
  // 크기는 데스크톱 슬라이더와 같은 단계·같은 범위로 움직이고, 저장도 같은 쓰기(writeAideSize)를 쓴다.
  // 화면 미리보기는 떠 있는 부관이 그 자리에서 커지고 작아지게 한다(데스크톱 슬라이더와 같은 계약).
  const resize = (aide: ScuttlebuttAideId, width: number) => {
    const next = Math.min(MAX_BIRD_WIDTH, Math.max(MIN_BIRD_WIDTH, width));
    previewAideSize(aide, next);
    writeAideSize(aide, next).catch(() => undefined);
  };
  return (
    <section className="scuttlebutt-m" aria-label={t("settings.section.title")}>
      <p className="scuttlebutt-m-glab">{t("settings.section.title")}</p>
      <div className="scuttlebutt-m-grp" role="group" aria-label={t("settings.section.roster")}>
        {AIDES.map((aide) => (
          <ToggleRow key={aide} title={t(`bird.${aide}`)} checked={settings[aide]} busy={saving} onChange={(next) => void save({ [aide]: next })} />
        ))}
      </div>
      <p className="scuttlebutt-m-note">{t("settings.section.rosterHint")}</p>

      {onDuty.length > 0 ? (
        <>
          <p className="scuttlebutt-m-glab">{t("settings.section.size")}</p>
          <div className="scuttlebutt-m-grp">
            {onDuty.map((aide) => {
              const name = t(`bird.${aide}`);
              const width = settings.sizes[aide];
              return (
                <div key={aide} className="scuttlebutt-m-row is-two">
                  <span className="scuttlebutt-m-copy">{name}<small>{width}px</small></span>
                  <span className="scuttlebutt-m-steps">
                    <button type="button" className="scuttlebutt-m-pill" aria-label={t("settings.section.sizeDecrease", { name })} disabled={width <= MIN_BIRD_WIDTH} onClick={() => resize(aide, width - BIRD_WIDTH_STEP)}>−</button>
                    <button type="button" className="scuttlebutt-m-pill" aria-label={t("settings.section.sizeIncrease", { name })} disabled={width >= MAX_BIRD_WIDTH} onClick={() => resize(aide, width + BIRD_WIDTH_STEP)}>+</button>
                    <button type="button" className="scuttlebutt-m-pill" aria-label={t("settings.section.sizeReset", { name })} disabled={width === DEFAULT_BIRD_WIDTH} onClick={() => resize(aide, DEFAULT_BIRD_WIDTH)}>{t("settings.section.sizeResetShort")}</button>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="scuttlebutt-m-note">{t("settings.section.sizeHint")}</p>
        </>
      ) : null}

      <p className="scuttlebutt-m-glab">{t("settings.section.model")}</p>
      <div className="scuttlebutt-m-grp" role="radiogroup" aria-label={t("settings.section.modelAria")}>
        {listed.map((option) => (
          <RadioRow key={option.id} checked={option.id === settings.model} label={option.label} busy={saving} onSelect={() => void save({ model: option.id })} />
        ))}
      </div>
      <div className="scuttlebutt-m-grp" role="radiogroup" aria-label={t("settings.section.effortAria")}>
        {AIDE_EFFORTS.map((level) => (
          <RadioRow key={level} checked={settings.effort === level} label={t(`effort.${level as AideEffort}`)} busy={saving} onSelect={() => void save({ effort: level })} />
        ))}
      </div>
      <p className="scuttlebutt-m-note">{t("settings.section.modelHint")}</p>

      <div className="scuttlebutt-m-grp">
        <ToggleRow title={t("settings.section.departure")} sub={t("settings.section.departureHint")} checked={settings.departureBell} busy={saving} onChange={(next) => void save({ departureBell: next })} />
      </div>
    </section>
  );
}

