import { ExperimentalBadge, ModelPicker, SettingsCard, SettingsRow, SettingsToggle, isComputerUseBackendId, useModelPickerOptions } from "@fleet-console/sdk/settings/browser";
import { Select } from "@fleet-console/sdk/react/browser";
import { EXPERIMENT_EFFORTS } from "@fleet-console/sdk/settings/browser";
import type { ConsoleExperimentSettings, ExperimentAideId, ExperimentEffort } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { BACKENDS, ComputerUseRow, useComputerUseStatus } from "./computer-use-row.js";
import { setGlobalSettingsField } from "./global-settings-store.js";
import "./settings-mobile.css";
import { MobileIcon, type MobileIconName } from "../../../core/client/src/chrome/mobile/mobile-icons.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import type { CoreMessageKey } from "../../../core/client/src/i18n/messages/index.js";
import { collectExperimentModelOptions } from "../../../core/client/src/integration/experiment-model-options.js";
import type { GlobalSettingsState } from "../../../core/client/src/integration/types.js";

interface AideRow {
  readonly id: ExperimentAideId;
  readonly titleKey: CoreMessageKey;
  readonly helpKey: CoreMessageKey;
}

/** 항상 켜져 있는 보조 AI — 스위치 없이 모델과 강도만 고른다. 두 컴포저에는 이 좌표를 고르는 자리가 없다. */
const AIDE_ROWS: readonly AideRow[] = [
  { id: "cowork", titleKey: "settings.experiments.cowork.title", helpKey: "settings.experiments.cowork.help" },
  { id: "analyst", titleKey: "settings.experiments.analyst.title", helpKey: "settings.experiments.analyst.help" },
];

