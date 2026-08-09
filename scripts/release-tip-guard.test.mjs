import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WORKFLOW_RELATIVE_PATH,
  areAllPathsIgnorable,
  changedFiles,
  compilePattern,
  parsePathsIgnore,
} from './release-tip-guard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function workflowPatterns() {
  return parsePathsIgnore(readFileSync(path.join(repoRoot, WORKFLOW_RELATIVE_PATH), 'utf8'));
}

test('reads the release workflow paths-ignore list as the single source of truth', () => {
  const patterns = workflowPatterns();
  assert.ok(patterns.length > 0, 'stable-release.yml must declare paths-ignore');
  assert.ok(patterns.includes('docs/**'));
  assert.ok(patterns.includes('**.md'));
  // 주석과 다음 키를 목록으로 빨아들이지 않는다.
  for (const pattern of patterns) {
    assert.doesNotMatch(pattern, /^#/);
    assert.doesNotMatch(pattern, /:$/);
  }
});

test('stops at the end of the list instead of swallowing following keys', () => {
  const patterns = parsePathsIgnore([
    'on:',
    '  push:',
    '    paths-ignore:',
    "      - 'docs/**'",
    "      - '**.md'",
    '',
    'concurrency:',
    '  group: stable-release-main',
  ].join('\n'));
  assert.deepEqual(patterns, ['docs/**', '**.md']);
});

test('returns nothing when the workflow declares no paths-ignore', () => {
  assert.deepEqual(parsePathsIgnore('on:\n  push:\n    branches:\n      - main\n'), []);
});

test('compiles the directory and extension globs the workflow actually uses', () => {
  const docs = compilePattern('docs/**');
  assert.equal(docs('docs/a/b.txt'), true);
  assert.equal(docs('docs'), true);
  assert.equal(docs('docsite/a.txt'), false, 'prefix must stop at a path boundary');

  const markdown = compilePattern('**.md');
  assert.equal(markdown('README.md'), true);
  assert.equal(markdown('a/b/c.md'), true);
  assert.equal(markdown('a/b/c.mdx'), false);
});

test('refuses a pattern shape it cannot reason about rather than treating it as ignorable', () => {
  assert.throws(() => compilePattern('src/**/*.ts'), /Unsupported paths-ignore pattern/);
});

test('holds the release only when every changed path is declared release-irrelevant', () => {
  const patterns = ['docs/**', '.github/**', '**.md'];
  assert.equal(areAllPathsIgnorable(['docs/a.txt', 'README.md'], patterns), true);
  assert.equal(areAllPathsIgnorable(['docs/a.txt', 'runtime/fleet-console/core/host/server.ts'], patterns), false);
});

test('fails closed when there is nothing to judge with', () => {
  // 패턴을 못 읽었거나 변경이 비어 있으면 "안전하다"고 단정할 근거가 없다.
  assert.equal(areAllPathsIgnorable(['docs/a.txt'], []), false);
  assert.equal(areAllPathsIgnorable([], ['docs/**']), false);
});

test('reads the changed path list from git without a shell', () => {
  const calls = [];
  const files = changedFiles('aaa', 'bbb', {
    execFile: (command, argv) => {
      calls.push({ command, argv });
      return 'docs/a.txt\n\nREADME.md\n';
    },
  });
  assert.deepEqual(files, ['docs/a.txt', 'README.md']);
  assert.deepEqual(calls, [{ command: 'git', argv: ['diff', '--name-only', '--end-of-options', 'aaa', 'bbb'] }]);
});
