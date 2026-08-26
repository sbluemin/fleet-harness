import assert from 'node:assert/strict';
import test from 'node:test';

import { collectExternalPackages } from './check-dist-published-externals.mjs';
import { createPublishedFleetConsoleManifest } from './pack-fleet-console-manifest.mjs';

const names = (text) => collectExternalPackages(text).map((entry) => entry.name);

test('collects every specifier form a bundle can ask the runtime to resolve', () => {
  const bundle = [
    `import selfsigned from 'selfsigned';`,
    `import fontList from "font-list";`,
    `import 'side-effect-only';`,
    `export { thing } from 'reexported-pkg';`,
    `const mod = await import('esbuild');`,
    `const pty = nodePtyRequire("node-pty");`,
    `const server = require4("ws");`,
  ].join('\n');

  assert.deepEqual(names(bundle).sort(), [
    'esbuild',
    'font-list',
    'node-pty',
    'reexported-pkg',
    'selfsigned',
    'side-effect-only',
    'ws',
  ]);
});

test('reports the first line each package appears on', () => {
  const bundle = `import a from 'node:fs';\nimport b from 'alpha';\nimport c from 'beta';\nimport d from 'alpha/sub';`;

  assert.deepEqual(collectExternalPackages(bundle), [
    { name: 'alpha', line: 2 },
    { name: 'beta', line: 3 },
  ]);
});

test('ignores builtins whether or not they carry the node: prefix', () => {
  // 번들러가 접두를 벗긴 맨 이름 빌트인도 설치 대상이 아니다 — 그 결함은 다른 게이트가 본다.
  const bundle = `import http from 'node:http';\nimport { EventEmitter } from 'events';\nimport { execFile } from 'child_process';\nconst db = await import('node:sqlite');`;

  assert.deepEqual(names(bundle), []);
});

test('ignores relative and absolute paths', () => {
  const bundle = `import a from './local.mjs';\nimport b from '../sibling/mod.mjs';\nimport c from '/abs/path.mjs';`;

  assert.deepEqual(names(bundle), []);
});

test('folds a subpath import onto its package name', () => {
  const bundle = `import x from '@scope/pkg/deep/entry.js';\nimport y from 'plain-pkg/sub';`;

  assert.deepEqual(names(bundle).sort(), ['@scope/pkg', 'plain-pkg']);
});

test('does not read prose or unrelated calls as specifiers', () => {
  // 지정자 자리에 오지 않은 같은 철자로 빌드를 막으면, 이 게이트가 잡아야 할 결함을
  // 정직하게 진단하려는 후속 수정이 오히려 막힌다.
  const bundle = [
    `throw new Error("failed to load from \\"totally-not-a-package\\"");`,
    `const label = t("chrome.hosts.local");`,
    `const parts = Array.from("abc");`,
    `const note = "imported from a remote host";`,
  ].join('\n');

  assert.deepEqual(names(bundle), []);
});

test('keeps every external the published console install must resolve', () => {
  // 게시 매니페스트는 allowlist라 `pkg.dependencies`를 통째로 교체한다. 여기서 하나가 빠지면
  // 워크스페이스는 green인 채로 게시본만 ERR_MODULE_NOT_FOUND로 죽는다.
  const manifest = createPublishedFleetConsoleManifest({
    name: '@dotobokuri/fleet-console',
    private: true,
    dependencies: {
      'node-pty': '^1.0.0',
      ws: '^8.18.0',
      'font-list': '^2.1.0',
      '@anthropic-ai/claude-agent-sdk': '^0.3.212',
      '@vscode/ripgrep': '1.18.0',
      selfsigned: '^5.5.0',
      esbuild: '0.27.7',
      react: '^19.0.0',
    },
  });

  assert.deepEqual(manifest.dependencies, {
    'node-pty': '^1.0.0',
    ws: '^8.18.0',
    'font-list': '^2.1.0',
    '@anthropic-ai/claude-agent-sdk': '^0.3.212',
    '@vscode/ripgrep': '1.18.0',
    selfsigned: '^5.5.0',
    esbuild: '0.27.7',
  });
});
