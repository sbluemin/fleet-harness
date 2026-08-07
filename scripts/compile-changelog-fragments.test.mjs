import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { branchFragmentName, writeChangelogs } from './compile-changelog-fragments.mjs';

const COMPILER = path.resolve('scripts/compile-changelog-fragments.mjs');
const EMPTY_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\nRelease v0.1.0\n';

test('validates adjacent bilingual pairs and renders deterministic dual previews', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Added\n- Add an ASCII summary.\n  ko: 한글 요약을 추가합니다.');
  const result = run(fixture, '--dry-run', '--version', '1.2.3', '--date', '2026-07-10');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^=== CHANGELOG\.md ===\n## \[1\.2\.3\] - 2026-07-10/m);
  assert.match(result.stdout, /### fleet-console\n\n#### Added/);
  assert.match(result.stdout, /- Add an ASCII summary\./);
  assert.match(result.stdout, /=== CHANGELOG\.ko\.md ===[\s\S]*- 한글 요약을 추가합니다\./);
});

test('renders the three runtimes in exact order with nested sections', () => {
  const fixture = createFixture();
  writeBranchFragment(fixture, 'runtime-spread', `### fleet-desktop
#### Added
- Add desktop.
  ko: 데스크톱을 추가합니다.

### fleet-cli
#### Removed
- Remove CLI.
  ko: CLI를 제거합니다.

### fleet-console
#### Changed
- Change console.
  ko: Console을 변경합니다.`);

  const result = run(fixture, '--dry-run', '--version', '1.2.3', '--date', '2026-07-10');

  assert.equal(result.status, 0, result.stderr);
  const positions = ['fleet-cli', 'fleet-console', 'fleet-desktop'].map((heading) => result.stdout.indexOf(`### ${heading}`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.match(result.stdout, /### fleet-cli\n\n#### Removed/);
  assert.match(result.stdout, /### fleet-console\n\n#### Changed/);
  assert.match(result.stdout, /### fleet-desktop\n\n#### Added/);
});

test('rejects the retired fleet-plugin and fleet-core runtime headings', () => {
  for (const product of ['fleet-plugin', 'fleet-core']) {
    const fixture = createFixture();
    writeFragment(fixture, `### ${product}\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.`);
    const result = run(fixture, '--check');
    assert.notEqual(result.status, 0, product);
    assert.match(result.stderr, /unsupported runtime/);
  }
});

test('still compiles a pre-existing pr-number fragment alongside a branch fragment', () => {
  const fixture = createFixture();
  writeRawFragment(fixture, 'pr-545.md', '### fleet-core\n#### Fixed\n- [core-ai-gateway] Drop undeclared tool-call keys.\n  ko: 선언되지 않은 tool 호출 키를 제거합니다.\n');
  writeBranchFragment(fixture, 'runtime-topic', '### fleet-console\n#### Added\n- Add the Console surface.\n  ko: Console 표면을 추가합니다.');

  const result = run(fixture, '--dry-run', '--version', '1.2.3', '--date', '2026-07-10');

  assert.equal(result.status, 0, result.stderr);
  // The runtime headings lead; the package-shaped heading the older fragment was authored under trails them.
  assert.ok(result.stdout.indexOf('### fleet-console') < result.stdout.indexOf('### fleet-core'));
  assert.match(result.stdout, /- \[core-ai-gateway\] Drop undeclared tool-call keys\./);
  assert.match(result.stdout, /- Add the Console surface\./);
});

test('rejects frontmatter on a pre-existing pr-number fragment', () => {
  const fixture = createFixture();
  writeRawFragment(fixture, 'pr-545.md', '---\nbranch: whatever\n---\n\n### fleet-core\n#### Fixed\n- [core-agent] Fix one.\n  ko: 하나를 수정합니다.\n');
  const result = run(fixture, '--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /carries no frontmatter/);
});

test('rejects a bullet that carries a legacy package tag', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Added\n- [fleet-console] Add one.\n  ko: 하나를 추가합니다.');
  const result = run(fixture, '--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not start with a package tag/);
});

test('sorts canary before branch fragments and branch fragments by name', () => {
  const fixture = createFixture();
  writeBranchFragment(fixture, 'zeta-branch', '### fleet-console\n#### Added\n- Add zeta.\n  ko: 제타를 추가합니다.');
  writeBranchFragment(fixture, 'alpha-branch', '### fleet-console\n#### Added\n- Add alpha.\n  ko: 알파를 추가합니다.');
  writeRawFragment(fixture, 'canary.md', '### fleet-console\n#### Added\n- Add canary.\n  ko: 카나리를 추가합니다.\n');

  const result = run(fixture, '--dry-run', '--version', '1.2.3', '--date', '2026-07-10');

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.indexOf('Add canary.') < result.stdout.indexOf('Add alpha.'));
  assert.ok(result.stdout.indexOf('Add alpha.') < result.stdout.indexOf('Add zeta.'));
});

test('ignores local agent doctrine files in the fragments directory', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.');
  fs.writeFileSync(path.join(fixture, '.changelog.d', 'AGENTS.md'), '# Changelog Fragments\n');
  const claudePath = path.join(fixture, '.changelog.d', 'CLAUDE.md');
  const supportsSymlinks = process.platform !== 'win32';
  if (supportsSymlinks) fs.symlinkSync('AGENTS.md', claudePath);

  const result = run(fixture, '--check');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: 1 changelog fragment entry validated\./);
  if (supportsSymlinks) assert.equal(fs.readlinkSync(claudePath), 'AGENTS.md');
});

test('rejects fragment filenames outside the branch-derived shape', () => {
  for (const name of ['PR-235.md', '_leading.md', '-leading.md', 'has_underscore.md', 'has.dot.md']) {
    const fixture = createFixture();
    writeRawFragment(fixture, name, '---\nbranch: whatever\n---\n\n### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.\n');
    const result = run(fixture, '--check');
    assert.notEqual(result.status, 0, name);
  }
});

test('rejects a filename that disagrees with its branch frontmatter', () => {
  const fixture = createFixture();
  writeRawFragment(fixture, 'stale-name.md', '---\nbranch: feat/renamed-branch\n---\n\n### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.\n');
  const result = run(fixture, '--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /derives feat-renamed-branch\.md/);
});

test('requires branch frontmatter on branch fragments and forbids it on canary', () => {
  const missing = createFixture();
  writeRawFragment(missing, 'no-frontmatter.md', '### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.\n');
  const missingResult = run(missing, '--check');
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /missing frontmatter/);

  const canary = createFixture();
  writeRawFragment(canary, 'canary.md', '---\nbranch: canary\n---\n\n### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.\n');
  const canaryResult = run(canary, '--check');
  assert.notEqual(canaryResult.status, 0);
  assert.match(canaryResult.stderr, /must not declare branch frontmatter/);
});

test('rejects malformed fragment structure and bilingual pairs', () => {
  for (const body of [
    '#### Added\n- Add one.\n  ko: 하나를 추가합니다.',
    '### fleet-unknown\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.',
    '### fleet-console\n#### Updated\n- Add one.\n  ko: 하나를 추가합니다.',
    '### fleet-console\n- Add one.\n  ko: 하나를 추가합니다.',
    '### fleet-console\n#### Added\n- Add one.\n\n  ko: 하나를 추가합니다.',
    '### fleet-console\n#### Added\n- Add one.',
    '### fleet-console\n#### Added\n- Add one.\n   ko: 한글 하나.',
    '### fleet-console\n#### Added\n  ko: 고아 항목.',
  ]) {
    const fixture = createFixture();
    writeFragment(fixture, body);
    const result = run(fixture, '--check');
    assert.notEqual(result.status, 0, body);
  }
});

test('retains English ASCII and Korean Hangul validation', () => {
  for (const body of [
    '### fleet-console\n#### Added\n- Add 한글.\n  ko: 한글 요약.',
    '### fleet-console\n#### Added\n- Add one.\n  ko: Korean only.',
  ]) {
    const fixture = createFixture();
    writeFragment(fixture, body);
    const result = run(fixture, '--check');
    assert.notEqual(result.status, 0, body);
  }
});

test('rejects a bracket-leading Korean summary that would be read as a package tag', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Fixed\n- Restore the Shift+Enter shortcut.\n  ko: [Shift]+Enter 단축키를 복구합니다.');
  const result = run(fixture, '--check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not start with a bracket/);
});

test('derives a fragment filename from a branch name', () => {
  assert.equal(branchFragmentName('canary'), 'canary.md');
  assert.equal(branchFragmentName('feat/panel-integrated-chrome'), 'feat-panel-integrated-chrome.md');
  assert.equal(branchFragmentName('feat/researcher_carrier'), 'feat-researcher-carrier.md');
  assert.equal(branchFragmentName('desktop-packaged-boot-fixes'), 'desktop-packaged-boot-fixes.md');
  assert.equal(branchFragmentName('Fix/Rail-Path'), 'fix-rail-path.md');
  assert.equal(branchFragmentName('assets/issue-110'), 'assets-issue-110.md');
  assert.equal(branchFragmentName('  spaced/name  '), 'spaced-name.md');
  assert.equal(branchFragmentName('한글브랜치'), 'branch.md');
  assert.throws(() => branchFragmentName('   '), /Branch name is empty/);
});

test('refuses a branch that normalizes onto the reserved canary filename', () => {
  for (const branch of ['Canary', 'CANARY', 'canary!']) {
    assert.throws(() => branchFragmentName(branch), /reserved filename canary\.md/, branch);
  }
  assert.equal(branchFragmentName('canary'), 'canary.md');
  assert.equal(branchFragmentName('release/Canary'), 'release-canary.md');
});

test('caps a derived filename at sixty slug characters without a trailing hyphen', () => {
  const name = branchFragmentName(`feat/${'a'.repeat(40)}-${'b'.repeat(40)}`);
  assert.equal(name.length, 63);
  assert.ok(!name.startsWith('-') && !name.slice(0, -3).endsWith('-'));

  const cut = branchFragmentName(`${'a'.repeat(59)}/tail`);
  assert.equal(cut, `${'a'.repeat(59)}.md`);
});

test('prints the derived filename for an explicit branch argument', () => {
  const fixture = createFixture();
  const result = run(fixture, '--name-for-branch', 'feat/some-topic');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'feat-some-topic.md');
});

test('writes both custom targets before deleting fragments', () => {
  const fixture = createFixture();
  writeBranchFragment(fixture, 'topic-branch', '### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.');
  const agentsPath = path.join(fixture, '.changelog.d', 'AGENTS.md');
  const claudePath = path.join(fixture, '.changelog.d', 'CLAUDE.md');
  fs.writeFileSync(agentsPath, '# Changelog Fragments\n');
  const supportsSymlinks = process.platform !== 'win32';
  if (supportsSymlinks) fs.symlinkSync('AGENTS.md', claudePath);
  const en = path.join(fixture, 'english.md');
  const ko = path.join(fixture, 'korean.md');
  fs.writeFileSync(en, EMPTY_CHANGELOG);
  fs.writeFileSync(ko, EMPTY_CHANGELOG);
  const result = run(fixture, '--version', '1.2.3', '--date', '2026-07-10', '--changelog', en, '--changelog-ko', ko);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(en, 'utf8'), /Add one\./);
  assert.match(fs.readFileSync(ko, 'utf8'), /하나를 추가합니다\./);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'topic-branch.md')), false);
  assert.equal(fs.existsSync(agentsPath), true);
  if (supportsSymlinks) assert.equal(fs.readlinkSync(claudePath), 'AGENTS.md');
});

