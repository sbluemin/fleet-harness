import { describe, expect, it } from "vitest";

import { deriveWhatsNewOverview, deriveWhatsNewTabs, filterWhatsNewSections, isWhatsNewTabAvailable } from "../core/client/src/whatsnew-tabs.js";
import type { ReleaseNotes } from "../core/client/src/types.js";

function note(items: ReleaseNotes["sections"][number]["items"]): ReleaseNotes {
  return { version: "1.0.0", date: "2026-07-12", localizationFallback: false, sections: [{ heading: "Added", items }] };
}

describe("What's New tabs", () => {
  it("derives fixed-order product tabs without reading package tags", () => {
    const release = note([
      { packageTags: ["fleet-cli"], text: "Console provenance", product: "fleet-console" },
      { packageTags: ["fleet-core"], text: "CLI provenance", product: "fleet-cli" },
      { packageTags: ["fleet-desktop"], text: "Desktop provenance", product: "fleet-desktop" },
    ]);

    expect(deriveWhatsNewTabs(release)).toEqual([
      { id: "overview", label: "Overview" },
      { id: "fleet-cli", label: "Fleet CLI" },
      { id: "fleet-console", label: "Fleet Console" },
      { id: "fleet-desktop", label: "Fleet Desktop" },
    ]);
    expect(filterWhatsNewSections(release, "fleet-cli")[0]?.items).toEqual([{ packageTags: ["fleet-core"], text: "CLI provenance", product: "fleet-cli" }]);
  });

  it("uses All updates for legacy and Other updates only for mixed releases", () => {
    const legacy = note([{ packageTags: ["fleet-console"], text: "Legacy" }]);
    const mixed = note([{ packageTags: [], text: "Legacy" }, { packageTags: [], text: "Console", product: "fleet-console" }]);

    expect(deriveWhatsNewTabs(legacy).map((tab) => tab.id)).toEqual(["overview", "all-updates"]);
    expect(filterWhatsNewSections(legacy, "all-updates")[0]?.items).toEqual(legacy.sections[0]?.items);
    expect(deriveWhatsNewTabs(mixed).map((tab) => tab.id)).toEqual(["overview", "fleet-console", "other-updates"]);
    expect(filterWhatsNewSections(mixed, "other-updates")[0]?.items).toEqual([{ packageTags: [], text: "Legacy" }]);
  });

  it("derives compact product, legacy, and mixed overview summaries", () => {
    const release = note([{ packageTags: [], text: "Console", product: "fleet-console" }]);
    const legacy = note([{ packageTags: [], text: "Earlier release" }]);
    const mixed = note([{ packageTags: [], text: "Earlier release" }, { packageTags: [], text: "Console", product: "fleet-console" }]);

    expect(deriveWhatsNewOverview(release)).toEqual([{ id: "fleet-console", label: "Fleet Console", count: 1, summary: "Console" }]);
    expect(deriveWhatsNewOverview(legacy)).toEqual([{ id: "all-updates", label: "Pre-product-grouping updates", count: 1, summary: "Earlier release" }]);
    expect(deriveWhatsNewOverview(mixed)).toEqual([
      { id: "fleet-console", label: "Fleet Console", count: 1, summary: "Console" },
      { id: "other-updates", label: "Other updates", count: 1, summary: "Earlier release" },
    ]);
    expect(filterWhatsNewSections(release, "overview")).toEqual([]);
    expect(isWhatsNewTabAvailable(release, "fleet-console")).toBe(true);
    expect(isWhatsNewTabAvailable(release, "fleet-cli")).toBe(false);
  });
});
