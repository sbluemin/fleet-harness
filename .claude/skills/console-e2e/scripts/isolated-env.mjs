#!/usr/bin/env node
/**
 * Run one command with an owned HOME and Fleet/Claude state, never the real user's (references/setup.md#keep-the-real-home-out).
 *
 *   node isolated-env.mjs --run-dir <abs-owned-dir> [--bin <name|abs-path>]... [--set NAME=VALUE]... [--check] -- <command> [args...]
 *
 * The child gets a fresh environment, not the caller's: HOME, TMPDIR, FLEET_DATA_DIR, FLEET_CONSOLE_DATA_DIR,
 * FLEET_DESKTOP_DATA_DIR and CLAUDE_CONFIG_DIR all point under <run-dir> (home, tmp, root, console, desktop, claude),
 * plus USER/LOGNAME, LANG, SHELL, TERM and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1. PATH is a fresh per-call
 * <run-dir>/pathbin/call-*, which links only this Node and this call's --bin (resolved on the caller's PATH), then the
 * system directories; another call on the same run dir never changes it. A Node version
 * manager's directory often holds globally installed agent CLIs, so it is never put on PATH whole; name an agent CLI
 * explicitly with --set CLAUDE_BIN=... instead. A shell the run starts (the Console Shell surface, `zsh -i`) reads and
 * writes history and startup files under <run-dir>/home.
 *
 * It refuses a run dir, --bin, or --set path (each `:`-separated segment; a relative one resolved against the cwd) inside the real home's
 * agent, Fleet, shell, or credential stores, or inside an inherited Fleet or Claude directory, and refuses `~` in a
 * --set value because nothing expands it. It refuses --set for managed names and credential-like names; the one
 * exception is a known local placeholder (ANTHROPIC_API_KEY=sk-ant-fleet-local), which is not a credential. --check
 * prints the plan and runs nothing. Otherwise it forwards SIGINT/SIGTERM/SIGHUP, exits with the child's status, and
 * prints which entries appeared in the owned home. It does not isolate the macOS Keychain, launchd session keys, or
 * network access.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { constants, userInfo } from 'node:os';
import path from 'node:path';

// State and credential stores only: executables legitimately live under ~/.local or a version manager's directory.
const PROTECTED_HOME_ENTRIES = [
  '.claude', '.claude.json', '.fleet', '.codex', '.agent-browser', '.config', '.ssh', '.gnupg',
  '.aws', '.docker', '.kube', '.netrc', '.npmrc', '.gitconfig', '.git-credentials',
  'Library/Keychains', 'Library/Application Support',
  '.zsh_history', '.zsh_sessions', '.zshrc', '.zshenv', '.zprofile', '.zlogin',
  '.bash_history', '.bash_sessions', '.bashrc', '.bash_profile', '.profile', '.history',
];
const MANAGED = ['HOME', 'TMPDIR', 'FLEET_DATA_DIR', 'FLEET_CONSOLE_DATA_DIR', 'FLEET_CONSOLE_DIR', 'FLEET_DESKTOP_DATA_DIR',
  'CLAUDE_CONFIG_DIR', 'PATH', 'USER', 'LOGNAME', 'ZDOTDIR', 'HISTFILE', 'INIT_CWD'];
const REFUSED_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|COOKIE|SESSION_ACCESS|^ANTHROPIC_|^OPENAI_|^AWS_|^CLAUDE_SECURESTORAGE_CONFIG_DIR$|^CLAUDE_CODE_CHILD_SESSION$|^SSH_AUTH_SOCK$/i;
// Fixed, publicly documented local placeholders. Anything else under a credential-like name is refused.
const PLACEHOLDERS = { ANTHROPIC_API_KEY: 'sk-ant-fleet-local' };
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const OWNED_DIRS = ['home', 'tmp', 'root', 'console', 'desktop', 'claude', 'pathbin'];

function fail(message) {
  process.stderr.write(`isolated-env: ${message}\n`);
  process.exit(1);
}

/** Resolve symlinks of the longest existing prefix, so a link into a protected store is caught before it exists. */
function resolveReal(target) {
  let existing = target;
  const rest = [];
  while (!existsSync(existing)) {
    rest.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const options = { bins: [], sets: [], check: false };
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === '--check') { options.check = true; continue; }
    const value = flags[i + 1];
    if (value === undefined) fail(`${flag} needs a value`);
    if (flag === '--run-dir') options.runDir = value;
    else if (flag === '--bin') options.bins.push(value);
    else if (flag === '--set') options.sets.push(value);
    else fail(`unknown flag ${JSON.stringify(flag)}`);
    i += 1;
  }
  if (!options.runDir) fail('--run-dir is required');
  if (command.length === 0 && !options.check) fail('expected -- <command> [args...]');
  return { options, command };
}