test('preserves historical changelog suffixes byte-for-byte when writing a release', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.');
  const historicalSuffix = '## [0.1.0] - 2026-01-01\n\n### Added\n\n- [fleet-console] Historical note.\n';
  const original = `# Changelog\n\n## [Unreleased]\n\n${historicalSuffix}`;
  fs.writeFileSync(path.join(fixture, 'CHANGELOG.md'), original);
  fs.writeFileSync(path.join(fixture, 'CHANGELOG.ko.md'), original);

  const result = run(fixture, '--version', '1.2.3', '--date', '2026-07-10');

  assert.equal(result.status, 0, result.stderr);
  for (const name of ['CHANGELOG.md', 'CHANGELOG.ko.md']) {
    const compiled = fs.readFileSync(path.join(fixture, name), 'utf8');
    assert.equal(compiled.slice(compiled.indexOf(historicalSuffix)), historicalSuffix);
  }
});

test('does not write either target or delete fragments when either Unreleased section is dirty', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.');
  fs.writeFileSync(path.join(fixture, 'CHANGELOG.ko.md'), EMPTY_CHANGELOG.replace('## [0.1.0]', 'pending\n\n## [0.1.0]'));
  const result = run(fixture, '--version', '1.2.3', '--date', '2026-07-10');
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(fixture, 'CHANGELOG.md'), 'utf8'), EMPTY_CHANGELOG);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'topic-branch.md')), true);
});