export function ExperimentsSection({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  // The phone reads the same experiments through group rows and sheets (S-48): no boxed effort
  // selector, no help chips, no desktop toggle.
  if (useViewMode().effective === "mobile") return <MobileExperiments state={state} saving={saving} />;
  return <DesktopExperiments state={state} saving={saving} />;
}

function DesktopExperiments({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const options = useModelPickerOptions(collectExperimentModelOptions);
  const save = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

  return (
    <section className="global-settings-card" data-saving={saving || undefined} aria-label={t("settings.experiments.aiCard")}>
      <h3 className="global-settings-card-title">
        {t("settings.experiments.aiCard")}
        <ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge>
      </h3>
      {AIDE_ROWS.map((row) => {
        const modelField = `${row.id}Model` as const;
        const effortField = `${row.id}Effort` as const;
        return (
          <div className="global-settings-row experiments-row" key={row.id}>
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t(row.titleKey)}
                <SettingsHelp title={t(row.titleKey)}>{t(row.helpKey)}</SettingsHelp>
              </p>
            </div>
            <div className="experiments-row-controls">
              <ModelPicker
                value={experiments[modelField]}
                options={options}
                disabled={saving}
                label={t("settings.experiments.modelAria", { feature: t(row.titleKey) })}
                onChange={(value) => save({ ...experiments, [modelField]: value })}
                effort={{
                  value: experiments[effortField],
                  levels: EXPERIMENT_EFFORTS,
                  ariaLabel: t("settings.experiments.effortAria", { feature: t(row.titleKey) }),
                  labelOf: (level) => t(`settings.experiments.effort.${level as ExperimentEffort}`),
                  onChange: (next) => save({ ...experiments, [effortField]: next as ExperimentEffort }),
                }}
              />
            </div>
          </div>
        );
      })}
      {/* 자율 운영 — 켬/끔뿐이다. 사령관의 모델·강도는 사이드바 사령관 시트의 설정에서 Theater 마다 고른다. 저장된 commodoreModel·Effort 는
          시트 값이 없을 때의 기본 좌표로 남는다. */}
      <div className="global-settings-row experiments-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("settings.experiments.commodore.title")}
            <SettingsHelp title={t("settings.experiments.commodore.title")}>{t("settings.experiments.commodore.help")}</SettingsHelp>
          </p>
        </div>
        <div className="experiments-row-controls">
          <SettingsToggle
            checked={experiments.commodore}
            busy={saving}
            ariaLabel={t("settings.experiments.commodore.title")}
            onChange={(next) => save({ ...experiments, commodore: next })}
          />
        </div>
      </div>
      <ComputerUseRow enabled={experiments.computerUse} backend={experiments.computerUseBackend} saving={saving} onChange={(computerUse) => save({ ...experiments, computerUse })} onBackendChange={(computerUseBackend) => save({ ...experiments, computerUseBackend, computerUse: false })} />
    </section>
  );
}

const saveExperiments = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

const AIDE_ICONS: Partial<Record<ExperimentAideId, MobileIconName>> = { cowork: "wiki", analyst: "chart" };

/**
 * The phone's experiments (S-48′). Built from the SDK settings parts, which the mobile settings host
 * draws in the mobile grammar: the card becomes a group with its badge, each aide a model popup
 * row, the switches description toggle rows, and the backend a popup row. Help that the desktop
 * keeps behind 「?」 is the row's description here.
 */
function MobileExperiments({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const options = useModelPickerOptions(collectExperimentModelOptions);
  const computerUse = useComputerUseStatus(experiments.computerUse, experiments.computerUseBackend);
  const backend = experiments.computerUseBackend;
  const computerUseReady = computerUse.status?.backend === backend && computerUse.status.supported && !computerUse.unavailable && computerUse.status.installation === "available";
  const computerUseHint = (
    <>
      {t("settings.computerUse.help")}
      {computerUse.status?.installation === "missing" ? <> {t(backend === "cua-driver" ? "settings.computerUse.missing" : "settings.computerUse.skyMissing")}</> : null}
      {computerUse.code ? <span role="alert"> {t(`settings.computerUse.${computerUse.errorKey}`)}</span> : null}
      {backend === "cua-driver" && computerUse.status?.installation === "missing" && computerUse.status.installer?.supported
        ? <> <button type="button" className="settings-mobile-textlink" disabled={computerUse.installing} onClick={(event) => { event.stopPropagation(); void computerUse.install(); }}>{t(computerUse.installing ? "settings.computerUse.installing" : "settings.computerUse.install")}</button></> : null}
      {computerUse.unavailable ? <> <button type="button" className="settings-mobile-textlink" onClick={(event) => { event.stopPropagation(); computerUse.retry(); }}>{t("settings.computerUse.retry")}</button></> : null}
      {computerUse.active ? <> <button type="button" className="settings-mobile-textlink" disabled={computerUse.working || computerUse.status?.state === "stopping"} onClick={(event) => { event.stopPropagation(); void computerUse.stop(); }}>{t("settings.computerUse.stop")}</button></> : null}
    </>
  );
  return (
    <SettingsCard title={<>{t("settings.experiments.aiCard")}<ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge></>}>
      {AIDE_ROWS.map((row) => {
        const modelField = `${row.id}Model` as const;
        const effortField = `${row.id}Effort` as const;
        return (
          <SettingsRow key={row.id} label={t(row.titleKey)} hint={t(row.helpKey)} icon={<MobileIcon name={AIDE_ICONS[row.id] ?? "spark"} />}>
            <ModelPicker
              value={experiments[modelField]}
              options={options}
              disabled={saving}
              label={t("settings.experiments.modelAria", { feature: t(row.titleKey) })}
              onChange={(value) => saveExperiments({ ...experiments, [modelField]: value })}
              effort={{
                value: experiments[effortField],
                levels: EXPERIMENT_EFFORTS,
                ariaLabel: t("settings.experiments.effortAria", { feature: t(row.titleKey) }),
                labelOf: (level) => t(`settings.experiments.effort.${level as ExperimentEffort}`),
                onChange: (next) => saveExperiments({ ...experiments, [effortField]: next as ExperimentEffort }),
              }}
            />
          </SettingsRow>
        );
      })}
      <SettingsRow label={t("settings.experiments.commodore.title")} hint={t("settings.experiments.commodore.help")} icon={<MobileIcon name="target" />}>
        <SettingsToggle
          checked={experiments.commodore}
          busy={saving}
          ariaLabel={t("settings.experiments.commodore.title")}
          onChange={(next) => saveExperiments({ ...experiments, commodore: next })}
        />
      </SettingsRow>
      <SettingsRow label={t("settings.computerUse.title")} hint={computerUseHint} icon={<MobileIcon name="layout" />}>
        <SettingsToggle
          checked={experiments.computerUse}
          busy={saving || computerUse.working}
          disabled={!experiments.computerUse && !computerUseReady}
          ariaLabel={t("settings.computerUse.title")}
          onChange={(next) => saveExperiments({ ...experiments, computerUse: next })}
        />
      </SettingsRow>
      {/* The backend stays selectable while Computer Use is off: the switch only turns on once the
          chosen backend's runtime is available, so locking the choice would leave no way to get there. */}
      <SettingsRow label={t("settings.computerUse.backend")} icon={<MobileIcon name="swap" />}>
        <Select
          value={backend}
          options={BACKENDS}
          disabled={saving || computerUse.working}
          label={t("settings.computerUse.backend")}
          onChange={(next) => { if (isComputerUseBackendId(next) && next !== backend) saveExperiments({ ...experiments, computerUseBackend: next, computerUse: false }); }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
