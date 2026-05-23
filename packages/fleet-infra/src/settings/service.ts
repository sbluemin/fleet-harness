import { loadSection, saveSection } from "./store.js";
import type { CoreSettingsAPI, SectionDisplayConfig } from "./types.js";

export class SettingsService implements CoreSettingsAPI {
  private readonly sections = new Map<string, SectionDisplayConfig>();

  load<T = Record<string, unknown>>(sectionKey: string): T {
    return loadSection<T>(sectionKey);
  }

  save(sectionKey: string, data: unknown): void {
    saveSection(sectionKey, data);
  }

  registerSection(config: SectionDisplayConfig): void {
    this.sections.set(config.key, config);
  }

  unregisterSection(sectionKey: string): void {
    this.sections.delete(sectionKey);
  }

  getSections(): SectionDisplayConfig[] {
    return [...this.sections.values()];
  }
}
