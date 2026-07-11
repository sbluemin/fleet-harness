#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Breaking Changes'];
const PRODUCTS = ['fleet-cli', 'fleet-console', 'fleet-desktop', 'fleet-plugin', 'fleet-core'];
const TAGS = ['core-process', 'core-agent', 'core-unified-agent', 'core-infra', 'fleet-admiral', 'fleet-carriers', 'fleet-wiki', 'fleet-console', 'fleet-cli'];
const RETIRED_TAGS = ['core', 'wiki', 'wiki-web', 'agent-core', 'unified-agent', 'mcp-server', 'agent', 'carriers', 'fleet-infra'];
const DEFAULT_CHANGELOG = 'CHANGELOG.md';
const DEFAULT_CHANGELOG_KO = 'CHANGELOG.ko.md';
const DEFAULT_FRAGMENTS_DIR = '.changelog.d';
const IGNORED_FRAGMENT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);
const IS_DIRECT_EXECUTION = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_DIRECT_EXECUTION) main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const fragments = readFragments(options.fragmentsDir);
    const entries = validateFragments(fragments);

    if (entries.length === 0 && !options.allowEmpty) {
      throw new Error('No changelog fragments found. Add .changelog.d/*.md or pass --allow-empty.');
    }
    if (options.check) {
      console.log(`OK: ${entries.length} changelog fragment entr${entries.length === 1 ? 'y' : 'ies'} validated.`);
      return;
    }
    if (options.dryRun) {
      console.log(renderDryRun(options, entries));
      return;
    }
    if (!options.version) {
      throw new Error('Write mode requires --version <semver>.');
    }

    writeChangelogs(options, entries);
    for (const fragment of fragments) fs.unlinkSync(fragment.path);
    console.log(`OK: wrote CHANGELOG.md and CHANGELOG.ko.md release ${options.version} and deleted ${fragments.length} fragment file(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    allowEmpty: false,
    changelogKoPath: DEFAULT_CHANGELOG_KO,
    changelogPath: DEFAULT_CHANGELOG,
    check: false,
    date: new Date().toISOString().slice(0, 10),
    dryRun: false,
    fragmentsDir: DEFAULT_FRAGMENTS_DIR,
    version: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--allow-empty') options.allowEmpty = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--version') options.version = readOptionValue(args, (index += 1), arg);
    else if (arg === '--date') options.date = readOptionValue(args, (index += 1), arg);
    else if (arg === '--changelog') options.changelogPath = readOptionValue(args, (index += 1), arg);
    else if (arg === '--changelog-ko') options.changelogKoPath = readOptionValue(args, (index += 1), arg);
    else if (arg === '--fragments-dir') options.fragmentsDir = readOptionValue(args, (index += 1), arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.check && options.dryRun) throw new Error('Use only one of --check or --dry-run.');
  if (!options.check && !options.version) throw new Error(`${options.dryRun ? 'Dry-run' : 'Write'} mode requires --version <semver>.`);
  if (options.version && !/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error(`Invalid --version value: ${options.version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error(`Invalid --date value: ${options.date}`);
  return options;
}

function readOptionValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${optionName} requires a value.`);
  return value;
}

function readFragments(fragmentsDir) {
  if (!fs.existsSync(fragmentsDir)) return [];
  if (!fs.statSync(fragmentsDir).isDirectory()) throw new Error(`${fragmentsDir} is not a directory.`);
  return fs.readdirSync(fragmentsDir)
    .filter((name) => name.endsWith('.md') && !IGNORED_FRAGMENT_FILES.has(name))
    .sort()
    .map((name) => {
    const fragmentPath = path.join(fragmentsDir, name);
    if (!fs.statSync(fragmentPath).isFile()) throw new Error(`${fragmentPath} must be a file directly under ${fragmentsDir}.`);
    const product = PRODUCTS.find((candidate) => name.startsWith(`${candidate}-`));
    if (!product) throw new Error(`${name}: filename must start with a supported product followed by a section slug.`);
    return { content: fs.readFileSync(fragmentPath, 'utf8'), name, path: fragmentPath, product };
  });
}

function validateFragments(fragments) {
  return fragments.flatMap((fragment) => {
    const parsed = parseFragment(fragment);
    const expectedName = `${fragment.product}-${parsed.section.toLowerCase().replaceAll(' ', '-')}.md`;
    if (fragment.name !== expectedName) throw new Error(`${fragment.name}: expected filename ${expectedName} for its product and section.`);
    return parsed.entries.map((entry) => ({ ...entry, file: fragment.name, product: fragment.product, section: parsed.section }));
  });
}

function parseFragment(fragment) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(fragment.content);
  if (!match) throw new Error(`${fragment.name}: missing frontmatter.`);
  const frontmatterLines = match[1].trim().split(/\r?\n/).filter(Boolean);
  if (frontmatterLines.length !== 1 || !frontmatterLines[0].startsWith('section:')) throw new Error(`${fragment.name}: frontmatter must contain exactly one section: value.`);
  const section = frontmatterLines[0].slice('section:'.length).trim();
  if (!SECTIONS.includes(section)) throw new Error(`${fragment.name}: unsupported section "${section}".`);

  const bodyLines = trimOuterBlankLines(match[2].split(/\r?\n/));
  if (bodyLines.length === 0) throw new Error(`${fragment.name}: body must contain at least one English/Korean pair.`);
  const entries = [];
  for (let index = 0; index < bodyLines.length; index += 2) {
    const english = bodyLines[index];
    const korean = bodyLines[index + 1];
    if (!english.startsWith('- ')) throw new Error(`${fragment.name}: expected an English bullet at body line ${index + 1}.`);
    if (korean === undefined) throw new Error(`${fragment.name}: English bullet at body line ${index + 1} is missing its adjacent Korean summary.`);
    if (!korean.startsWith('  ko: ')) throw new Error(`${fragment.name}: English bullet at body line ${index + 1} must be followed immediately by exactly "  ko: <summary>".`);
    if (korean.startsWith('   ') || !/^  ko: \S(?:.*\S)?$/.test(korean)) throw new Error(`${fragment.name}: Korean summary at body line ${index + 2} must use exactly two spaces and be non-empty.`);
    entries.push(parseEntry(fragment.name, english, korean.slice('  ko: '.length)));
  }
  return { entries, section };
}

function trimOuterBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function parseEntry(file, bullet, koSummary) {
  if (bullet.includes('@dotobokuri/')) throw new Error(`${file}: changelog tags must not include @dotobokuri/ scopes.`);
  const match = /^- ((?:\[[a-z-]+\]\s*)+)(\S(?:.*\S)?)$/.exec(bullet);
  if (!match) throw new Error(`${file}: malformed bullet "${bullet}".`);
  const tags = [...match[1].matchAll(/\[([^\]]+)\]/g)].map((tagMatch) => tagMatch[1]);
  for (const tag of tags) {
    if (RETIRED_TAGS.includes(tag)) throw new Error(`${file}: retired tag [${tag}] is not allowed.`);
    if (!TAGS.includes(tag)) throw new Error(`${file}: unknown package tag [${tag}].`);
  }
  if (!/^[\x09\x20-\x7e]+$/.test(match[2])) throw new Error(`${file}: bullet summary must be English ASCII text.`);
  if (!/\p{Script=Hangul}/u.test(koSummary)) throw new Error(`${file}: Korean summary must contain Hangul.`);
  return { enSummary: match[2], koSummary, tagPrefix: match[1] };
}

function renderDryRun(options, entries) {
  return `=== CHANGELOG.md ===\n${renderReleaseSection(options.version, options.date, entries, options.allowEmpty, 'en')}\n\n=== CHANGELOG.ko.md ===\n${renderReleaseSection(options.version, options.date, entries, options.allowEmpty, 'ko')}`;
}

function renderReleaseSection(version, date, entries, allowEmpty, locale) {
  const header = `## [${version}] - ${date}`;
  if (entries.length === 0 && allowEmpty) return `${header}\n\nRelease v${version}`;
  const lines = [header, ''];
  let wroteProduct = false;
  for (const product of PRODUCTS) {
    const productEntries = entries.filter((entry) => entry.product === product);
    if (productEntries.length === 0) continue;
    if (wroteProduct) lines.push('');
    lines.push(`### ${product}`);
    for (const section of SECTIONS) {
      const sectionEntries = productEntries.filter((entry) => entry.section === section);
      if (sectionEntries.length === 0) continue;
      lines.push('', `#### ${section}`);
      lines.push(...sectionEntries.map((entry) => `- ${entry.tagPrefix}${locale === 'en' ? entry.enSummary : entry.koSummary}`));
    }
    wroteProduct = true;
  }
  return lines.join('\n');
}

