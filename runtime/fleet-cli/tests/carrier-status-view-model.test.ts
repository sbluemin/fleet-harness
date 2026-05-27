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
} from "@dotobokuri/fleet-carriers";

import { buildStatusEntries } from "../src/mission-control/carrier-roster/view-model.js";

let tempDir: string | null = null;

describe("carrier status view model", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-carrier-status-view-model-"));
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
});

function createCarrierConfig(metadata: Pick<CarrierMetadata, "summary" | "title">): CarrierConfig {
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
    cliType: "claude",
    color: "",
    defaultCliType: "claude",
    displayName: "Metadata Test",
    id: "metadata_test",
    slot: 1,
  };
}
