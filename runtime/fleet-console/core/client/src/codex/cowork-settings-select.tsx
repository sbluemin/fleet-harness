import { Select } from "@fleet-console/sdk/react/browser";

export interface CoworkSettingsSelectProps {
  readonly clis: readonly string[];
  readonly models: readonly string[];
  readonly efforts: readonly string[];
  readonly cli: string;
  readonly model: string;
  readonly effort: string;
  readonly onCliChange: (value: string) => void;
  readonly onModelChange: (value: string) => void;
  readonly onEffortChange: (value: string) => void;
}

function toOptions(values: readonly string[]) {
  return values.map((value) => ({ value, label: value }));
}

export function CoworkSettingsSelect({
  clis,
  models,
  efforts,
  cli,
  model,
  effort,
  onCliChange,
  onModelChange,
  onEffortChange,
}: CoworkSettingsSelectProps) {
  return (
    <>
      <div className="cowork-selector">
        <span>CLI</span>
        <Select label="CLI" value={cli} options={toOptions(clis)} onChange={onCliChange} disabled={!clis.length} compact />
      </div>
      <div className="cowork-selector">
        <span>Model</span>
        <Select label="Model" value={model} options={toOptions(models)} onChange={onModelChange} disabled={!models.length} compact />
      </div>
      <div className="cowork-selector">
        <span>Effort</span>
        <Select label="Effort" value={effort} options={toOptions(efforts)} onChange={onEffortChange} disabled={!efforts.length} compact />
      </div>
    </>
  );
}
