import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  registerSingleCarrier,
} from "../../src/tool-registry.js";
import { CARRIER_FRAMEWORK_KEY, type CarrierMetadata } from "@sbluemin/fleet-core/admiral/carrier";
import { initStore } from "@sbluemin/fleet-core/admiral/store";

const TEST_EXTENSION_API = {
  registerMessageRenderer: vi.fn(),
} as unknown as ExtensionAPI;

vi.mock("../../src/fleet.js", () => ({
  getFleetRuntime: () => ({
    toolRegistry: {
      register: vi.fn(),
      unregister: vi.fn(),
      list: vi.fn(() => []),
      get: vi.fn(),
      onChange: vi.fn(() => () => {}),
      computeHash: vi.fn(() => "tool-hash"),
    },
  }),
}));

let storeDir: string;

function makeMetadata(): CarrierMetadata {
  return {
    title: "Test",
    summary: "Test carrier",
    category: "operations",
    whenToUse: [],
    whenNotToUse: [],
    permissions: [],
    requestBlocks: [],
    outputFormat: "",
  };
}

function writeStates(states: unknown): void {
  writeFileSync(join(storeDir, "states.json"), JSON.stringify(states, null, 2), "utf-8");
}

describe("framework cliType override restore", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[CARRIER_FRAMEWORK_KEY];
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    storeDir = mkdtempSync(join(tmpdir(), "fleet-framework-cli-"));
    initStore(storeDir);
    vi.clearAllMocks();
  });

  it("등록 시 states.json의 cliType override를 pull 방식으로 적용한다", () => {
    writeStates({ cliTypeOverrides: { vanguard: "codex" } });

    registerSingleCarrier(TEST_EXTENSION_API, "gemini", makeMetadata(), { id: "vanguard", slot: 7 });

    expect(getRegisteredCarrierConfig("vanguard")?.cliType).toBe("codex");
  });

  it("재등록은 기존 config 객체를 유지하면서 override cliType을 보존한다", () => {
    writeStates({ cliTypeOverrides: { vanguard: "codex" } });
    registerSingleCarrier(TEST_EXTENSION_API, "gemini", makeMetadata(), { id: "vanguard", slot: 7 });
    const firstConfig = getRegisteredCarrierConfig("vanguard");

    registerSingleCarrier(TEST_EXTENSION_API, "gemini", makeMetadata(), {
      id: "vanguard",
      slot: 3,
      displayName: "Vanguard Updated",
    });

    const secondConfig = getRegisteredCarrierConfig("vanguard");
    expect(secondConfig).toBe(firstConfig);
    expect(secondConfig?.displayName).toBe("Vanguard Updated");
    expect(secondConfig?.slot).toBe(3);
    expect(secondConfig?.cliType).toBe("codex");
  });

  it("재등록 시 등록 순서를 slot 기준으로 중복 없이 갱신한다", () => {
    registerSingleCarrier(TEST_EXTENSION_API, "codex", makeMetadata(), { id: "sentinel", slot: 5 });
    registerSingleCarrier(TEST_EXTENSION_API, "gemini", makeMetadata(), { id: "vanguard", slot: 7 });

    registerSingleCarrier(TEST_EXTENSION_API, "gemini", makeMetadata(), { id: "vanguard", slot: 3 });

    expect(getRegisteredOrder()).toEqual(["vanguard", "sentinel"]);
  });
});
