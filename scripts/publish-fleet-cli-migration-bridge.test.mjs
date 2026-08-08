import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEPRECATION_MESSAGE,
  FLEET_CLI_PACKAGE,
  FLEET_CONSOLE_PACKAGE,
  MIGRATION_BRIDGE_MARKER,
  createMigrationBridgeManifest,
  createMigrationBridgeReadme,
  publishFleetCliMigrationBridge,
} from './publish-fleet-cli-migration-bridge.mjs';

function createExecFile(handlers) {
  const calls = [];
  const execFile = (command, argv, options = {}) => {
    assert.equal(command, 'npm');
    calls.push({ argv: [...argv], cwd: options.cwd });
    const key = argv.join(' ');
    for (const handler of handlers) {
      if (handler.match(argv)) {
        if (handler.error) {
          const error = new Error(handler.error.message ?? `fail ${key}`);
          error.status = handler.error.status ?? 1;
          error.stdout = handler.error.stdout ?? '';
          error.stderr = handler.error.stderr ?? '';
          throw error;
        }
        return handler.stdout ?? '';
      }
    }
    throw new Error(`unexpected npm invocation: ${key}`);
  };
  return { execFile, calls };
}

test('bridge manifest has no bin or runtime code and pins Console plus the marker', () => {
  const manifest = createMigrationBridgeManifest('1.52.0');
  assert.equal(manifest.name, FLEET_CLI_PACKAGE);
  assert.equal(manifest.version, '1.52.0');
  assert.equal(manifest[MIGRATION_BRIDGE_MARKER], true);
  assert.equal('bin' in manifest, false);
  assert.equal('main' in manifest, false);
  assert.equal('exports' in manifest, false);
  assert.equal('files' in manifest, false);
  assert.deepEqual(manifest.dependencies, {
    [FLEET_CONSOLE_PACKAGE]: '1.52.0',
  });
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.engines.node, '>=20.19.0');
  assert.equal(manifest.repository.url, 'git+https://github.com/sbluemin/fleet-harness.git');
  assert.equal(manifest.homepage, 'https://github.com/sbluemin/fleet-harness#readme');
  assert.equal(manifest.bugs.url, 'https://github.com/sbluemin/fleet-harness/issues');
  assert.match(createMigrationBridgeReadme(), /@dotobokuri\/fleet-console/);
});

test('non-latest tags skip loudly without registry or publish work', async () => {
  const logs = [];
  const { execFile, calls } = createExecFile([]);
  const result = await publishFleetCliMigrationBridge({
    tag: 'beta',
    version: '1.52.0',
    execFile,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.status, 'skipped-non-latest');
  assert.equal(calls.length, 0);
  assert.match(logs.join('\n'), /Skipping.*beta/);
});

test('first latest publish verifies Console, publishes, then deprecates', async () => {
  const written = [];
  const removed = [];
  const { execFile, calls } = createExecFile([
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CONSOLE_PACKAGE}@1.52.0` &&
        argv.includes('version'),
      stdout: JSON.stringify('1.52.0'),
    },
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CLI_PACKAGE}@1.52.0` &&
        argv.includes(MIGRATION_BRIDGE_MARKER),
      error: { status: 1, stderr: 'not found' },
    },
    {
      match: (argv) =>
        argv[0] === 'publish' &&
        argv.includes('--tag') &&
        argv.includes('latest') &&
        argv.includes('--access') &&
        argv.includes('public'),
      stdout: '',
    },
    {
      match: (argv) =>
        argv[0] === 'deprecate' &&
        argv[1] === `${FLEET_CLI_PACKAGE}@1.52.0` &&
        argv[2] === DEPRECATION_MESSAGE,
      stdout: '',
    },
  ]);

  const result = await publishFleetCliMigrationBridge({
    tag: 'latest',
    version: '1.52.0',
    execFile,
    mkdtemp: () => '/tmp/fleet-cli-bridge-test',
    writeFile: (filePath, content) => {
      written.push({ filePath, content: String(content) });
    },
    remove: (targetPath, options) => {
      removed.push({ targetPath, options });
    },
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(
    calls.map((entry) => entry.argv),
    [
      ['view', `${FLEET_CONSOLE_PACKAGE}@1.52.0`, 'version', '--json'],
      ['view', `${FLEET_CLI_PACKAGE}@1.52.0`, MIGRATION_BRIDGE_MARKER, '--json'],
      ['publish', '--tag', 'latest', '--access', 'public'],
      ['deprecate', `${FLEET_CLI_PACKAGE}@1.52.0`, DEPRECATION_MESSAGE],
    ],
  );
  assert.equal(calls[2].cwd, '/tmp/fleet-cli-bridge-test');
  assert.equal(written.length, 2);
  assert.equal(written[0].filePath, '/tmp/fleet-cli-bridge-test/package.json');
  assert.equal(written[1].filePath, '/tmp/fleet-cli-bridge-test/README.md');
  const manifest = JSON.parse(written[0].content);
  assert.equal('bin' in manifest, false);
  assert.deepEqual(manifest.dependencies, { [FLEET_CONSOLE_PACKAGE]: '1.52.0' });
  assert.equal(manifest[MIGRATION_BRIDGE_MARKER], true);
  assert.deepEqual(removed, [
    { targetPath: '/tmp/fleet-cli-bridge-test', options: { recursive: true, force: true } },
  ]);
});

test('distinct target versions each publish independently against mocked registries', async () => {
  const published = [];

  async function publishVersion(version) {
    const { execFile, calls } = createExecFile([
      {
        match: (argv) =>
          argv[0] === 'view' &&
          argv[1] === `${FLEET_CONSOLE_PACKAGE}@${version}` &&
          argv.includes('version'),
        stdout: JSON.stringify(version),
      },
      {
        match: (argv) =>
          argv[0] === 'view' &&
          argv[1] === `${FLEET_CLI_PACKAGE}@${version}` &&
          argv.includes(MIGRATION_BRIDGE_MARKER),
        error: { status: 1, stderr: 'not found' },
      },
      {
        match: (argv) =>
          argv[0] === 'publish' &&
          argv.includes('--tag') &&
          argv.includes('latest') &&
          argv.includes('--access') &&
          argv.includes('public'),
        stdout: '',
      },
      {
        match: (argv) =>
          argv[0] === 'deprecate' &&
          argv[1] === `${FLEET_CLI_PACKAGE}@${version}` &&
          argv[2] === DEPRECATION_MESSAGE,
        stdout: '',
      },
    ]);

    const result = await publishFleetCliMigrationBridge({
      tag: 'latest',
      version,
      execFile,
      mkdtemp: () => `/tmp/fleet-cli-bridge-${version}`,
      writeFile: () => {},
      remove: () => {},
    });

    assert.equal(result.status, 'published');
    assert.equal(result.bridgeVersion, version);
    assert.deepEqual(
      calls.map((entry) => entry.argv),
      [
        ['view', `${FLEET_CONSOLE_PACKAGE}@${version}`, 'version', '--json'],
        ['view', `${FLEET_CLI_PACKAGE}@${version}`, MIGRATION_BRIDGE_MARKER, '--json'],
        ['publish', '--tag', 'latest', '--access', 'public'],
        ['deprecate', `${FLEET_CLI_PACKAGE}@${version}`, DEPRECATION_MESSAGE],
      ],
    );
    published.push(version);
  }

  await publishVersion('1.52.0');
  await publishVersion('1.53.0');
  assert.deepEqual(published, ['1.52.0', '1.53.0']);
});

test('collision at target unmarked fleet-cli fails loudly', async () => {
  const { execFile, calls } = createExecFile([
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CONSOLE_PACKAGE}@1.52.0` &&
        argv.includes('version'),
      stdout: JSON.stringify('1.52.0'),
    },
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CLI_PACKAGE}@1.52.0` &&
        argv.includes(MIGRATION_BRIDGE_MARKER),
      stdout: JSON.stringify(false),
    },
  ]);

  await assert.rejects(
    () =>
      publishFleetCliMigrationBridge({
        tag: 'latest',
        version: '1.52.0',
        execFile,
      }),
    /already exists without fleetMigrationBridge=true/,
  );
  assert.equal(calls.some((entry) => entry.argv[0] === 'publish'), false);
  assert.equal(calls.some((entry) => entry.argv[0] === 'deprecate'), false);
});

