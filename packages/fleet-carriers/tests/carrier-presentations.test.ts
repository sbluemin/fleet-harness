import { describe, expect, it } from "vitest";

import {
  buildCarrierRoster,
  buildCarrierSystemPrompt,
  CARRIER_PRESENTATIONS,
  createCarrierRegistry,
  GENESIS_METADATA,
  NIMITZ_METADATA,
  registerCarrier,
  resolveCarrierPresentation,
  SENTINEL_METADATA,
  VANGUARD_METADATA,
  type CarrierMetadata,
} from "../src/index.js";

const DEFAULT_CARRIERS: Readonly<Record<string, CarrierMetadata>> = {
  nimitz: NIMITZ_METADATA,
  genesis: GENESIS_METADATA,
  sentinel: SENTINEL_METADATA,
  vanguard: VANGUARD_METADATA,
};

describe("Carrier presentations", () => {
  it("provides distinct non-empty Korean presentations for every default Carrier", () => {
    for (const [carrierId, canonical] of Object.entries(DEFAULT_CARRIERS)) {
      const korean = CARRIER_PRESENTATIONS[carrierId]?.ko;
      expect(korean, `${carrierId} must have a Korean presentation`).toBeDefined();
      expect(korean?.title).not.toBe("");
      expect(korean?.summary).not.toBe("");
      expect(korean?.title).not.toBe(canonical.title);
      expect(korean?.summary).not.toBe(canonical.summary);
      expect(CARRIER_PRESENTATIONS[carrierId]?.en).toBeUndefined();
    }
  });

  it("resolves each field through override, catalog, then canonical fallback", () => {
    const canonical = { title: "Canonical title", summary: "Canonical summary" };

    expect(resolveCarrierPresentation("ko", "genesis", canonical, {
      ko: { title: "Override title", summary: "" },
    })).toEqual({
      title: "Override title",
      summary: CARRIER_PRESENTATIONS.genesis?.ko?.summary,
    });
    expect(resolveCarrierPresentation("en", "genesis", canonical, {
      en: { title: "", summary: "Override summary" },
    })).toEqual({
      title: canonical.title,
      summary: "Override summary",
    });
  });

  it("falls back to canonical English for unregistered Carriers", () => {
    const canonical = { title: "Custom Operator", summary: "Handles custom operations." };

    expect(resolveCarrierPresentation("ko", "custom", canonical)).toEqual(canonical);
  });

  it("keeps roster and Carrier system prompts canonical-English-only", () => {
    const registry = createCarrierRegistry();
    const carrierIds = Object.keys(DEFAULT_CARRIERS);
    carrierIds.forEach((carrierId, index) => {
      const canonical = DEFAULT_CARRIERS[carrierId]!;
      registerCarrier(registry, {
        id: carrierId,
        slot: index + 1,
        displayName: carrierId,
        defaultCliType: "codex",
        carrierMetadata: canonical,
        carrierPresentation: {
          ko: CARRIER_PRESENTATIONS[carrierId]!.ko!,
        },
      });
    });
    const roster = buildCarrierRoster(registry, carrierIds);

    for (const [carrierId, canonical] of Object.entries(DEFAULT_CARRIERS)) {
      const carrierPrompt = buildCarrierSystemPrompt(canonical);
      const korean = CARRIER_PRESENTATIONS[carrierId]?.ko;

      expect(roster).toContain(canonical.title);
      expect(roster).toContain(canonical.summary);
      expect(carrierPrompt).toContain(canonical.title);
      expect(carrierPrompt).toContain(canonical.summary);
      expect(roster).not.toContain(korean?.title);
      expect(roster).not.toContain(korean?.summary);
      expect(carrierPrompt).not.toContain(korean?.title);
      expect(carrierPrompt).not.toContain(korean?.summary);
    }
  });
});
