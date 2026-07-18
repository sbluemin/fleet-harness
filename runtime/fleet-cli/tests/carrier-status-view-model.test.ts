import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderModels } from "@dotobokuri/core-unified-agent";

import {
  type CarrierConfig,
  type CarrierMetadata,
  createCarrierRuntime,
  initStore,
  registerCarrier,
  resetStoreForTests,
  setTaskForceBackend,
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

  it("heals codex-only carriers with provider defaults", () => {
    const runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createCarrierConfig({
      summary: "Runs with Codex defaults",
      title: "Operator",
    }, "codex"));

    const entry = buildStatusEntries(runtime)[0];

    expect(entry?.cliType).toBe("codex");
    expect(entry?.model).toBe("gpt-5.4");
    expect(entry?.effort).toBe("high");
  });

  it("hides stale TaskForce selections until source capability is re-registered", () => {
    const runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createCarrierConfig({ summary: "TaskForce capable", title: "Operator" }, "claude", true));
    setTaskForceBackend(runtime.registry, "metadata_test", "claude", { model: firstModel("claude") });
    setTaskForceBackend(runtime.registry, "metadata_test", "codex", { model: firstModel("codex") });

    registerCarrier(runtime.registry, createCarrierConfig({ summary: "TaskForce disabled", title: "Operator" }));
    let entry = buildStatusEntries(runtime)[0];
    expect(entry?.taskForceCapable).toBe(false);
    expect(entry?.taskForceBackendCount).toBe(0);

    registerCarrier(runtime.registry, createCarrierConfig({ summary: "TaskForce restored", title: "Operator" }, "claude", true));
    entry = buildStatusEntries(runtime)[0];
    expect(entry?.taskForceCapable).toBe(true);
    expect(entry?.taskForceBackendCount).toBe(2);
  });
});

function createCarrierConfig(
  metadata: Pick<CarrierMetadata, "summary" | "title">,
  cliType: CarrierConfig["defaultCliType"] = "claude",
  taskForceCapable = false,
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
    ...(taskForceCapable ? { taskForceCapable: true } : {}),
  };
}

function firstModel(cliType: "claude" | "codex"): string {
  const model = getProviderModels(cliType).models[0]?.modelId;
  if (!model) throw new Error(`No model for ${cliType}`);
  return model;
}
