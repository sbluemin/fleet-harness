#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Breaking Changes'];
const TAGS = [
  'core-agent',
  'core-unified-agent',
  'fleet-infra',
  'fleet-admiral',
  'fleet-carriers',
  'fleet-wiki',
  'fleet-console',
  'fleet-cli',
];
const RETIRED_TAGS = [
  'core',
  'wiki',
  'wiki-web',
  'agent-core',
  'unified-agent',
  'mcp-server',
  'agent',
  'carriers',
];
const DEFAULT_CHANGELOG = 'CHANGELOG.md';
const DEFAULT_FRAGMENTS_DIR = '.changelog.d';

main();

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
      console.log(renderReleaseSection(options.version, options.date, entries, options.allowEmpty));
      return;
    }

    if (!options.version) {
      throw new Error('Write mode requires --version <semver>.');
    }

    writeChangelog(options.changelogPath, options.version, options.date, entries, options.allowEmpty);
    for (const fragment of fragments) {
      fs.unlinkSync(fragment.path);
    }
    console.log(`OK: wrote CHANGELOG.md release ${options.version} and deleted ${fragments.length} fragment file(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    allowEmpty: false,
    changelogPath: DEFAULT_CHANGELOG,
    check: false,
    date: new Date().toISOString().slice(0, 10),
    dryRun: false,
    fragmentsDir: DEFAULT_FRAGMENTS_DIR,
    version: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--allow-empty') {
      options.allowEmpty = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--version') {
      options.version = readOptionValue(args, (index += 1), arg);
    } else if (arg === '--date') {
      options.date = readOptionValue(args, (index += 1), arg);
    } else if (arg === '--changelog') {
      options.changelogPath = readOptionValue(args, (index += 1), arg);
    } else if (arg === '--fragments-dir') {
      options.fragmentsDir = readOptionValue(args, (index += 1), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.check && options.dryRun) {
    throw new Error('Use only one of --check or --dry-run.');
  }
  if (!options.check && !options.version) {
    throw new Error(`${options.dryRun ? 'Dry-run' : 'Write'} mode requires --version <semver>.`);
  }
  if (options.version && !/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`Invalid --version value: ${options.version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`Invalid --date value: ${options.date}`);
  }

  return options;
}

function readOptionValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readFragments(fragmentsDir) {
  if (!fs.existsSync(fragmentsDir)) {
    return [];
  }
  const dirStat = fs.statSync(fragmentsDir);
  if (!dirStat.isDirectory()) {
    throw new Error(`${fragmentsDir} is not a directory.`);
  }

  return fs
    .readdirSync(fragmentsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const fragmentPath = path.join(fragmentsDir, name);
      const stat = fs.statSync(fragmentPath);
      if (!stat.isFile()) {
        throw new Error(`${fragmentPath} must be a file directly under ${fragmentsDir}.`);
      }
      return {
        content: fs.readFileSync(fragmentPath, 'utf8'),
        name,
        path: fragmentPath,
      };
    });
}

function validateFragments(fragments) {
  const entries = [];
  for (const fragment of fragments) {
    const parsed = parseFragment(fragment);
    for (const bullet of parsed.bullets) {
      validateBullet(fragment.name, bullet);
      entries.push({
        bullet,
        file: fragment.name,
        section: parsed.section,
      });
    }
  }
  return entries;
}

function parseFragment(fragment) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(fragment.content);
  if (!match) {
    throw new Error(`${fragment.name}: missing frontmatter.`);
  }

  const frontmatter = match[1].trim();
  const frontmatterLines = frontmatter.split(/\r?\n/).filter(Boolean);
  if (frontmatterLines.length !== 1 || !frontmatterLines[0].startsWith('section:')) {
    throw new Error(`${fragment.name}: frontmatter must contain exactly one section: value.`);
  }

  const section = frontmatterLines[0].slice('section:'.length).trim();
  if (!SECTIONS.includes(section)) {
    throw new Error(`${fragment.name}: unsupported section "${section}".`);
  }

  const bodyLines = match[2].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (bodyLines.length === 0) {
    throw new Error(`${fragment.name}: body must contain at least one bullet.`);
  }
  if (bodyLines.some((line) => !line.startsWith('- '))) {
    throw new Error(`${fragment.name}: body must contain bullet lines only.`);
  }

  return {
    bullets: bodyLines,
    section,
  };
}

function validateBullet(file, bullet) {
  if (bullet.includes('@dotobokuri/')) {
    throw new Error(`${file}: changelog tags must not include @dotobokuri/ scopes.`);
  }

  const match = /^- ((?:\[[a-z-]+\])+)\s+(.+)$/.exec(bullet);
  if (!match) {
    throw new Error(`${file}: malformed bullet "${bullet}".`);
  }

  const tags = [...match[1].matchAll(/\[([^\]]+)\]/g)].map((tagMatch) => tagMatch[1]);
  const summary = match[2].trim();
  if (!summary) {
    throw new Error(`${file}: bullet summary must not be empty.`);
  }
  // ASCII 요약만 허용해 release note가 영어 bullet이라는 계약을 가볍게 검증한다.
  if (!/^[\x09\x20-\x7e]+$/.test(summary)) {
    throw new Error(`${file}: bullet summary must be English ASCII text.`);
  }

  for (const tag of tags) {
    if (RETIRED_TAGS.includes(tag)) {
      throw new Error(`${file}: retired tag [${tag}] is not allowed.`);
    }
    if (!TAGS.includes(tag)) {
      throw new Error(`${file}: unknown package tag [${tag}].`);
    }
  }
}

function renderReleaseSection(version, date, entries, allowEmpty) {
  const header = `## [${version}] - ${date}`;
  if (entries.length === 0 && allowEmpty) {
    return `${header}\n\nRelease v${version}`;
  }

  const lines = [header, ''];
  let wroteSection = false;
  for (const section of SECTIONS) {
    const sectionEntries = entries.filter((entry) => entry.section === section);
    if (sectionEntries.length === 0) continue;
    if (wroteSection) lines.push('');
    lines.push(`### ${section}`);
    lines.push(...sectionEntries.map((entry) => entry.bullet));
    wroteSection = true;
  }

  return lines.join('\n');
}

function writeChangelog(changelogPath, version, date, entries, allowEmpty) {
  const content = fs.readFileSync(changelogPath, 'utf8');
  const unreleasedHeader = '## [Unreleased]';
  const unreleasedIndex = content.indexOf(unreleasedHeader);
  if (unreleasedIndex === -1) {
    throw new Error('Missing [Unreleased] section in CHANGELOG.md.');
  }
  if (content.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already contains release ${version}.`);
  }

  const afterHeaderIndex = content.indexOf('\n', unreleasedIndex);
  if (afterHeaderIndex === -1) {
    throw new Error('Malformed [Unreleased] section in CHANGELOG.md.');
  }

  const nextSectionIndex = content.indexOf('\n## [', afterHeaderIndex + 1);
  const unreleasedBody = content.slice(afterHeaderIndex + 1, nextSectionIndex === -1 ? content.length : nextSectionIndex);
  if (unreleasedBody.trim()) {
    throw new Error('[Unreleased] must be empty before compiling fragments. Migrate entries into .changelog.d/*.md first.');
  }

  const releaseSection = renderReleaseSection(version, date, entries, allowEmpty);
  const before = content.slice(0, afterHeaderIndex + 1);
  const after = nextSectionIndex === -1 ? '' : content.slice(nextSectionIndex);
  const updated = `${before}\n${releaseSection}\n${after}`;
  fs.writeFileSync(changelogPath, updated);
}
