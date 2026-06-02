import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CarrierConfig,
  type CarrierMetadata,
  createCarrierRuntime,
  initStore,
  registerCarrier,
  resetStoreForTests,
  setCarrierAgentMode,
} from "@dotobokuri/fleet-carriers";

import { buildStatusEntries } from "../src/mission-control/carrier-roster/view-model.js";

let tempDir: string | null = null;

describe("carrier status view model", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mission-bridge-view-model-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("sanitizes metadata title and summary before rendering role fields", () => {
    const runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createCarrierConfig({
      summary: "Builds\x1bPpayload\x1b\\ features\r\nwithout\x9b31m terminal controls\x9fhidden\x1b\\.",
      title: "Chief\x1b]52;c;AAAA\x07 Engineer\nLead\x9d52;c;BBBB\x9c",
    }));

    const entry = buildStatusEntries(runtime)[0];

    expect(entry?.role).toBe("Chief Engineer Lead");
    expect(entry?.roleDescription).toBe("Chief Engineer Lead - Builds features without terminal controls.");
    expect(entry?.roleDescription).not.toContain("\x1b]");
    expect(entry?.roleDescription).not.toContain("\x1bP");
    expect(entry?.roleDescription).not.toContain("\x9b");
    expect(entry?.roleDescription).not.toContain("\x9d");
    expect(entry?.roleDescription).not.toContain("\x9f");
    expect(entry?.roleDescription).not.toMatch(/[\r\n]/);
  });

  it("preserves printable metadata in role fields", () => {
    const runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createCarrierConfig({
      summary: "Full-stack implementation workhorse",
      title: "Chief Engineer",
    }));

    const entry = buildStatusEntries(runtime)[0];

    expect(entry?.role).toBe("Chief Engineer");
    expect(entry?.roleDescription).toBe("Chief Engineer - Full-stack implementation workhorse");
  });

  it("reads subagent mode independently of carrier cliType", () => {
    const runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createCarrierConfig({
      summary: "Runs with Codex by default",
      title: "Operator",
    }, "codex"));
    setCarrierAgentMode("metadata_test", true);

    const entry = buildStatusEntries(runtime)[0];

    expect(entry?.cliType).toBe("codex");
    expect(entry?.subagentMode).toBe(true);
    expect(entry?.subagentPendingRestart).toBe(true);
  });

  it("heals codex-only carriers with codex persona defaults", () => {
    const runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createCarrierConfig({
      summary: "Runs with Codex defaults",
      title: "Operator",
    }, "codex", {
      defaultEffort: "low",
      defaultModel: "gpt-5.4-mini",
    }));

    const entry = buildStatusEntries(runtime)[0];

    expect(entry?.cliType).toBe("codex");
    expect(entry?.model).toBe("gpt-5.4-mini");
    expect(entry?.effort).toBe("low");
  });
});

function createCarrierConfig(
  metadata: Pick<CarrierMetadata, "summary" | "title">,
  cliType: CarrierConfig["defaultCliType"] = "claude",
  codexDefaults?: { readonly defaultEffort: string; readonly defaultModel: string },
): CarrierConfig {
  return {
    carrierMetadata: {
      allowedExecutorTools: [],
      category: "operations",
      outputFormat: "Report results.",
      permissions: [],
      principles: [],
      requestBlocks: [],
      whenNotToUse: [],
      whenToUse: [],
      ...metadata,
    },
    color: "",
    defaultCliType: cliType,
    displayName: "Metadata Test",
    id: "metadata_test",
    slot: 1,
    ...(codexDefaults ? { subagent: { byHost: { codex: codexDefaults } } } : {}),
  };
}
