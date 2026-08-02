import { describe, expect, it } from "vitest";

import { parseConsoleReleaseNotes } from "../core/host/release-notes/release-notes.js";

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

const PRODUCT_CHANGELOG = `# Changelog

## [0.23.0] - 2026-07-12

### fleet-cli

#### Added

- [fleet-cli] Open the embedded app.

#### Removed

- [fleet-cli] Remove the legacy mode.

### fleet-console

#### Added

- [fleet-console] Add the Console surface.

#### Fixed

- [fleet-console] Fix the Console surface.

### fleet-desktop

#### Added

- [fleet-console] Add the Desktop shell.

### fleet-plugin

#### Added

- [fleet-console] Add the plugin surface.

#### Fixed

- [fleet-console] Fix the plugin surface.

### fleet-core

#### Added

- [fleet-admiral] Add the core surface.
`;

const DUPLICATE_LEGACY_CHANGELOG = `# Changelog

## [0.24.0] - 2026-07-12

### Fixed

- [fleet-console] Keep the first fix.

### Added

- [fleet-console] Keep the added note.

### Fixed

- [fleet-console] Ignore the repeated fix.
`;

const MIXED_CHANGELOG = `# Changelog

## [0.25.0] - 2026-07-12

### Fixed

- [fleet-console] Keep the legacy fix first.

### fleet-cli

#### Fixed

- [fleet-cli] Keep the CLI product fix.

### fleet-console

#### Fixed

- [fleet-console] Keep the Console product fix.

### Fixed

- [fleet-console] Ignore the repeated legacy fix.
`;

const UNKNOWN_PRODUCT_CONTEXT_CHANGELOG = `# Changelog

## [0.26.0] - 2026-07-12

### Security

#### Added

- [fleet-console] Ignore the pre-product note.

### fleet-cli

#### Added

- [fleet-cli] Keep the CLI product note.

### Security

#### Added

- [fleet-console] Ignore the between-product note.

### fleet-console

#### Added

- [fleet-console] Keep the Console product note.

### Notes

#### Added

- [fleet-console] Ignore the post-product note.
`;

const MISLEADING_TAGS_CHANGELOG = `# Changelog

## [0.27.0] - 2026-07-12

### fleet-cli

#### Added

- [fleet-console] Keep the misleading tag.

### fleet-unknown

#### Added

- [fleet-cli] Ignore the unknown product.
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
    expect(Object.hasOwn(notes[1]?.sections[1]?.items[0] ?? {}, "product")).toBe(false);
  });

  it("flattens future product sections in product order without expanding the API", () => {
    const notes = parseConsoleReleaseNotes(PRODUCT_CHANGELOG);
    const sections = notes[0]?.sections;

    expect(sections?.map((section) => section.heading)).toEqual(["Added", "Fixed", "Removed"]);
    expect(sections?.[0]?.items).toEqual([
      { packageTags: ["fleet-cli"], text: "Open the embedded app.", product: "fleet-cli" },
      { packageTags: ["fleet-console"], text: "Add the Console surface.", product: "fleet-console" },
      { packageTags: ["fleet-console"], text: "Add the Desktop shell.", product: "fleet-desktop" },
      { packageTags: ["fleet-console"], text: "Add the plugin surface.", product: "fleet-plugin" },
      { packageTags: ["fleet-admiral"], text: "Add the core surface.", product: "fleet-core" },
    ]);
    expect(sections?.[1]?.items).toEqual([
      { packageTags: ["fleet-console"], text: "Fix the Console surface.", product: "fleet-console" },
      { packageTags: ["fleet-console"], text: "Fix the plugin surface.", product: "fleet-plugin" },
    ]);
    expect(sections?.[2]?.items).toEqual([{ packageTags: ["fleet-cli"], text: "Remove the legacy mode.", product: "fleet-cli" }]);
  });

  it("keeps only the first repeated legacy section", () => {
    const notes = parseConsoleReleaseNotes(DUPLICATE_LEGACY_CHANGELOG);
    const sections = notes[0]?.sections;

    expect(sections?.map((section) => section.heading)).toEqual(["Added", "Fixed"]);
    expect(sections?.[1]?.items).toEqual([{ packageTags: ["fleet-console"], text: "Keep the first fix." }]);
  });

  it("puts the first legacy section before matching product sections in mixed blocks", () => {
    const notes = parseConsoleReleaseNotes(MIXED_CHANGELOG);
    const fixed = notes[0]?.sections.find((section) => section.heading === "Fixed");

    expect(fixed?.items).toEqual([
      { packageTags: ["fleet-console"], text: "Keep the legacy fix first." },
      { packageTags: ["fleet-cli"], text: "Keep the CLI product fix.", product: "fleet-cli" },
      { packageTags: ["fleet-console"], text: "Keep the Console product fix.", product: "fleet-console" },
    ]);
  });

  it("ignores level-four sections outside recognized product headings", () => {
    const notes = parseConsoleReleaseNotes(UNKNOWN_PRODUCT_CONTEXT_CHANGELOG);

    expect(notes[0]?.sections).toEqual([{
      heading: "Added",
      items: [
        { packageTags: ["fleet-cli"], text: "Keep the CLI product note.", product: "fleet-cli" },
        { packageTags: ["fleet-console"], text: "Keep the Console product note.", product: "fleet-console" },
      ],
    }]);
  });

  it("stamps only recognized product headings and never infers provenance from package tags", () => {
    const notes = parseConsoleReleaseNotes(MISLEADING_TAGS_CHANGELOG);

    expect(notes[0]?.sections[0]?.items).toEqual([
      { packageTags: ["fleet-console"], text: "Keep the misleading tag.", product: "fleet-cli" },
    ]);
  });
});
