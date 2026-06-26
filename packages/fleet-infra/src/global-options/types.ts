export interface GlobalOptionsData {
  readonly version: 1;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
  readonly consolePortMode?: "dynamic" | "static";
  readonly consoleStaticPort?: number;
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
