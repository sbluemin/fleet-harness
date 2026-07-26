import type { ScuttlebuttSettings } from "./settings-store.js";

export interface ChatCatalogModel {
  readonly id: string;
  readonly label: string;
  readonly effortLevels: readonly string[];
  readonly defaultEffort?: string;
}

export interface ChatCatalogCli {
  readonly cliId: "claude" | "claude-kimi" | "codex";
  readonly label: string;
  readonly available: boolean;
  readonly defaultModel: string;
  readonly models: readonly ChatCatalogModel[];
  readonly reason?: string;
}

export interface ChatCatalog {
  readonly clis: readonly ChatCatalogCli[];
  readonly settings: ScuttlebuttSettings;
}
