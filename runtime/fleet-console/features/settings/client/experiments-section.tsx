import { ExperimentalBadge, ModelPicker, SettingsToggle, useModelPickerOptions } from "@fleet-console/sdk/settings/browser";
import { EXPERIMENT_EFFORTS } from "@fleet-console/sdk/settings/browser";
import type { ConsoleExperimentSettings, ExperimentAideId, ExperimentEffort, ExperimentModelFeatureId } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { ComputerUseRow } from "./computer-use-row.js";
import { setGlobalSettingsField } from "./global-settings-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import type { CoreMessageKey } from "../../../core/client/src/i18n/messages/index.js";
import { collectExperimentModelOptions } from "../../../core/client/src/integration/experiment-model-options.js";
import type { GlobalSettingsState } from "../../../core/client/src/integration/types.js";

interface FeatureRow {
  readonly id: ExperimentModelFeatureId;
  readonly titleKey: CoreMessageKey;
  readonly helpKey: CoreMessageKey;
}

/** 「AI 확장」 카드에서 별도 모델을 고르는 기능. */
const FEATURE_ROWS: readonly FeatureRow[] = [
  { id: "promptRefine", titleKey: "settings.experiments.promptRefine.title", helpKey: "settings.experiments.promptRefine.help" },
  { id: "sessionWatch", titleKey: "settings.experiments.sessionWatch.title", helpKey: "settings.experiments.sessionWatch.help" },
];

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
      {FEATURE_ROWS.map((row) => {
        const enabled = experiments[row.id];
        const modelField = `${row.id}Model` as const;
        const current = experiments[modelField];
        return (
          <div className="global-settings-row experiments-row" key={row.id}>
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t(row.titleKey)}
                <SettingsHelp title={t(row.titleKey)}>{t(row.helpKey)}</SettingsHelp>
              </p>
            </div>
            {/* 한 줄: 모델 선택기와 스위치가 오른쪽에 나란히 선다 — 어느 기능의 모델인지는 왼쪽 제목이 말한다.
                스위치가 행 제목을 이름으로 쓰므로 선택기는 "{기능} 모델"로 구별해 이름 짓는다. */}
            <div className="experiments-row-controls">
              <ModelPicker
                value={current}
                options={options}
                disabled={saving}
                label={t("settings.experiments.modelAria", { feature: t(row.titleKey) })}
                onChange={(value) => save({ ...experiments, [modelField]: value })}
              />
              <SettingsToggle
                checked={enabled}
                disabled={saving}
                ariaLabel={t(row.titleKey)}
                onChange={(next) => save({ ...experiments, [row.id]: next })}
              />
            </div>
          </div>
        );
      })}
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
      <ComputerUseRow enabled={experiments.computerUse} backend={experiments.computerUseBackend} saving={saving} onChange={(computerUse) => save({ ...experiments, computerUse })} onBackendChange={(computerUseBackend) => save({ ...experiments, computerUseBackend, computerUse: false })} />
    </section>
  );
}