test('restores both changelogs and preserves fragments when the second write partially fails', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.');
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
      product: 'fleet-console',
      section: 'Added',
    }]), /ENOSPC/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(fs.readFileSync(englishPath, 'utf8'), originalEnglish);
  assert.equal(fs.readFileSync(koreanPath, 'utf8'), originalKorean);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'topic-branch.md')), true);
});

test('rejects identical English and Korean write targets', () => {
  const fixture = createFixture();
  writeFragment(fixture, '### fleet-console\n#### Added\n- Add one.\n  ko: 하나를 추가합니다.');
  const result = run(fixture, '--version', '1.2.3', '--changelog', 'CHANGELOG.md', '--changelog-ko', 'CHANGELOG.md');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(fixture, '.changelog.d', 'topic-branch.md')), true);
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
  writeBranchFragment(directory, 'topic-branch', body);
}

function writeBranchFragment(directory, branch, body) {
  const name = branchFragmentName(branch);
  writeRawFragment(directory, name, `---\nbranch: ${branch}\n---\n\n${body}\n`);
  return name;
}

function writeRawFragment(directory, name, content) {
  fs.writeFileSync(path.join(directory, '.changelog.d', name), content);
}

function run(directory, ...args) {
  return spawnSync(process.execPath, [COMPILER, ...args], { cwd: directory, encoding: 'utf8' });
}
