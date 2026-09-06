import { useEffect, useMemo, useState } from "react";
import { Select } from "@fleet-console/sdk/react/browser";
import { CLAUDE_EXPERIMENT_MODEL_OPTIONS, ExperimentalBadge } from "@fleet-console/sdk/settings/browser";
import type { ConsoleExperimentSettings, ExperimentFeatureId, ExperimentModelFeatureId, ExperimentModelOption } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../components/settings-help.js";
import { setGlobalSettingsField } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import type { CoreMessageKey } from "../i18n/messages/index.js";
import { usePluginRegistry } from "../plugin-registry.js";
import type { GlobalSettingsState } from "../types.js";
import { SettingsScope, SettingsSwitch } from "./sections.js";

interface FeatureRow {
  readonly id: ExperimentFeatureId;
  readonly titleKey: CoreMessageKey;
  readonly helpKey: CoreMessageKey;
  /** AI를 쓰는 기능만 모델 필드를 갖는다 — 컨텍스트 팩은 검색만 한다. */
  readonly model: ExperimentModelFeatureId | null;
}

const FEATURE_ROWS: readonly FeatureRow[] = [
  { id: "promptRefine", titleKey: "settings.experiments.promptRefine.title", helpKey: "settings.experiments.promptRefine.help", model: "promptRefine" },
  { id: "launchContextPack", titleKey: "settings.experiments.launchContextPack.title", helpKey: "settings.experiments.launchContextPack.help", model: null },
  { id: "sessionWatch", titleKey: "settings.experiments.sessionWatch.title", helpKey: "settings.experiments.sessionWatch.help", model: "sessionWatch" },
  { id: "aideConsoleRead", titleKey: "settings.experiments.aideConsoleRead.title", helpKey: "settings.experiments.aideConsoleRead.help", model: "aideConsoleRead" },
];

/**
 * 모델 선택지는 Claude 별칭 + 플러그인이 내놓는 Gateway 모델이다. 플러그인 응답이 늦거나 실패해도
 * 별칭은 항상 서므로 화면은 비지 않는다. 저장된 값이 목록에 없으면(공급자를 껐거나 로스터가
 * 바뀜) 그 값을 그대로 한 줄 더 세워 "무엇이 저장돼 있는지"를 숨기지 않는다.
 */
function useExperimentModelOptions(): readonly ExperimentModelOption[] {
  const registry = usePluginRegistry();
  const [pluginOptions, setPluginOptions] = useState<readonly ExperimentModelOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    const providers = registry.plugins.flatMap((plugin) => plugin.experimentModelOptions ? [plugin.experimentModelOptions] : []);
    void Promise.all(providers.map((provider) => provider().catch(() => [] as readonly ExperimentModelOption[])))
      .then((lists) => { if (!cancelled) setPluginOptions(lists.flat()); });
    return () => { cancelled = true; };
  }, [registry]);
  return useMemo(() => {
    const seen = new Set<string>();
    const merged: ExperimentModelOption[] = [];
    for (const option of [...CLAUDE_EXPERIMENT_MODEL_OPTIONS, ...pluginOptions]) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      merged.push(option);
    }
    return merged;
  }, [pluginOptions]);
}

export function ExperimentsSection({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const options = useExperimentModelOptions();
  const save = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

  return (
    <section className="global-settings-card" aria-label={t("settings.experiments.title")}>
      <h3 className="global-settings-card-title">
        {t("settings.experiments.title")}
        <ExperimentalBadge>{t("settings.experiments.badge")}</ExperimentalBadge>
        <SettingsScope kind="live" />
      </h3>
      <p className="global-settings-help">{t("settings.experiments.intro")}</p>
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
          <div className="global-settings-row" key={row.id}>
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                {t(row.titleKey)}
                <SettingsHelp title={t(row.titleKey)}>{t(row.helpKey)}</SettingsHelp>
              </p>
              {/* 모델 선택기는 제목 바로 아래 한 줄이다 — 이름을 되풀이하지 않는다: 어느 기능의 모델인지는 위 제목이 말한다. */}
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
            </div>
            <SettingsSwitch
              checked={enabled}
              disabled={saving}
              label={t(row.titleKey)}
              onChange={(next) => save({ ...experiments, [row.id]: next })}
            />
          </div>
        );
      })}
    </section>
  );
}
