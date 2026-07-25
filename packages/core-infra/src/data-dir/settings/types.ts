export interface GlobalOptionsData {
  readonly version: 1;
  readonly enableMetaphor?: boolean;
  readonly kimiModel?: { readonly model: string; readonly effort?: string };
  /** Idle agent auto-DORMANT threshold in minutes. `null` disables; key absent means server default. */
  readonly agentIdleDormantMinutes?: number | null;
}

export interface GlobalOptionsValidationResult {
  readonly data: GlobalOptionsData;
  readonly changed: boolean;
}

export interface GlobalOptionsStore {
  readonly path: string;
  readonly load: () => GlobalOptionsData;
  readonly save: (data: GlobalOptionsData) => void;
  readonly update: (mutate: (current: GlobalOptionsData) => GlobalOptionsData) => GlobalOptionsData;
}

export interface GlobalOptionsService {
  readonly load: () => GlobalOptionsData;
  readonly save: (data: GlobalOptionsData) => GlobalOptionsData;
  readonly update: (mutate: (current: GlobalOptionsData) => GlobalOptionsData) => GlobalOptionsData;
}
