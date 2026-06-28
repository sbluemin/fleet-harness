import { describe, expect, it } from "vitest";

import { parseConsoleReleaseNotes } from "../core/host/release-notes/parser.js";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- [fleet-console] Draft console note.

## [0.22.1] - 2026-06-20

### Changed

- [fleet-console][fleet-cli] Runtime notes now load lazily.

### Fixed

- Plain text fix.

### Security

- Ignored section.

## [0.22.1] - 2026-06-19

### Added

- [fleet-console] Duplicate historical header.

## [0.22.0] - 2026-06-18

### Removed

- [fleet-console] Removed stale bundle.

## [0.22.0] - 2026-06-17

### Changed

- [fleet-cli] Second duplicate header.

## [0.21.0] - 2026-06-10

### Added

## [0.20.0] - 2026-06-01

### Breaking Changes

- [fleet-console] Breaking note.
`;

describe("release note parser", () => {
  it("collects every non-empty version block without collapsing duplicates", () => {
    const notes = parseConsoleReleaseNotes(CHANGELOG);

    expect(notes.map((note) => note.version)).toEqual(["Unreleased", "0.22.1", "0.22.1", "0.22.0", "0.22.0", "0.20.0"]);
    expect(notes.map((note) => note.date)).toEqual([null, "2026-06-20", "2026-06-19", "2026-06-18", "2026-06-17", "2026-06-01"]);
  });

  it("keeps canonical section ordering and filters empty or unknown sections", () => {
    const notes = parseConsoleReleaseNotes(CHANGELOG);

    expect(notes[1]?.sections.map((section) => section.heading)).toEqual(["Changed", "Fixed"]);
    expect(notes.find((note) => note.version === "0.21.0")).toBeUndefined();
  });

  it("extracts leading package tags while preserving display text", () => {
    const notes = parseConsoleReleaseNotes(CHANGELOG);
    const item = notes[1]?.sections[0]?.items[0];

    expect(item).toEqual({
      packageTags: ["fleet-console", "fleet-cli"],
      text: "Runtime notes now load lazily.",
    });
    expect(notes[1]?.sections[1]?.items[0]).toEqual({ packageTags: [], text: "Plain text fix." });
  });
});
