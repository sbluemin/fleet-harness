#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Breaking Changes'];
// Release notes are grouped by the runtime a user experiences the change in, never by the package it was implemented in.
const PRODUCTS = ['fleet-cli', 'fleet-console', 'fleet-desktop'];
const DEFAULT_CHANGELOG = 'CHANGELOG.md';
const DEFAULT_CHANGELOG_KO = 'CHANGELOG.ko.md';
const DEFAULT_FRAGMENTS_DIR = '.changelog.d';
const IGNORED_FRAGMENT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);
const CANARY_FRAGMENT_NAME = 'canary.md';
const FRAGMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/;
const BRANCH_SLUG_MAX_LENGTH = 60;
const IS_DIRECT_EXECUTION = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_DIRECT_EXECUTION) main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.nameForBranch !== null) {
      console.log(branchFragmentName(options.nameForBranch || readCurrentBranch()));
      return;
    }

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
    nameForBranch: null,
    version: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--allow-empty') options.allowEmpty = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--name-for-branch') {
      const value = readOptionalValue(args, index + 1);
      options.nameForBranch = value ?? '';
      if (value !== null) index += 1;
    }
    else if (arg === '--version') options.version = readOptionValue(args, (index += 1), arg);
    else if (arg === '--date') options.date = readOptionValue(args, (index += 1), arg);
    else if (arg === '--changelog') options.changelogPath = readOptionValue(args, (index += 1), arg);
    else if (arg === '--changelog-ko') options.changelogKoPath = readOptionValue(args, (index += 1), arg);
    else if (arg === '--fragments-dir') options.fragmentsDir = readOptionValue(args, (index += 1), arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.nameForBranch !== null) return options;
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

function readOptionalValue(args, index) {
  const value = args[index];
  return value === undefined || value.startsWith('--') ? null : value;
}

// A fragment is named after the branch that authors it, so it can be written in the same commit as the change itself.
export function branchFragmentName(branch) {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error('Branch name is empty. Pass it explicitly: --name-for-branch <branch>.');
  const slug = trimmed.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  const capped = (slug === '' ? 'branch' : slug).slice(0, BRANCH_SLUG_MAX_LENGTH).replace(/-+$/, '');
  return `${capped}.md`;
}

function readCurrentBranch() {
  let branch = '';
  try {
    branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Could not read the current git branch. Pass it explicitly: --name-for-branch <branch>.');
  }
  if (!branch) throw new Error('HEAD is detached, so there is no branch to derive a name from. Pass it explicitly: --name-for-branch <branch>.');
  return branch;
}

function readFragments(fragmentsDir) {
  if (!fs.existsSync(fragmentsDir)) return [];
  if (!fs.statSync(fragmentsDir).isDirectory()) throw new Error(`${fragmentsDir} is not a directory.`);
  return fs.readdirSync(fragmentsDir)
    .filter((name) => name.endsWith('.md') && !IGNORED_FRAGMENT_FILES.has(name))
    .sort(compareFragmentNames)
    .map((name) => {
      const fragmentPath = path.join(fragmentsDir, name);
      if (!fs.statSync(fragmentPath).isFile()) throw new Error(`${fragmentPath} must be a file directly under ${fragmentsDir}.`);
      if (name !== CANARY_FRAGMENT_NAME && !FRAGMENT_NAME_PATTERN.test(name)) {
        throw new Error(`${name}: filename must be ${CANARY_FRAGMENT_NAME} or a branch-derived name. Run "node scripts/compile-changelog-fragments.mjs --name-for-branch" to get it.`);
      }
      return { content: fs.readFileSync(fragmentPath, 'utf8'), name, path: fragmentPath };
    });
}

// canary.md holds authorized direct-canary work and sorts first; every other fragment is branch-derived and sorts by name.
function compareFragmentNames(left, right) {
  if (left === right) return 0;
  if (left === CANARY_FRAGMENT_NAME) return -1;
  if (right === CANARY_FRAGMENT_NAME) return 1;
  return left < right ? -1 : 1;
}

function validateFragments(fragments) {
  return fragments.flatMap((fragment) => parseFragment(fragment));
}