export function writeChangelogs(options, entries) {
  if (path.resolve(options.changelogPath) === path.resolve(options.changelogKoPath)) {
    throw new Error('--changelog and --changelog-ko must name different files.');
  }
  const targets = [
    prepareChangelogWrite(options.changelogPath, options.version, options.date, entries, options.allowEmpty, 'en'),
    prepareChangelogWrite(options.changelogKoPath, options.version, options.date, entries, options.allowEmpty, 'ko'),
  ];
  try {
    for (const target of targets) {
      fs.writeFileSync(target.path, target.updated);
    }
  } catch (error) {
    for (const target of targets) {
      try {
        fs.writeFileSync(target.path, target.original);
      } catch {
        // Rollback is best-effort; the original write failure remains authoritative.
      }
    }
    throw error;
  }
}

function prepareChangelogWrite(changelogPath, version, date, entries, allowEmpty, locale) {
  const content = fs.readFileSync(changelogPath, 'utf8');
  const unreleasedHeader = '## [Unreleased]';
  const unreleasedIndex = content.indexOf(unreleasedHeader);
  if (unreleasedIndex === -1) throw new Error(`Missing [Unreleased] section in ${changelogPath}.`);
  if (content.includes(`## [${version}]`)) throw new Error(`${changelogPath} already contains release ${version}.`);
  const afterHeaderIndex = content.indexOf('\n', unreleasedIndex);
  if (afterHeaderIndex === -1) throw new Error(`Malformed [Unreleased] section in ${changelogPath}.`);
  const nextSectionIndex = content.indexOf('\n## [', afterHeaderIndex + 1);
  const unreleasedBody = content.slice(afterHeaderIndex + 1, nextSectionIndex === -1 ? content.length : nextSectionIndex);
  if (unreleasedBody.trim()) throw new Error(`[Unreleased] must be empty before compiling fragments in ${changelogPath}.`);
  const releaseSection = renderReleaseSection(version, date, entries, allowEmpty, locale);
  const before = content.slice(0, afterHeaderIndex + 1);
  const after = nextSectionIndex === -1 ? '' : content.slice(nextSectionIndex);
  return { original: content, path: changelogPath, updated: `${before}\n${releaseSection}\n${after}` };
}
