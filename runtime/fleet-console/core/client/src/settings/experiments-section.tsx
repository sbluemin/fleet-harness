import { useEffect, useState } from "react";
import { Select } from "@fleet-console/sdk/react/browser";
import { CLAUDE_EXPERIMENT_MODEL_OPTIONS, ExperimentalBadge } from "@fleet-console/sdk/settings/browser";
import type { ConsoleExperimentSettings, ExperimentFeatureId, ExperimentModelFeatureId, ExperimentModelOption } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../components/settings-help.js";
import { setGlobalSettingsField } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import type { CoreMessageKey } from "../i18n/messages/index.js";
import { collectExperimentModelOptions } from "../experiment-model-options.js";
import type { GlobalSettingsState } from "../types.js";
import { SettingsScope, SettingsSwitch } from "./sections.js";

interface FeatureRow {
  readonly id: ExperimentFeatureId;
  readonly titleKey: CoreMessageKey;
  readonly helpKey: CoreMessageKey;
  /** AI를 쓰는 기능만 모델 필드를 갖는다 — 컨텍스트 팩은 검색만 한다. */
  readonly model: ExperimentModelFeatureId | null;
}

/** 「AI 확장」 카드의 행 — 부관의 Console 읽기는 퀘이커 부관단 카드가 자기 행으로 갖는다. */
const FEATURE_ROWS: readonly FeatureRow[] = [
  { id: "promptRefine", titleKey: "settings.experiments.promptRefine.title", helpKey: "settings.experiments.promptRefine.help", model: "promptRefine" },
  { id: "launchContextPack", titleKey: "settings.experiments.launchContextPack.title", helpKey: "settings.experiments.launchContextPack.help", model: null },
  { id: "sessionWatch", titleKey: "settings.experiments.sessionWatch.title", helpKey: "settings.experiments.sessionWatch.help", model: "sessionWatch" },
];

function useExperimentModelOptions(): readonly ExperimentModelOption[] {
  const [options, setOptions] = useState<readonly ExperimentModelOption[]>(CLAUDE_EXPERIMENT_MODEL_OPTIONS);
  useEffect(() => {
    let cancelled = false;
    void collectExperimentModelOptions().then((next) => { if (!cancelled) setOptions(next); });
    return () => { cancelled = true; };
  }, []);
  return options;
}

export function ExperimentsSection({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const options = useExperimentModelOptions();
  const save = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

  return (
    <section className="global-settings-card" aria-label={t("settings.experiments.aiCard")}>
      <h3 className="global-settings-card-title">
        {t("settings.experiments.aiCard")}
        <ExperimentalBadge>{t("settings.experiments.badge")}</ExperimentalBadge>
        <SettingsScope kind="live" />
      </h3>
      {FEATURE_ROWS.map((row) => {
        const enabled = experiments[row.id];
        const modelField = row.model === null ? null : (`${row.model}Model` as const);
        const current = modelField === null ? null : experiments[modelField];
        const known = current === null || options.some((option) => option.id === current);
        const selectOptions = [
          ...options.map((option) => ({ value: option.id, label: option.label })),
          ...(known || current === null ? [] : [{ value: current, label: current }]),
        ];
        return (
          <div className="global-settings-row experiments-row" key={row.id}>
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t(row.titleKey)}
                <SettingsHelp title={t(row.titleKey)}>{t(row.helpKey)}</SettingsHelp>
              </p>
            </div>
            {/* 한 줄: 모델 선택기와 스위치가 오른쪽에 나란히 선다 — 어느 기능의 모델인지는 왼쪽 제목이 말한다. */}
            <div className="experiments-row-controls">
              {modelField !== null && current !== null ? (
                <Select
                  className="experiments-model-select"
                  value={current}
                  options={selectOptions}
                  disabled={saving}
                  label={t("settings.experiments.modelAria", { feature: t(row.titleKey) })}
                  onChange={(value) => save({ ...experiments, [modelField]: value })}
                />
              ) : null}
              <SettingsSwitch
                checked={enabled}
                disabled={saving}
                label={t(row.titleKey)}
                onChange={(next) => save({ ...experiments, [row.id]: next })}
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}
