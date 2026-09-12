import { ExperimentalBadge, ModelPicker, SettingsToggle, useModelPickerOptions } from "@fleet-console/sdk/settings/browser";
import type { ConsoleExperimentSettings, ExperimentModelFeatureId } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../components/settings-help.js";
import { setGlobalSettingsField } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import type { CoreMessageKey } from "../i18n/messages/index.js";
import { collectExperimentModelOptions } from "../experiment-model-options.js";
import type { GlobalSettingsState } from "../types.js";

interface FeatureRow {
  readonly id: ExperimentModelFeatureId;
  readonly titleKey: CoreMessageKey;
  readonly helpKey: CoreMessageKey;
}

/** 「AI 확장」 카드의 행 — 부관의 Console 읽기는 퀘이커 부관단 카드가 자기 행으로 갖는다. */
const FEATURE_ROWS: readonly FeatureRow[] = [
  { id: "promptRefine", titleKey: "settings.experiments.promptRefine.title", helpKey: "settings.experiments.promptRefine.help" },
  { id: "sessionWatch", titleKey: "settings.experiments.sessionWatch.title", helpKey: "settings.experiments.sessionWatch.help" },
];

export function ExperimentsSection({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const options = useModelPickerOptions(collectExperimentModelOptions);
  const save = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

  return (
    <>
    <section className="global-settings-card" aria-label={t("settings.experiments.aiCard")}>
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
    </section>
    {/* 사이드바 카드 — 모델이 없는 실험이라 스위치 하나만 선다. 켜야만 서버가 git을 읽는다. */}
    <section className="global-settings-card" aria-label={t("settings.experiments.sidebarCard")}>
      <h3 className="global-settings-card-title">
        {t("settings.experiments.sidebarCard")}
        <ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge>
      </h3>
      <div className="global-settings-row experiments-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("settings.experiments.operationContext.title")}
            <SettingsHelp title={t("settings.experiments.operationContext.title")}>{t("settings.experiments.operationContext.help")}</SettingsHelp>
          </p>
        </div>
        <div className="experiments-row-controls">
          <SettingsToggle
            checked={experiments.operationContext}
            disabled={saving}
            ariaLabel={t("settings.experiments.operationContext.title")}
            onChange={(next) => save({ ...experiments, operationContext: next })}
          />
        </div>
      </div>
    </section>
    </>
  );
}
