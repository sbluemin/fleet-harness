import { useEffect, useRef, useState } from "react";

import { ExperimentalBadge, SettingsCard, SettingsRow, SettingsToggle } from "./preferences-context.js";
import { takeTaskforceRowHighlight, useTaskforceRowHighlight } from "./taskforce-highlight.js";
import type { ConsoleExperimentSettings } from "../shared/experiments.js";

import { ComputerUseRow } from "./computer-use-row.js";
import { setGlobalSettingsField } from "./global-settings-store.js";
import "./settings-mobile.css";
import { MobileIcon } from "../../../core/client/src/chrome/mobile/mobile-icons.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import type { GlobalSettingsState } from "../../../core/client/src/integration/types.js";

export function ExperimentsSection({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  // The phone reads the same experiments through group rows and sheets (S-48): no boxed effort
  // selector, no help chips, no desktop toggle.
  if (useViewMode().effective === "mobile") return <MobileExperiments state={state} saving={saving} />;
  return <DesktopExperiments state={state} saving={saving} />;
}

/**
 * 소개 카드의 링크가 가리킨 행의 반짝임 — 요청 토큰이 서면 두 번(1.2초 × 2) 반짝이고 그친다.
 * 토큰은 꺼내 쓰면 지워지므로, 같은 요청이 다시 그려질 때 되살아나지 않는다.
 */
const TASKFORCE_FLASH_MS = 2600;

function useTaskforceRowFlash(): boolean {
  const highlight = useTaskforceRowHighlight();
  const [flash, setFlash] = useState(false);
  // rAF와 타이머는 ref에 둔다 — 토큰 소비가 일으키는 highlight=0 재실행에서는
  // 아무것도 정리하지 않아야 펄스가 시작되고, 새 요청이나 언마운트 때만 지운다.
  const rafRef = useRef(0);
  const timerRef = useRef(0);
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    window.clearTimeout(timerRef.current);
  }, []);
  useEffect(() => {
    if (highlight === 0) return;
    takeTaskforceRowHighlight();
    cancelAnimationFrame(rafRef.current);
    window.clearTimeout(timerRef.current);
    // 새 요청이 겹치면 클래스를 뗐다 붙여 애니메이션을 처음부터 다시 돌린다.
    setFlash(false);
    rafRef.current = requestAnimationFrame(() => {
      setFlash(true);
      timerRef.current = window.setTimeout(() => setFlash(false), TASKFORCE_FLASH_MS);
    });
  }, [highlight]);
  return flash;
}

function DesktopExperiments({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const save = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);
  const taskforceTarget = useTaskforceRowFlash();

  return (
    <>
    <section className="global-settings-card" data-saving={saving || undefined} aria-label={t("settings.experiments.aiCard")}>
      <h3 className="global-settings-card-title">
        {t("settings.experiments.aiCard")}
        <ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge>
      </h3>
      <ComputerUseRow enabled={experiments.computerUse} saving={saving} onChange={(computerUse) => save({ ...experiments, computerUse })} remotePreview={experiments.computerUseRemotePreview} onRemotePreviewChange={(computerUseRemotePreview) => save({ ...experiments, computerUseRemotePreview })} />
      {/* 컴퓨터 사용 행과 같은 틀 — 제목 옆 「?」에 설명을 두고 오른쪽에 토글을 둔다. */}
      <div className={`global-settings-row experiments-row${taskforceTarget ? " is-taskforce-target" : ""}`}>
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("settings.taskforce.title")}
            <SettingsHelp title={t("settings.taskforce.title")}><p>{t("settings.taskforce.help")}</p></SettingsHelp>
          </p>
        </div>
        <div className="experiments-row-controls">
          <SettingsToggle
            checked={experiments.taskforce}
            busy={saving}
            disabled={saving || !experiments.commodore}
            ariaLabel={t("settings.taskforce.title")}
            onChange={(next) => save({ ...experiments, taskforce: next })}
          />
        </div>
      </div>
      <div className="global-settings-row experiments-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("settings.commandBoard.title")}
            <SettingsHelp title={t("settings.commandBoard.title")}><p>{t("settings.commandBoard.help")}</p></SettingsHelp>
          </p>
        </div>
        <div className="experiments-row-controls">
          <SettingsToggle
            checked={experiments.commandBoard}
            busy={saving}
            disabled={saving}
            ariaLabel={t("settings.commandBoard.title")}
            onChange={(next) => save({ ...experiments, commandBoard: next })}
          />
        </div>
      </div>
    </section>
    </>
  );
}

const saveExperiments = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

/**
 * The phone's experiments (S-48′). Built from the SDK settings parts, which the mobile settings host
 * draws in the mobile grammar: the card becomes a group with its badge, the switches description
 * toggle rows. Help that the desktop
 * keeps behind 「?」 is the row's description here.
 */
function MobileExperiments({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  return (
    <>
    <SettingsCard title={<>{t("settings.experiments.aiCard")}<ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge></>}>
      <ComputerUseRow mobile enabled={experiments.computerUse} saving={saving} onChange={(computerUse) => saveExperiments({ ...experiments, computerUse })} remotePreview={experiments.computerUseRemotePreview} onRemotePreviewChange={(computerUseRemotePreview) => saveExperiments({ ...experiments, computerUseRemotePreview })} />
      <SettingsRow label={t("settings.taskforce.title")} hint={t("settings.taskforce.help")} icon={<MobileIcon name="layout" />} disabled={!experiments.commodore}>
        <SettingsToggle
          checked={experiments.taskforce}
          busy={saving}
          disabled={saving || !experiments.commodore}
          ariaLabel={t("settings.taskforce.title")}
          onChange={(next) => saveExperiments({ ...experiments, taskforce: next })}
        />
      </SettingsRow>
      <SettingsRow label={t("settings.commandBoard.title")} hint={t("settings.commandBoard.help")} icon={<MobileIcon name="layout" />}>
        <SettingsToggle
          checked={experiments.commandBoard}
          busy={saving}
          disabled={saving}
          ariaLabel={t("settings.commandBoard.title")}
          onChange={(next) => saveExperiments({ ...experiments, commandBoard: next })}
        />
      </SettingsRow>
    </SettingsCard>
    </>
  );
}
