import type { ConsoleReleaseNoteItem, ConsoleReleaseNoteSection, ConsoleReleaseNotes } from "./types.js";

type ReleaseNoteHeading = ConsoleReleaseNoteSection["heading"];

interface MutableReleaseNoteSection {
  readonly heading: ReleaseNoteHeading;
  readonly items: ConsoleReleaseNoteItem[];
}

const RELEASE_NOTE_HEADINGS: readonly ReleaseNoteHeading[] = ["Added", "Changed", "Fixed", "Removed", "Breaking Changes"];
const VERSION_HEADER_PATTERN = /^## \[([^\]]+)\](?: - ([0-9]{4}-[0-9]{2}-[0-9]{2}))?$/;
const SECTION_HEADER_PATTERN = /^### (Added|Changed|Fixed|Removed|Breaking Changes)$/;
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
  const sections: MutableReleaseNoteSection[] = [];
  let current: MutableReleaseNoteSection | null = null;
  for (const line of lines) {
    const sectionMatch = SECTION_HEADER_PATTERN.exec(line);
    if (sectionMatch !== null) {
      current = { heading: sectionMatch[1] as ReleaseNoteHeading, items: [] };
      sections.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("### ")) {
      current = null;
      continue;
    }
    const bulletMatch = BULLET_PATTERN.exec(line);
    if (bulletMatch !== null) current.items.push(parseReleaseNoteItem(bulletMatch[1] ?? ""));
  }
  return RELEASE_NOTE_HEADINGS
    .map((heading) => sections.find((section) => section.heading === heading))
    .filter((section): section is MutableReleaseNoteSection => Boolean(section && section.items.length > 0));
}

function parseReleaseNoteItem(rawText: string): ConsoleReleaseNoteItem {
  const packageTags: string[] = [];
  let text = rawText.trim();
  while (true) {
    const match = PACKAGE_TAG_PATTERN.exec(text);
    if (match === null) break;
    packageTags.push(match[1] ?? "");
    text = text.slice(match[0].length).trimStart();
  }
  return { packageTags, text: text.trim() };
}
