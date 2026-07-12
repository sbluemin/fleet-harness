import type { ConsoleReleaseNoteItem, ConsoleReleaseNoteSection, ConsoleReleaseNotes, ReleaseNoteProduct } from "./types.js";

type ReleaseNoteHeading = ConsoleReleaseNoteSection["heading"];

interface MutableReleaseNoteSection {
  readonly heading: ReleaseNoteHeading;
  readonly items: ConsoleReleaseNoteItem[];
}

const RELEASE_NOTE_HEADINGS: readonly ReleaseNoteHeading[] = ["Added", "Changed", "Fixed", "Removed", "Breaking Changes"];
const VERSION_HEADER_PATTERN = /^## \[([^\]]+)\](?: - ([0-9]{4}-[0-9]{2}-[0-9]{2}))?$/;
const SECTION_HEADER_PATTERN = /^### (Added|Changed|Fixed|Removed|Breaking Changes)$/;
const PRODUCT_HEADER_PATTERN = /^### (fleet-(?:cli|console|desktop|plugin|core))$/;
const PRODUCT_SECTION_HEADER_PATTERN = /^#### (Added|Changed|Fixed|Removed|Breaking Changes)$/;
const BULLET_PATTERN = /^- (.+)$/;
const PACKAGE_TAG_PATTERN = /^\[([^\]]+)\]/;

export function parseConsoleReleaseNotes(changelog: string): readonly ConsoleReleaseNotes[] {
  const lines = changelog.split(/\r?\n/);
  const notes: ConsoleReleaseNotes[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = VERSION_HEADER_PATTERN.exec(lines[index] ?? "");
    if (match === null) continue;
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if ((lines[cursor] ?? "").startsWith("## ")) break;
      block.push(lines[cursor] ?? "");
    }
    const sections = collectSections(block);
    if (sections.length === 0) continue;
    notes.push({ version: match[1] ?? "", date: match[2] ?? null, sections });
  }
  return notes;
}

function collectSections(lines: readonly string[]): readonly ConsoleReleaseNoteSection[] {
  const legacySections = new Map<ReleaseNoteHeading, MutableReleaseNoteSection>();
  const productSections = new Map<ReleaseNoteHeading, MutableReleaseNoteSection>();
  const legacyHeadings = new Set<ReleaseNoteHeading>();
  let current: MutableReleaseNoteSection | null = null;
  let currentProduct: ReleaseNoteProduct | null = null;
  for (const line of lines) {
    const sectionMatch = SECTION_HEADER_PATTERN.exec(line);
    if (sectionMatch !== null) {
      const heading = sectionMatch[1] as ReleaseNoteHeading;
      currentProduct = null;
      current = legacyHeadings.has(heading) ? null : getSection(legacySections, heading);
      legacyHeadings.add(heading);
      continue;
    }
    const productMatch = PRODUCT_HEADER_PATTERN.exec(line);
    if (productMatch !== null) {
      currentProduct = productMatch[1] as ReleaseNoteProduct;
      current = null;
      continue;
    }
    if (line.startsWith("### ")) {
      currentProduct = null;
      current = null;
      continue;
    }
    const productSectionMatch = PRODUCT_SECTION_HEADER_PATTERN.exec(line);
    if (productSectionMatch !== null) {
      current = currentProduct === null ? null : getSection(productSections, productSectionMatch[1] as ReleaseNoteHeading);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("### ") || line.startsWith("#### ")) {
      current = null;
      continue;
    }
    const bulletMatch = BULLET_PATTERN.exec(line);
    if (bulletMatch !== null) current.items.push(parseReleaseNoteItem(bulletMatch[1] ?? "", currentProduct));
  }
  return RELEASE_NOTE_HEADINGS
    .map((heading) => combineSections(heading, legacySections.get(heading), productSections.get(heading)))
    .filter((section): section is MutableReleaseNoteSection => Boolean(section && section.items.length > 0));
}

function combineSections(
  heading: ReleaseNoteHeading,
  legacySection: MutableReleaseNoteSection | undefined,
  productSection: MutableReleaseNoteSection | undefined,
): MutableReleaseNoteSection | undefined {
  if (legacySection === undefined && productSection === undefined) return undefined;
  return { heading, items: [...(legacySection?.items ?? []), ...(productSection?.items ?? [])] };
}

function getSection(
  sections: Map<ReleaseNoteHeading, MutableReleaseNoteSection>,
  heading: ReleaseNoteHeading,
): MutableReleaseNoteSection {
  const existing = sections.get(heading);
  if (existing !== undefined) return existing;
  const section = { heading, items: [] };
  sections.set(heading, section);
  return section;
}

function parseReleaseNoteItem(rawText: string, product: ReleaseNoteProduct | null): ConsoleReleaseNoteItem {
  const packageTags: string[] = [];
  let text = rawText.trim();
  while (true) {
    const match = PACKAGE_TAG_PATTERN.exec(text);
    if (match === null) break;
    packageTags.push(match[1] ?? "");
    text = text.slice(match[0].length).trimStart();
  }
  return product === null ? { packageTags, text: text.trim() } : { packageTags, text: text.trim(), product };
}
