import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { writeChangelogs } from './compile-changelog-fragments.mjs';

const COMPILER = path.resolve('scripts/compile-changelog-fragments.mjs');
const EMPTY_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\nRelease v0.1.0\n';

test('validates adjacent bilingual pairs and renders deterministic dual previews', () => {
  const fixture = createFixture();
  writeFragment(fixture, '- [fleet-console] [fleet-cli] Add an ASCII summary.\n  ko: 한글 요약을 추가합니다.');
  const result = run(fixture, '--dry-run', '--version', '1.2.3', '--date', '2026-07-10');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^=== CHANGELOG\.md ===\n## \[1\.2\.3\] - 2026-07-10/m);
  assert.match(result.stdout, /- \[fleet-console\] \[fleet-cli\] Add an ASCII summary\./);
  assert.match(result.stdout, /=== CHANGELOG\.ko\.md ===[\s\S]*- \[fleet-console\] \[fleet-cli\] 한글 요약을 추가합니다\./);
});

test('rejects missing, duplicate, over-indented, blank, and other body lines', () => {
  for (const body of [
    '- [fleet-console] Add one.',
    '- [fleet-console] Add one.\n  ko: 한글 하나.\n  ko: 한글 둘.',
    '- [fleet-console] Add one.\n   ko: 한글 하나.',
    '- [fleet-console] Add one.\n\n  ko: 한글 하나.',
    '  ko: 고아 항목.\n- [fleet-console] Add one.\n  ko: 한글 하나.',
  ]) {
    const fixture = createFixture();
    writeFragment(fixture, body);
    const result = run(fixture, '--check');
    assert.notEqual(result.status, 0, body);
  }
});

test('retains English ASCII and Korean Hangul validation with every package tag checked', () => {
  for (const body of [
    '- [fleet-console] Add 한글.\n  ko: 한글 요약.',
    '- [fleet-console] Add one.\n  ko: Korean only.',
    '- [fleet-console] [unknown] Add one.\n  ko: 한글 요약.',
    '- [fleet-console]   [fleet-infra] Add one.\n  ko: 한글 요약.',
  ]) {
    const fixture = createFixture();
    writeFragment(fixture, body);
    const result = run(fixture, '--check');
    assert.notEqual(result.status, 0, body);
  }
});

test('writes both custom targets before deleting fragments', () => {
  const fixture = createFixture();
  writeFragment(fixture, '- [fleet-console] Add one.\n  ko: 하나를 추가합니다.');
  const en = path.join(fixture, 'english.md');
  const ko = path.join(fixture, 'korean.md');
  fs.writeFileSync(en, EMPTY_CHANGELOG);
  fs.writeFileSync(ko, EMPTY_CHANGELOG);
  const result = run(fixture, '--version', '1.2.3', '--date', '2026-07-10', '--changelog', en, '--changelog-ko', ko);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(en, 'utf8'), /Add one\./);
  assert.match(fs.readFileSync(ko, 'utf8'), /하나를 추가합니다\./);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'entry.md')), false);
});

test('does not write either target or delete fragments when either Unreleased section is dirty', () => {
  const fixture = createFixture();
  writeFragment(fixture, '- [fleet-console] Add one.\n  ko: 하나를 추가합니다.');
  fs.writeFileSync(path.join(fixture, 'CHANGELOG.ko.md'), EMPTY_CHANGELOG.replace('## [0.1.0]', 'pending\n\n## [0.1.0]'));
  const result = run(fixture, '--version', '1.2.3', '--date', '2026-07-10');
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(fixture, 'CHANGELOG.md'), 'utf8'), EMPTY_CHANGELOG);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'entry.md')), true);
});

test('restores both changelogs and preserves fragments when the second write partially fails', () => {
  const fixture = createFixture();
  writeFragment(fixture, '- [fleet-console] Add one.\n  ko: 하나를 추가합니다.');
  const englishPath = path.join(fixture, 'CHANGELOG.md');
  const koreanPath = path.join(fixture, 'CHANGELOG.ko.md');
  const originalEnglish = fs.readFileSync(englishPath, 'utf8');
  const originalKorean = fs.readFileSync(koreanPath, 'utf8');
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (targetPath, content, ...options) => {
    if (targetPath === koreanPath && typeof content === 'string' && content.includes('## [1.2.3]')) {
      originalWriteFileSync(targetPath, 'PARTIAL', ...options);
      throw new Error('ENOSPC');
    }
    return originalWriteFileSync(targetPath, content, ...options);
  };

  try {
    assert.throws(() => writeChangelogs({
      allowEmpty: false,
      changelogKoPath: koreanPath,
      changelogPath: englishPath,
      date: '2026-07-10',
      version: '1.2.3',
    }, [{
      enSummary: 'Add one.',
      koSummary: '하나를 추가합니다.',
      section: 'Added',
      tagPrefix: '[fleet-console] ',
    }]), /ENOSPC/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(fs.readFileSync(englishPath, 'utf8'), originalEnglish);
  assert.equal(fs.readFileSync(koreanPath, 'utf8'), originalKorean);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'entry.md')), true);
});

test('rejects identical English and Korean write targets', () => {
  const fixture = createFixture();
  writeFragment(fixture, '- [fleet-console] Add one.\n  ko: 하나를 추가합니다.');
  const result = run(fixture, '--version', '1.2.3', '--changelog', 'CHANGELOG.md', '--changelog-ko', 'CHANGELOG.md');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'entry.md')), true);
});

test('allow-empty supports check, dry-run, and dual write stubs', () => {
  const fixture = createFixture(false);
  assert.equal(run(fixture, '--check', '--allow-empty').status, 0);
  const preview = run(fixture, '--dry-run', '--allow-empty', '--version', '1.2.3', '--date', '2026-07-10');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /=== CHANGELOG\.ko\.md ===[\s\S]*Release v1\.2\.3/);
  const write = run(fixture, '--allow-empty', '--version', '1.2.3', '--date', '2026-07-10');
  assert.equal(write.status, 0, write.stderr);
  assert.match(fs.readFileSync(path.join(fixture, 'CHANGELOG.md'), 'utf8'), /Release v1\.2\.3/);
  assert.match(fs.readFileSync(path.join(fixture, 'CHANGELOG.ko.md'), 'utf8'), /Release v1\.2\.3/);
});

function createFixture(withFragmentDirectory = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-changelog-'));
  fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), EMPTY_CHANGELOG);
  fs.writeFileSync(path.join(directory, 'CHANGELOG.ko.md'), EMPTY_CHANGELOG);
  if (withFragmentDirectory) fs.mkdirSync(path.join(directory, '.changelog.d'));
  return directory;
}

function writeFragment(directory, body) {
  fs.writeFileSync(path.join(directory, '.changelog.d', 'entry.md'), `---\nsection: Added\n---\n\n${body}\n`);
}

function run(directory, ...args) {
  return spawnSync(process.execPath, [COMPILER, ...args], { cwd: directory, encoding: 'utf8' });
}
