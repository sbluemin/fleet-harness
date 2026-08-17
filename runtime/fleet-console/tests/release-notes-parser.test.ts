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

### fleet-mobile

#### Added

- [fleet-mobile] Add the Mobile shell.

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

- [fleet-console] Keep the repeated fix.
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

- [fleet-console] Keep the repeated legacy fix.
`;

const UNKNOWN_PRODUCT_CONTEXT_CHANGELOG = `# Changelog

## [0.26.0] - 2026-07-12

### Security

#### Added

- [fleet-console] Keep the pre-product note.

### fleet-cli

#### Added

- [fleet-cli] Keep the CLI product note.

### Security

#### Added

- [fleet-console] Keep the between-product note.

### fleet-console

#### Added

- [fleet-console] Keep the Console product note.

### Notes

#### Added

- [fleet-console] Keep the post-product note.
`;

const MISLEADING_TAGS_CHANGELOG = `# Changelog

## [0.27.0] - 2026-07-12

### fleet-cli

#### Added

- [fleet-console] Keep the misleading tag.

### fleet-unknown

#### Added

- [fleet-cli] Keep the unknown product.
`;

const RUNTIME_CHANGELOG = `# Changelog

## [1.52.0] - 2026-08-10

### fleet-cli

#### Added

- Add the CLI surface.

### fleet-console

#### Added

- Add the Console surface.

### fleet-desktop

#### Fixed

- Fix the Desktop shell.
`;

const RETIRED_ONLY_CHANGELOG = `# Changelog

## [1.50.0] - 2026-08-05

### fleet-core

#### Added

- [core-ai-gateway] Drop the core-only release.

## [1.49.1] - 2026-08-04

### fleet-plugin

#### Fixed

- [fleet-console] Drop the plugin note.

### fleet-console

#### Added

- Keep the Console note.
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

  it("flattens runtime sections in product order and drops the retired package-axis headings", () => {
    const notes = parseConsoleReleaseNotes(PRODUCT_CHANGELOG);
    const sections = notes[0]?.sections;

    expect(sections?.map((section) => section.heading)).toEqual(["Added", "Fixed", "Removed"]);
    expect(sections?.[0]?.items).toEqual([
      { packageTags: ["fleet-cli"], text: "Open the embedded app.", product: "fleet-cli" },
      { packageTags: ["fleet-console"], text: "Add the Console surface.", product: "fleet-console" },
      { packageTags: ["fleet-console"], text: "Add the Desktop shell.", product: "fleet-desktop" },
      { packageTags: ["fleet-mobile"], text: "Add the Mobile shell.", product: "fleet-mobile" },
    ]);
    expect(sections?.[1]?.items).toEqual([
      { packageTags: ["fleet-console"], text: "Fix the Console surface.", product: "fleet-console" },
    ]);
    expect(sections?.[2]?.items).toEqual([{ packageTags: ["fleet-cli"], text: "Remove the legacy mode.", product: "fleet-cli" }]);
  });

  it("drops a retired heading's items instead of leaking them into the unstamped bucket", () => {
    const notes = parseConsoleReleaseNotes(RETIRED_ONLY_CHANGELOG);

    // 실 이력에는 fleet-plugin/fleet-core 항목만 담긴 릴리스가 있다(v1.49.0·v1.50.0·v1.50.1 등).
    // 그런 릴리스는 사용자가 체감할 내용이 하나도 남지 않으므로 목록에서 통째로 빠진다.
    expect(notes.map((note) => note.version)).toEqual(["1.49.1"]);
    expect(notes[0]?.sections).toEqual([{
      heading: "Added",
      items: [{ packageTags: [], text: "Keep the Console note.", product: "fleet-console" }],
    }]);
  });

  it("merges a section heading that repeats within one release", () => {
    const notes = parseConsoleReleaseNotes(DUPLICATE_LEGACY_CHANGELOG);
    const sections = notes[0]?.sections;

    expect(sections?.map((section) => section.heading)).toEqual(["Added", "Fixed"]);
    expect(sections?.[1]?.items).toEqual([
      { packageTags: ["fleet-console"], text: "Keep the first fix." },
      { packageTags: ["fleet-console"], text: "Keep the repeated fix." },
    ]);
  });

  it("puts legacy items before matching product sections in mixed blocks", () => {
    const notes = parseConsoleReleaseNotes(MIXED_CHANGELOG);
    const fixed = notes[0]?.sections.find((section) => section.heading === "Fixed");

    expect(fixed?.items).toEqual([
      { packageTags: ["fleet-console"], text: "Keep the legacy fix first." },
      { packageTags: ["fleet-console"], text: "Keep the repeated legacy fix." },
      { packageTags: ["fleet-cli"], text: "Keep the CLI product fix.", product: "fleet-cli" },
      { packageTags: ["fleet-console"], text: "Keep the Console product fix.", product: "fleet-console" },
    ]);
  });

  it("keeps level-four sections under an unrecognized heading as unstamped items", () => {
    const notes = parseConsoleReleaseNotes(UNKNOWN_PRODUCT_CONTEXT_CHANGELOG);

    expect(notes[0]?.sections).toEqual([{
      heading: "Added",
      items: [
        { packageTags: ["fleet-console"], text: "Keep the pre-product note." },
        { packageTags: ["fleet-console"], text: "Keep the between-product note." },
        { packageTags: ["fleet-console"], text: "Keep the post-product note." },
        { packageTags: ["fleet-cli"], text: "Keep the CLI product note.", product: "fleet-cli" },
        { packageTags: ["fleet-console"], text: "Keep the Console product note.", product: "fleet-console" },
      ],
    }]);
  });

  it("stamps only recognized product headings and never infers provenance from package tags", () => {
    const notes = parseConsoleReleaseNotes(MISLEADING_TAGS_CHANGELOG);

    expect(notes[0]?.sections[0]?.items).toEqual([
      { packageTags: ["fleet-cli"], text: "Keep the unknown product." },
      { packageTags: ["fleet-console"], text: "Keep the misleading tag.", product: "fleet-cli" },
    ]);
  });

  it("reads a runtime-grouped release that carries no package tags", () => {
    const notes = parseConsoleReleaseNotes(RUNTIME_CHANGELOG);

    expect(notes[0]?.sections).toEqual([
      {
        heading: "Added",
        items: [
          { packageTags: [], text: "Add the CLI surface.", product: "fleet-cli" },
          { packageTags: [], text: "Add the Console surface.", product: "fleet-console" },
        ],
      },
      {
        heading: "Fixed",
        items: [{ packageTags: [], text: "Fix the Desktop shell.", product: "fleet-desktop" }],
      },
    ]);
  });
});