test('same target bridge already present is idempotent and only ensures deprecation', async () => {
  const { execFile, calls } = createExecFile([
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CONSOLE_PACKAGE}@1.52.0` &&
        argv.includes('version'),
      stdout: JSON.stringify('1.52.0'),
    },
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CLI_PACKAGE}@1.52.0` &&
        argv.includes(MIGRATION_BRIDGE_MARKER),
      stdout: JSON.stringify(true),
    },
    {
      match: (argv) =>
        argv[0] === 'deprecate' &&
        argv[1] === `${FLEET_CLI_PACKAGE}@1.52.0` &&
        argv[2] === DEPRECATION_MESSAGE,
      stdout: '',
    },
  ]);

  const result = await publishFleetCliMigrationBridge({
    tag: 'latest',
    version: '1.52.0',
    execFile,
  });

  assert.equal(result.status, 'idempotent-existing-bridge');
  assert.equal(result.published, false);
  assert.deepEqual(
    calls.map((entry) => entry.argv),
    [
      ['view', `${FLEET_CONSOLE_PACKAGE}@1.52.0`, 'version', '--json'],
      ['view', `${FLEET_CLI_PACKAGE}@1.52.0`, MIGRATION_BRIDGE_MARKER, '--json'],
      ['deprecate', `${FLEET_CLI_PACKAGE}@1.52.0`, DEPRECATION_MESSAGE],
    ],
  );
});

test('dry-run honors no real publish or deprecate while still planning them', async () => {
  const removed = [];
  const { execFile, calls } = createExecFile([
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CONSOLE_PACKAGE}@1.52.0` &&
        argv.includes('version'),
      stdout: JSON.stringify('1.52.0'),
    },
    {
      match: (argv) =>
        argv[0] === 'view' &&
        argv[1] === `${FLEET_CLI_PACKAGE}@1.52.0` &&
        argv.includes(MIGRATION_BRIDGE_MARKER),
      error: { status: 1, stderr: 'not found' },
    },
  ]);

  const result = await publishFleetCliMigrationBridge({
    tag: 'latest',
    version: '1.52.0',
    dryRun: true,
    execFile,
    mkdtemp: () => '/tmp/fleet-cli-bridge-dry',
    writeFile: () => {},
    remove: (targetPath, options) => {
      removed.push({ targetPath, options });
    },
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(
    calls.map((entry) => entry.argv),
    [
      ['view', `${FLEET_CONSOLE_PACKAGE}@1.52.0`, 'version', '--json'],
      ['view', `${FLEET_CLI_PACKAGE}@1.52.0`, MIGRATION_BRIDGE_MARKER, '--json'],
    ],
  );
  assert.deepEqual(removed, [
    { targetPath: '/tmp/fleet-cli-bridge-dry', options: { recursive: true, force: true } },
  ]);
});
