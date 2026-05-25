export type PresetSourceLabel = "arg" | "env" | "preset" | "default";

export interface FleetCliPreset {
  readonly model?: string;
  readonly native?: boolean;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
  readonly cursorSync?: boolean;
}

export interface FleetPresetData {
  readonly version: 1;
  readonly defaultCliId?: string;
  readonly byCli: Record<string, FleetCliPreset>;
}

export interface FleetPresetMutation {
  readonly defaultCliId?: string | null;
  readonly cliId?: string;
  readonly values?: FleetCliPreset | null;
}

export interface FleetPresetValidationResult {
  readonly data: FleetPresetData;
  readonly changed: boolean;
}

export interface PresetStore {
  readonly path: string;
  readonly load: () => FleetPresetData;
  readonly save: (data: FleetPresetData) => void;
  readonly update: (mutate: (current: FleetPresetData) => FleetPresetData) => FleetPresetData;
}

export interface PresetService {
  readonly load: () => FleetPresetData;
  readonly resolveCliPreset: (cliId: string) => FleetCliPreset;
  readonly saveCliPreset: (cliId: string, values: FleetCliPreset) => FleetPresetData;
  readonly saveDefaultCliId: (cliId: string | undefined) => FleetPresetData;
  readonly resetCliPreset: (cliId: string) => FleetPresetData;
  readonly update: (mutation: FleetPresetMutation) => FleetPresetData;
}
