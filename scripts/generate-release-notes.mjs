import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_NOTE_HEADINGS = ["Added", "Changed", "Fixed", "Removed", "Breaking Changes"];
const VERSION_HEADER_PATTERN = /^## \[([0-9]+\.[0-9]+\.[0-9]+)\] - ([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
const SECTION_HEADER_PATTERN = /^### (Added|Changed|Fixed|Removed|Breaking Changes)$/;
const BULLET_PATTERN = /^- (.+)$/;
const PACKAGE_TAG_PREFIX_PATTERN = /^(?:\[[^\]]+\])+\s*/;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const packageJsonPath = path.join(repoRoot, "runtime", "fleet-console", "package.json");
const outputPath = path.join(repoRoot, "runtime", "fleet-console", "client", "src", "release-notes.generated.ts");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const releaseNotes = existsSync(changelogPath)
  ? collectReleaseNotes(readFileSync(changelogPath, "utf8"), packageJson.version)
  : null;
const output = renderOutput(releaseNotes);

mkdirSync(path.dirname(outputPath), { recursive: true });
if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== output) {
  writeFileSync(outputPath, output);
}

function collectReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => VERSION_HEADER_PATTERN.test(line) && line.match(VERSION_HEADER_PATTERN)?.[1] === version);
  if (start === -1) return null;

  const headerMatch = lines[start].match(VERSION_HEADER_PATTERN);
  if (!headerMatch) return null;

  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) break;
    block.push(lines[index]);
  }

  const sections = collectSections(block);
  if (sections.length === 0) return null;
  return {
    version: headerMatch[1],
    date: headerMatch[2],
    sections,
  };
}

function collectSections(lines) {
  const sections = [];
  let current = null;

  for (const line of lines) {
    const sectionMatch = line.match(SECTION_HEADER_PATTERN);
    if (sectionMatch) {
      current = { heading: sectionMatch[1], items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("### ")) {
      current = null;
      continue;
    }
    const bulletMatch = line.match(BULLET_PATTERN);
    if (bulletMatch) {
      current.items.push(cleanBullet(bulletMatch[1]));
    }
  }

  return RELEASE_NOTE_HEADINGS
    .map((heading) => sections.find((section) => section.heading === heading))
    .filter((section) => section && section.items.length > 0);
}

function cleanBullet(text) {
  return text.replace(PACKAGE_TAG_PREFIX_PATTERN, "").trim();
}

function renderOutput(releaseNotes) {
  const value = releaseNotes === null
    ? "null"
    : `${JSON.stringify(releaseNotes, null, 2)} as const`;
  return `// CHANGELOG.md에서 생성된 Fleet Console 릴리스 노트다.
// 재생성: node scripts/generate-release-notes.mjs

import type { ReleaseNotes } from "./types.js";

export const RELEASE_NOTES: ReleaseNotes | null = ${value};
`;
}
