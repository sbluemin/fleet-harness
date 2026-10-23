
export interface SettingsStorageHost {
  readJson(pluginId: string, key: string): Promise<unknown>;
  writeJson(pluginId: string, key: string, value: unknown): Promise<void>;
}
