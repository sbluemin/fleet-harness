import { afterEach, describe, expect, it } from "vitest";

import { buildRuntimeContextPrompt, buildSystemPrompt } from "../../src/admiral/prompts.js";
import { getActiveProtocol, getAllProtocols } from "../../src/admiral/protocols/index.js";
import { initSettingsService, resetSettingsService } from "../../src/infra/settings/runtime.js";
import type { CoreSettingsAPI, SectionDisplayConfig } from "../../src/infra/settings/types.js";

describe("Admiral protocols", () => {
  afterEach(() => {
    resetSettingsService();
  });

  it("registers Fleet Action as the only built-in protocol", () => {
    expect(getAllProtocols().map((protocol) => protocol.id)).toEqual(["fleet-action"]);
  });

  it("falls back to Fleet Action when persisted settings reference a removed protocol", () => {
    const settings = new MemorySettingsService({
      admiral: { activeProtocol: "positive-control" },
    });
    initSettingsService(settings);

    expect(getActiveProtocol().id).toBe("fleet-action");
    expect(buildRuntimeContextPrompt("hello")).toContain("<current_protocol>fleet-action</current_protocol>");
  });

  it("omits Positive Control doctrine from the system prompt catalog", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("Fleet Action Protocol");
    expect(prompt).not.toContain("Positive Control");
    expect(prompt).not.toContain("positive-control");
    expect(prompt).not.toContain("Standing Orders**: suspended");
    expect(prompt).not.toContain("Control Mode");
  });
});

class MemorySettingsService implements CoreSettingsAPI {
  private readonly sections = new Map<string, unknown>();

  constructor(seed: Record<string, unknown>) {
    for (const [key, value] of Object.entries(seed)) {
      this.sections.set(key, value);
    }
  }

  load<T = Record<string, unknown>>(sectionKey: string): T {
    return (this.sections.get(sectionKey) ?? {}) as T;
  }

  save(sectionKey: string, data: unknown): void {
    this.sections.set(sectionKey, data);
  }

  registerSection(_config: SectionDisplayConfig): void {
    // 테스트용 메모리 설정 서비스에서는 표시 섹션 등록이 필요 없다.
  }

  unregisterSection(_sectionKey: string): void {
    // 테스트용 메모리 설정 서비스에서는 표시 섹션 해제가 필요 없다.
  }

  getSections(): SectionDisplayConfig[] {
    return [];
  }
}