function main() {
  const { options, command } = parseArgs(process.argv.slice(2));
  const realHome = realpathSync(userInfo().homedir);
  const forbidden = [
    ...PROTECTED_HOME_ENTRIES.map((entry) => path.join(realHome, entry)),
    ...['FLEET_DATA_DIR', 'FLEET_CONSOLE_DATA_DIR', 'FLEET_CONSOLE_DIR', 'FLEET_DESKTOP_DATA_DIR', 'CLAUDE_CONFIG_DIR']
      .map((name) => process.env[name]).filter((value) => value && path.isAbsolute(value)).map(resolveReal),
  ];
  const checkPath = (label, value) => {
    if (!path.isAbsolute(value)) fail(`${label} must be an absolute path`);
    const real = resolveReal(value);
    const hit = forbidden.find((root) => inside(real, root));
    if (hit) fail(`${label} resolves inside a protected or inherited store (${hit}); use an owned scratch directory`);
    return real;
  };
  // A value can carry several paths (`a:b`) or a relative one the child resolves against this cwd.
  const checkSetValue = (name, value) => {
    for (const segment of value.split(path.delimiter)) {
      if (segment.startsWith('~')) fail(`--set ${name} contains "~", which nothing expands; pass an absolute owned path`);
      // The child runs in this cwd, so a bare relative segment such as `.claude/x` names a path there too.
      if (segment) checkPath(`--set ${name}`, path.resolve(segment));
    }
  };

  const runDir = checkPath('--run-dir', options.runDir);
  if (inside(realHome, runDir)) fail('--run-dir must not be the real home or one of its ancestors');
  const owned = Object.fromEntries(OWNED_DIRS.map((name) => [name, path.join(runDir, name)]));

  const links = { node: process.execPath };
  for (const bin of options.bins) {
    const bare = !path.isAbsolute(bin) && path.basename(bin) === bin;
    const source = bare ? findOnPath(bin) : bin;
    if (!source || !path.isAbsolute(source) || !existsSync(source)) {
      fail(`--bin ${JSON.stringify(bin)} is not an executable name on PATH or an existing absolute path`);
    }
    links[path.basename(source)] = checkPath(`--bin ${bin}`, source);
  }

  const env = {
    HOME: owned.home,
    TMPDIR: owned.tmp,
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    LANG: process.env.LANG || 'en_US.UTF-8',
    SHELL: process.env.SHELL || '/bin/zsh',
    TERM: process.env.TERM || 'xterm-256color',
    PATH: [path.join(owned.pathbin, 'call-<per-call>'), ...SYSTEM_PATH].join(path.delimiter),
    FLEET_DATA_DIR: owned.root,
    FLEET_CONSOLE_DATA_DIR: owned.console,
    FLEET_DESKTOP_DATA_DIR: owned.desktop,
    CLAUDE_CONFIG_DIR: owned.claude,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const setNames = [];
  for (const assignment of options.sets) {
    const eq = assignment.indexOf('=');
    if (eq < 1) fail(`--set expects NAME=VALUE, got ${JSON.stringify(assignment.split('=')[0])}`);
    const name = assignment.slice(0, eq);
    const value = assignment.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`invalid variable name ${JSON.stringify(name)}`);
    if (MANAGED.includes(name)) fail(`${name} is managed by isolated-env; it cannot be overridden`);
    if (REFUSED_NAME.test(name) && PLACEHOLDERS[name] !== value) {
      fail(`${name} looks like a credential or session handle; it is never forwarded${name in PLACEHOLDERS ? ` (only the local placeholder ${PLACEHOLDERS[name]} is allowed)` : ''}`);
    }
    checkSetValue(name, value);
    env[name] = value;
    setNames.push(name);
  }

  const plan = {
    runDir,
    owned,
    pathbin: Object.fromEntries(Object.entries(links)),
    path: env.PATH,
    shell: env.SHELL,
    set: setNames,
    command: command.length ? path.basename(command[0]) : null,
  };
  if (options.check) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  for (const dir of Object.values(owned)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Per call: a shared pathbin would let one call's --bin claude reach a fake-only host started earlier on this run.
  const callBin = mkdtempSync(path.join(owned.pathbin, 'call-'));
  for (const [name, source] of Object.entries(links)) symlinkSync(source, path.join(callBin, name));
  env.PATH = [callBin, ...SYSTEM_PATH].join(path.delimiter);
  const before = new Set(readdirSync(owned.home));
  process.stderr.write(`isolated-env: HOME=${owned.home} bins=[${Object.keys(links).join(',')}] set=[${setNames.join(',')}] running ${plan.command}\n`);
  const child = spawn(command[0], command.slice(1), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  const dropCallBin = () => rmSync(callBin, { recursive: true, force: true });
  child.on('error', (error) => { dropCallBin(); fail(`cannot start ${plan.command}: ${error.message}`); });
  child.on('exit', (code, signal) => {
    dropCallBin();
    const appeared = readdirSync(owned.home).filter((entry) => !before.has(entry));
    process.stderr.write(`isolated-env: ${plan.command} exited ${signal ?? code}; new entries in owned home: [${appeared.join(', ')}]\n`);
    process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
  });
}

main();
