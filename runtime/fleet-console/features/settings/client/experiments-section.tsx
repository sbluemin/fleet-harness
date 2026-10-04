import { ExperimentalBadge, ModelPicker, SettingsToggle, useModelPickerOptions } from "@fleet-console/sdk/settings/browser";
import { EXPERIMENT_EFFORTS } from "@fleet-console/sdk/settings/browser";
import type { ConsoleExperimentSettings, ExperimentAideId, ExperimentEffort } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { ComputerUseRow } from "./computer-use-row.js";
import { setGlobalSettingsField } from "./global-settings-store.js";
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