function parseFragment(fragment) {
  const body = readFragmentBody(fragment);
  const lines = body.split(/\r?\n/);
  const entries = [];
  let product = null;
  let section = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.startsWith('### ')) {
      const candidate = line.slice('### '.length).trim();
      if (!PRODUCTS.includes(candidate)) throw new Error(`${fragment.name}: unsupported runtime "${candidate}" at line ${index + 1}. Use one of ${PRODUCTS.join(', ')}.`);
      product = candidate;
      section = null;
      continue;
    }
    if (line.startsWith('#### ')) {
      if (!product) throw new Error(`${fragment.name}: section heading at line ${index + 1} requires a preceding runtime heading.`);
      const candidate = line.slice('#### '.length).trim();
      if (!SECTIONS.includes(candidate)) throw new Error(`${fragment.name}: unsupported section "${candidate}" at line ${index + 1}.`);
      section = candidate;
      continue;
    }
    if (line.startsWith('- ')) {
      if (!product || !section) throw new Error(`${fragment.name}: English bullet at line ${index + 1} requires runtime and section headings.`);
      const korean = lines[index + 1];
      if (korean === undefined) throw new Error(`${fragment.name}: English bullet at line ${index + 1} is missing its adjacent Korean summary.`);
      if (!korean.startsWith('  ko: ')) throw new Error(`${fragment.name}: English bullet at line ${index + 1} must be followed immediately by exactly "  ko: <summary>".`);
      if (korean.startsWith('   ') || !/^  ko: \S(?:.*\S)?$/.test(korean)) throw new Error(`${fragment.name}: Korean summary at line ${index + 2} must use exactly two spaces and be non-empty.`);
      entries.push({ ...parseEntry(fragment.name, line, korean.slice('  ko: '.length)), product, section, file: fragment.name });
      index += 1;
      continue;
    }
    throw new Error(`${fragment.name}: expected a runtime heading, section heading, or English bullet at line ${index + 1}.`);
  }
  if (entries.length === 0) throw new Error(`${fragment.name}: body must contain at least one runtime-scoped English/Korean pair.`);
  return entries;
}

// The branch frontmatter is what makes a stale or hand-invented filename a loud failure instead of a silent one.
function readFragmentBody(fragment) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(fragment.content);
  if (fragment.name === CANARY_FRAGMENT_NAME) {
    if (match) throw new Error(`${CANARY_FRAGMENT_NAME}: direct-canary fragments must not declare branch frontmatter.`);
    return fragment.content;
  }
  if (!match) throw new Error(`${fragment.name}: missing frontmatter. Start the file with "---", then "branch: <git branch name>", then "---".`);
  const frontmatterLines = match[1].trim().split(/\r?\n/).filter(Boolean);
  if (frontmatterLines.length !== 1 || !frontmatterLines[0].startsWith('branch:')) throw new Error(`${fragment.name}: frontmatter must contain exactly one branch: value.`);
  const branch = frontmatterLines[0].slice('branch:'.length).trim();
  if (!branch) throw new Error(`${fragment.name}: frontmatter branch: value is empty.`);
  const expected = branchFragmentName(branch);
  if (expected !== fragment.name) throw new Error(`${fragment.name}: branch "${branch}" derives ${expected}. Rename the file, or correct the branch: value.`);
  return match[2];
}

function parseEntry(file, bullet, koSummary) {
  const summary = bullet.slice('- '.length);
  if (summary.startsWith('[')) throw new Error(`${file}: bullet must not start with a package tag. Release notes are grouped by runtime heading now: "${bullet}"`);
  if (!/^\S(?:.*\S)?$/.test(summary)) throw new Error(`${file}: malformed bullet "${bullet}".`);
  if (!/^[\x09\x20-\x7e]+$/.test(summary)) throw new Error(`${file}: bullet summary must be English ASCII text.`);
  if (!/\p{Script=Hangul}/u.test(koSummary)) throw new Error(`${file}: Korean summary must contain Hangul.`);
  return { enSummary: summary, koSummary };
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
      lines.push(...sectionEntries.map((entry) => `- ${locale === 'en' ? entry.enSummary : entry.koSummary}`));
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
