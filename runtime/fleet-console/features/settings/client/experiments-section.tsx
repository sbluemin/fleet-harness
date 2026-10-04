import { ExperimentalBadge, ModelPicker, SettingsToggle, useModelPickerOptions } from "@fleet-console/sdk/settings/browser";
import { EXPERIMENT_EFFORTS } from "@fleet-console/sdk/settings/browser";
import type { ConsoleExperimentSettings, ExperimentAideId, ExperimentEffort } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import type { ComputerUseBackendId } from "@fleet-console/sdk/settings";
import { ComputerUseGlyph } from "./computer-use-glyph.js";
import { BACKENDS, ComputerUseRow, useComputerUseStatus } from "./computer-use-row.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "./global-settings-store.js";
import { MobileGroupLabel, MobileRadioRow, MobileToggleRow } from "./settings-mobile.js";
import { MobileIcon } from "../../../core/client/src/chrome/mobile/mobile-icons.js";
import { MobileSheet } from "../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { pushMobileSheet } from "../../../core/client/src/chrome/mobile/mobile-store.js";
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

function MobileExperiments({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const options = useModelPickerOptions(collectExperimentModelOptions);
  const computerUse = useComputerUseStatus(experiments.computerUse, experiments.computerUseBackend);
  const backend = BACKENDS.find((option) => option.value === experiments.computerUseBackend)?.label ?? experiments.computerUseBackend;
  const computerUseReady = computerUse.status?.backend === experiments.computerUseBackend && computerUse.status.supported && !computerUse.unavailable && computerUse.status.installation === "available";
  const computerUseSub = computerUse.status?.installation === "missing" ? t("settings.computerUse.missingLabel")
    : computerUse.unavailable ? t("settings.computerUse.connectionFailed")
      : t("settings.computerUse.short");
  return (
    <>
      <div className="mobile-group is-flush" aria-label={t("settings.experiments.aiCard")}>
        {AIDE_ROWS.map((row) => {
          const model = experiments[`${row.id}Model` as const];
          const effort = experiments[`${row.id}Effort` as const];
          const modelLabel = options.find((option) => option.id === model)?.label ?? model;
          return (
            <button type="button" className="mobile-group-row is-two" key={row.id} onClick={() => pushMobileSheet({ kind: "custom", render: (close) => <AideSheet aide={row} onClose={close} /> })}>
              <span className="mobile-group-row-copy">{t(row.titleKey)}<small>{modelLabel} · {t(`settings.experiments.effort.${effort}`)}</small></span>
              <MobileIcon name="right" size={18} className="settings-mobile-caret" />
            </button>
          );
        })}
        <MobileToggleRow
          title={t("settings.experiments.commodore.title")}
          sub={t("settings.experiments.commodore.short")}
          checked={experiments.commodore}
          busy={saving}
          onChange={(next) => saveExperiments({ ...experiments, commodore: next })}
        />
        <MobileToggleRow
          title={t("settings.computerUse.title")}
          sub={computerUseSub}
          checked={experiments.computerUse}
          busy={saving || computerUse.working}
          disabled={!experiments.computerUse && !computerUseReady}
          onChange={(next) => saveExperiments({ ...experiments, computerUse: next })}
        />
        <button type="button" className="mobile-group-row is-two" onClick={() => pushMobileSheet({ kind: "custom", render: (close) => <ComputerUseSheet onClose={close} /> })}>
          <span className="mobile-group-row-copy">{t("settings.computerUse.backend")}<small>{backend}</small></span>
          <MobileIcon name="right" size={18} className="settings-mobile-caret" />
        </button>
      </div>
      {computerUse.code ? <p className="settings-mobile-alert" role="alert">{t(`settings.computerUse.${computerUse.errorKey}`)}</p> : null}
    </>
  );
}

/** The model and effort of one always-on aide. The sheet reads the store, so a pick shows at once. */
function AideSheet({ aide, onClose }: { readonly aide: AideRow; readonly onClose: () => void }) {
  const t = useT();
  const state = useGlobalSettingsStore().state;
  const options = useModelPickerOptions(collectExperimentModelOptions);
  if (state === null) return null;
  const experiments = state.experiments;
  const modelField = `${aide.id}Model` as const;
  const effortField = `${aide.id}Effort` as const;
  const value = experiments[modelField];
  const listed = options.some((option) => option.id === value) || value === "" ? options : [...options, { id: value, label: value }];
  return (
    <MobileSheet title={t(aide.titleKey)} onClose={onClose}>
      <div className="mobile-group settings-mobile-card" role="radiogroup" aria-label={t("settings.experiments.modelAria", { feature: t(aide.titleKey) })}>
        {listed.map((option) => (
          <MobileRadioRow key={option.id} checked={option.id === value} label={option.label} onSelect={() => saveExperiments({ ...experiments, [modelField]: option.id })} />
        ))}
      </div>
      <MobileGroupLabel>{t("chrome.quickLaunch.mobile.effort")}</MobileGroupLabel>
      <div className="mobile-group settings-mobile-card" role="radiogroup" aria-label={t("settings.experiments.effortAria", { feature: t(aide.titleKey) })}>
        {EXPERIMENT_EFFORTS.map((level) => (
          <MobileRadioRow key={level} checked={experiments[effortField] === level} label={t(`settings.experiments.effort.${level as ExperimentEffort}`)} onSelect={() => saveExperiments({ ...experiments, [effortField]: level as ExperimentEffort })} />
        ))}
      </div>
      <p className="settings-mobile-note">{t(aide.helpKey)}</p>
    </MobileSheet>
  );
}

/** Backend choice and the runtime's own actions, which the desktop row keeps beside its toggle. */
function ComputerUseSheet({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const state = useGlobalSettingsStore().state;
  const experiments = state?.experiments;
  const computerUse = useComputerUseStatus(experiments?.computerUse ?? false, experiments?.computerUseBackend ?? "sky-computer-use");
  if (!experiments) return null;
  const backend = experiments.computerUseBackend;
  const choose = (next: ComputerUseBackendId) => { if (next !== backend) saveExperiments({ ...experiments, computerUseBackend: next, computerUse: false }); };
  return (
    <MobileSheet title={t("settings.computerUse.title")} onClose={onClose}>
      <div className="mobile-group settings-mobile-card" role="radiogroup" aria-label={t("settings.computerUse.backend")}>
        {BACKENDS.map((option) => (
          <MobileRadioRow
            key={option.value}
            checked={option.value === backend}
            label={option.label}
            lead={<span className="settings-mobile-glyph" aria-hidden="true"><ComputerUseGlyph backend={option.value as ComputerUseBackendId} /></span>}
            onSelect={() => choose(option.value as ComputerUseBackendId)}
          />
        ))}
      </div>
      <div className="settings-mobile-actions">
        {backend === "cua-driver" && computerUse.status?.installation === "missing" && computerUse.status.installer?.supported
          ? <button type="button" className="mobile-pill-secondary" disabled={computerUse.installing} onClick={() => void computerUse.install()}>{t(computerUse.installing ? "settings.computerUse.installing" : "settings.computerUse.install")}</button> : null}
        {computerUse.unavailable ? <button type="button" className="mobile-pill-secondary" onClick={computerUse.retry}>{t("settings.computerUse.retry")}</button> : null}
        {computerUse.active ? <button type="button" className="mobile-pill-secondary" disabled={computerUse.working || computerUse.status?.state === "stopping"} onClick={() => void computerUse.stop()}>{t("settings.computerUse.stop")}</button> : null}
      </div>
      {computerUse.code ? <p className="settings-mobile-alert" role="alert">{t(`settings.computerUse.${computerUse.errorKey}`)}</p> : null}
      <p className="settings-mobile-note">{t("settings.computerUse.help")}</p>
      {computerUse.status?.installation === "missing" ? <p className="settings-mobile-note">{t(backend === "cua-driver" ? "settings.computerUse.missing" : "settings.computerUse.skyMissing")}</p> : null}
    </MobileSheet>
  );
}
