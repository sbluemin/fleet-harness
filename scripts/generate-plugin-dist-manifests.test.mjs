import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginDistManifest } from './generate-plugin-dist-manifests.mjs';

test('carries the fields the published host cannot infer from a directory name', () => {
  const manifest = createPluginDistManifest({
    id: 'codex',
    name: 'Codex',
    apiVersion: 1,
    routes: 'routes.ts',
    client: 'client/index.tsx',
    consoleRoutePrefix: 'codex',
  });

  // consoleRoutePrefix가 없으면 `/console/codex` 등록이 스코프 검사에 걸려 콘솔이 부팅하지 못한다.
  assert.equal(manifest.consoleRoutePrefix, 'codex');
  assert.deepEqual(manifest, { id: 'codex', routes: 'routes.mjs', apiVersion: 1, name: 'Codex', consoleRoutePrefix: 'codex' });
});

test('keeps the extra fields a plugin asks the host to redact', () => {
  const manifest = createPluginDistManifest({ id: 'terminal', routes: 'routes.ts', sensitiveFields: ['cwd', 'providerTitle', 7] });

  // 지어낸 매니페스트에는 이 목록이 없어, 고정 목록 밖의 필드가 브라우저 DTO로 나갔다.
  assert.deepEqual(manifest.sensitiveFields, ['cwd', 'providerTitle']);
});

test('points routes at the built bundle, never the TypeScript source', () => {
  // 소스 매니페스트의 routes는 `routes.ts`다. 그대로 옮기면 게시본이 해석에 실패해
  // 플러그인을 통째로 건너뛴다 — 라우트가 없는 것과 같은 증상이 된다.
  assert.equal(createPluginDistManifest({ id: 'ledger', routes: 'routes.ts' }).routes, 'routes.mjs');
  assert.equal(createPluginDistManifest({ id: 'ledger' }).routes, 'routes.mjs');
});

test('omits the client entry, which the web build absorbs', () => {
  assert.equal(createPluginDistManifest({ id: 'quota', client: 'client/index.tsx' }).client, undefined);
});
