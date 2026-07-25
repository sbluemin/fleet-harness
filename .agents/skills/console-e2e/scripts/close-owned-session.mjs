#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, join } from 'node:path';

const SESSION_PATTERN = /^fleet-console-e2e-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const POLL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

function fail(message) {
  process.stderr.write(`close-owned-session: ${message}\n`);
  process.exit(1);
}

function findCommand(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];

  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      try {
        const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;
        accessSync(candidate, mode);
        return { path: candidate, shell: process.platform === 'win32' && ['.bat', '.cmd'].includes(extname(candidate).toLowerCase()) };
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function resolveAgentBrowser() {
  const installed = findCommand('agent-browser');
  if (installed) return { ...installed, prefix: [] };

  const npx = findCommand('npx');
  if (npx) return { ...npx, prefix: ['--yes', 'agent-browser'] };

  fail('agent-browser is not installed and the npx fallback is unavailable');
}

function runAgentBrowser(command, args) {
  const result = spawnSync(
    command.path,
    [...command.prefix, ...args],
    {
      encoding: 'utf8',
      shell: command.shell,
      windowsHide: true,
    },
  );

  return {
    error: result.error,
    status: result.status,
    stdout: result.stdout || '',
  };
}

function listedSessions(command) {
  const result = runAgentBrowser(command, ['session', 'list', '--json']);
  if (result.error || result.status !== 0) {
    return { error: result.error?.message || `exit code ${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const sessions = parsed?.data?.sessions;
    if (!Array.isArray(sessions)) {
      return { error: 'unexpected session list response' };
    }
    return {
      names: sessions.flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (!entry || typeof entry !== 'object') return [];
        const name = entry.name ?? entry.session ?? entry.id;
        return typeof name === 'string' ? [name] : [];
      }),
    };
  } catch {
    return { error: 'invalid JSON from session list' };
  }
}

function readRecordedPid(pidFile) {
  if (!existsSync(pidFile)) return null;

  let value;
  try {
    value = readFileSync(pidFile, 'utf8').trim();
  } catch (error) {
    fail(`cannot read owned session PID metadata: ${error.message}`);
  }

  if (!/^[1-9]\d*$/.test(value)) {
    fail('owned session PID metadata is invalid');
  }

  const pid = Number(value);
  if (!Number.isSafeInteger(pid)) {
    fail('owned session PID metadata is outside the safe integer range');
  }
  return pid;
}

function pidExists(pid) {
  if (process.platform === 'linux') {
    return { exists: existsSync(`/proc/${pid}`) };
  }

  if (process.platform === 'win32') {
    const result = spawnSync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      return { error: result.error?.message || `tasklist exited with code ${result.status}` };
    }
    const pattern = new RegExp(`^"(?:[^"]|"")*","${pid}",`, 'm');
    return { exists: pattern.test(result.stdout || '') };
  }

  const result = spawnSync(
    'ps',
    ['-p', String(pid), '-o', 'pid='],
    { encoding: 'utf8' },
  );
  if (result.error) return { error: result.error.message };
  if (result.status !== 0 && result.status !== 1) {
    return { error: `ps exited with code ${result.status}` };
  }
  const exists = (result.stdout || '').split(/\s+/).includes(String(pid));
  return { exists };
}

function wait(intervalMs) {
  return new Promise((resolve) => setTimeout(resolve, intervalMs));
}

if (process.argv.length !== 3) {
  fail('expected exactly one session id argument');
}

const session = process.argv[2];
if (!SESSION_PATTERN.test(session)) {
  fail('session id must match fleet-console-e2e-[A-Za-z0-9][A-Za-z0-9_-]{0,63}');
}

const command = resolveAgentBrowser();
const pidFile = join(homedir(), '.agent-browser', `${session}.pid`);
const recordedPid = readRecordedPid(pidFile);
const initialList = listedSessions(command);
if (initialList.error) {
  fail(`cannot verify session ownership: ${initialList.error}`);
}

const wasListed = initialList.names.includes(session);
if (!wasListed && recordedPid === null) {
  fail(`unknown owned session "${session}"; check the literal id for a typo`);
}

const closeResult = runAgentBrowser(command, ['--session', session, 'close']);
const deadline = Date.now() + POLL_TIMEOUT_MS;
let lastListError = null;
let lastPidError = null;
let sessionPresent = true;
let pidPresent = recordedPid !== null;

do {
  const currentList = listedSessions(command);
  if (currentList.error) {
    lastListError = currentList.error;
    sessionPresent = true;
  } else {
    lastListError = null;
    sessionPresent = currentList.names.includes(session);
  }

  if (recordedPid !== null) {
    const currentPid = pidExists(recordedPid);
    if (currentPid.error) {
      lastPidError = currentPid.error;
      pidPresent = true;
    } else {
      lastPidError = null;
      pidPresent = currentPid.exists;
    }
  } else {
    pidPresent = false;
  }

  if (!sessionPresent && !pidPresent) {
    process.stdout.write(`Verified cleanup of owned session "${session}".\n`);
    process.exit(0);
  }

  if (Date.now() < deadline) await wait(POLL_INTERVAL_MS);
} while (Date.now() < deadline);

const reasons = [];
if (sessionPresent) reasons.push(`session still listed${lastListError ? ` (${lastListError})` : ''}`);
if (pidPresent) reasons.push(`recorded PID ${recordedPid} still running${lastPidError ? ` (${lastPidError})` : ''}`);
if (closeResult.error || closeResult.status !== 0) {
  reasons.push(`close command failed (${closeResult.error?.message || `exit code ${closeResult.status}`})`);
}
fail(`cleanup verification timed out after 5 seconds: ${reasons.join('; ')}`);
