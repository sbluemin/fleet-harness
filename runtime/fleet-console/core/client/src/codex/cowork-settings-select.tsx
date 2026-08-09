import { Select } from "@fleet-console/sdk/react/browser";

import { useT } from "../i18n/index.js";

export interface CoworkSettingsSelectProps {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
  readonly model: string;
  readonly effort: string;
  readonly onModelChange: (value: string) => void;
  readonly onEffortChange: (value: string) => void;
}

function toOptions(values: readonly string[]) {
  return values.map((value) => ({ value, label: value }));
}

export function CoworkSettingsSelect({
  models,
  efforts,
  model,
  effort,
  onModelChange,
  onEffortChange,
}: CoworkSettingsSelectProps) {
  const t = useT();
  return (
    <>
      <div className="cowork-selector">
        <span>{t("codex.cowork.cli")}</span>
      </div>
      <div className="cowork-selector">
        <span>{t("codex.cowork.model")}</span>
        <Select label={t("codex.cowork.model")} value={model} options={toOptions(models)} onChange={onModelChange} disabled={!models.length} compact />
      </div>
      <div className="cowork-selector">
        <span>{t("codex.cowork.effort")}</span>
        <Select label={t("codex.cowork.effort")} value={effort} options={toOptions(efforts)} onChange={onEffortChange} disabled={!efforts.length} compact />
      </div>
    </>
  );
}
