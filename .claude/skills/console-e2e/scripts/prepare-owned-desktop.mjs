#!/usr/bin/env node
/**
 * Prepare one owned dev Desktop and hand it to launch-owned-desktop.mjs in one call
 * (references/desktop/setup.md#preflight-and-ownership). The caller passes the worktree,
 * the owned run directory, the two loopback ports the launch will use, and an explicit
 * agent-CLI choice; this helper derives the fixed owned environment and never prints the
 * composed launch command for the caller to copy.
 *
 *   node prepare-owned-desktop.mjs <worktree> --run-dir <abs-owned-run> \
 *     --cdp-port <n> --inspector-port <n> --agent-cli fake|absent [--dry-run] [--json]
 *
 * The run directory, its owned slots, and both binaries come from
 * `isolated-env.mjs --run-dir <run> --bin pnpm --check`, so containment, session ownership,
 * symlink resolution, and the socket-path length keep their existing checks. --agent-cli is
 * required and has no real-CLI value: `fake` selects <worktree>/.claude/skills/console-e2e/
 * scripts/fake-claude.mjs with FAKE_CLAUDE_DIR under the run, and `absent` points CLAUDE_BIN
 * and CODEX_BIN at missing paths under the run. Nothing resolves an agent CLI from PATH.
 *
 * Without --dry-run it claims the run directory with `isolated-env.mjs --run-dir <run> -- true`
 * (the documented claim), writes a stable <run>/pathbin/desktop-<digest> holding only the node
 * and pnpm links, and only creates slots that do not exist yet: an existing link directory is
 * reused when it matches and otherwise refused, so a host that is already running on this run
 * never has its PATH rewritten. It then runs launch-owned-desktop.mjs with argv and cwd fixed to
 * the worktree, and no shell, so an argument containing spaces is passed through unchanged.
 *
 * --dry-run performs only the read-only isolated-env --check: it claims no ownership and creates
 * no directory, file, or link, then delegates to the gate's --dry-run, which runs the read-only
 * preflight and never starts the launch command. That preflight is where both ports are checked;
 * passing --inspector-port does not start an inspector listener, and this helper never adds
 * --inspect to the launch. For the main inspector lane, add it to the pnpm desktop line of the
 * documented manual launch (references/desktop/native-and-package.md#main-inspector-observation-lane).
 *
 * Exit code is the gate's, so preflight exit 20 still means nothing was launched and a dry-run
 * exits with the preflight's 0, 10, or 20. This helper's own refusal exits 20 and prints
 * `prepare-owned-desktop: refused (<reason>); Electron was not started`. Stdout stays the gate's
 * and preflight's output, including --json.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutOf } from './stop-owned-desktop.mjs';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const isolatedEnv = path.join(scripts, 'isolated-env.mjs');
const gate = path.join(scripts, 'launch-owned-desktop.mjs');
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const AGENT_CLI = ['fake', 'absent'];

function refuse(message) {
  const error = new Error(message);
  error.refusal = true;
  throw error;
}

function parse(argv) {
  const [rawWorktree, ...rest] = argv;
  if (!rawWorktree || rawWorktree.startsWith('--')) refuse('a worktree path is required');
  const opts = { rawWorktree, json: false, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json' && !opts.json) { opts.json = true; continue; }
    if (flag === '--dry-run' && !opts.dryRun) { opts.dryRun = true; continue; }
    if (!['--run-dir', '--cdp-port', '--inspector-port', '--agent-cli'].includes(flag) || opts[flag] !== undefined) {
      refuse(`unknown or repeated argument: ${flag}`);
    }
    const value = rest[++i];
    if (!value || value.startsWith('--')) refuse(`${flag} needs a value`);
    opts[flag] = value;
  }
  for (const flag of ['--run-dir', '--cdp-port', '--inspector-port', '--agent-cli']) {
    if (opts[flag] === undefined) refuse(`${flag} is required (references/desktop/setup.md#preflight-and-ownership)`);
  }
  if (!AGENT_CLI.includes(opts['--agent-cli'])) {
    refuse(`--agent-cli must be ${AGENT_CLI.join(' or ')}; a real agent CLI is never selected`);
  }
  if (!path.isAbsolute(opts['--run-dir'])) refuse('--run-dir must be an absolute path');
  return opts;
}

function checkWorktree(rawWorktree) {
  let worktree;
  try {
    worktree = realpathSync(rawWorktree);
  } catch {
    refuse('the worktree is not readable');
  }
  const top = spawnSync('git', ['-C', worktree, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 });
  if (top.error) refuse(`cannot run git: ${top.error.message}`);
  if (top.status !== 0) refuse('the worktree is not a git checkout');
  let resolvedTop;
  try {
    resolvedTop = realpathSync(top.stdout.trim());
  } catch {
    refuse('the worktree top-level is not readable');
  }
  if (resolvedTop !== worktree) refuse('pass the worktree root');
  if (mainCheckoutOf(worktree) === worktree) refuse('the main checkout belongs to the user\'s Desktop; refusing');
  return worktree;
}

/** The isolation contract's own plan: owned slots, chosen Console directory, and the node/pnpm it resolved. */
function checkPlan(opts) {
  const result = spawnSync(process.execPath, [isolatedEnv, '--run-dir', opts['--run-dir'], '--bin', 'pnpm', '--check'], {
    encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) refuse(`cannot run isolated-env --check: ${result.error.message}`);
  if (result.status !== 0) {
    refuse(`isolated-env --check refused (exit ${result.status}): ${(result.stderr || '').trim() || 'no detail'}`);
  }
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    refuse('isolated-env --check returned no plan');
  }
  const owned = plan?.owned;
  if (!plan?.runDir || !owned?.home || !owned?.tmp || !owned?.root || !owned?.console || !owned?.desktop
      || !owned?.claude || !owned?.pathbin || !plan?.pathbin?.node || !plan?.pathbin?.pnpm) {
    refuse('isolated-env --check plan is incomplete');
  }
  if (plan.consoleDataDir !== owned.console) refuse('isolated-env --check selected an unexpected Console directory');
  return plan;
}

/** Record this session as the run directory's owner before the launch, as references/desktop/setup.md instructs. */
function claim(opts) {
  const result = spawnSync(process.execPath, [isolatedEnv, '--run-dir', opts['--run-dir'], '--', 'true'], {
    encoding: 'utf8', timeout: 60_000,
  });
  if (result.error) refuse(`cannot run isolated-env: ${result.error.message}`);
  if (result.status !== 0) {
    refuse(`cannot claim the owned run directory (exit ${result.status}): ${(result.stderr || '').trim() || 'no detail'}`);
  }
}

/** Create only what is missing; never rewrite a directory a running host may already use for its PATH. */
function ensureOwnedDir(dir, label) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  if (!lstatSync(dir).isDirectory()) refuse(`${label} exists and is not an owned directory; refusing to replace it`);
  return dir;
}

function ownedPathbin(plan) {
  const links = { node: plan.pathbin.node, pnpm: plan.pathbin.pnpm };
  // Digest the resolved binaries, so the same pair reuses one directory and a changed pair gets a new one.
  const digest = createHash('sha256').update(`${links.node}\n${links.pnpm}`).digest('hex').slice(0, 8);
  const dir = path.join(plan.owned.pathbin, `desktop-${digest}`);
  const matches = () => Object.entries(links).every(([name, source]) => {
    try {
      return readlinkSync(path.join(dir, name)) === source;
    } catch {
      return false;
    }
  });
  const refuseOtherLinks = () => refuse(`${path.basename(dir)} in the owned pathbin holds other links; a host may be running on them, so choose another run directory`);
  if (existsSync(dir)) {
    if (!lstatSync(dir).isDirectory() || !matches()) refuseOtherLinks();
    return dir;
  }
  try {
    mkdirSync(dir, { mode: 0o700 });
    for (const [name, source] of Object.entries(links)) symlinkSync(source, path.join(dir, name));
  } catch (error) {
    // Of two calls entering together exactly one creates the links; the loser reuses them.
    let usable = false;
    try { usable = error.code === 'EEXIST' && lstatSync(dir).isDirectory() && matches(); } catch { usable = false; }
    if (!usable) refuse(`cannot create ${path.basename(dir)} in the owned pathbin: ${error.message}`);
  }
  return dir;
}

function agentChoice(opts, plan, worktree) {
  if (opts['--agent-cli'] === 'fake') {
    const claudeBin = path.join(worktree, '.claude/skills/console-e2e/scripts/fake-claude.mjs');
    if (!existsSync(claudeBin)) refuse('fake-claude.mjs is missing under the worktree');
    return {
      claudeBin,
      fakeDir: ensureOwnedDir(path.join(plan.runDir, 'fake-claude'), 'FAKE_CLAUDE_DIR'),
      codexBin: path.join(plan.runDir, 'bin', 'codex-absent'),
    };
  }
  // An absent path is a documented choice; no stub and no real CLI is started.
  return {
    claudeBin: path.join(plan.runDir, 'bin', 'claude-absent'),
    fakeDir: null,
    codexBin: path.join(plan.runDir, 'bin', 'codex-absent'),
  };
}

function launchCommand(plan, opts, choice) {
  const assignments = [
    `HOME=${plan.owned.home}`,
    `TMPDIR=${plan.owned.tmp}`,
    `USER=${userInfo().username}`,
    `LANG=${process.env.LANG || 'en_US.UTF-8'}`,
    `PATH=${[plan.pathbinDir, ...SYSTEM_PATH].join(path.delimiter)}`,
    `FLEET_DATA_DIR=${plan.owned.root}`,
    `FLEET_CONSOLE_DATA_DIR=${plan.owned.console}`,
    `FLEET_DESKTOP_DATA_DIR=${plan.owned.desktop}`,
    `FLEET_CONSOLE_NODE_PATH=${plan.pathbin.node}`,
    `CLAUDE_CONFIG_DIR=${plan.owned.claude}`,
    `CLAUDE_BIN=${choice.claudeBin}`,
    ...(choice.fakeDir ? [`FAKE_CLAUDE_DIR=${choice.fakeDir}`] : []),
    `CODEX_BIN=${choice.codexBin}`,
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  ];
  // One argv element per value: no shell parses these, so spaces survive.
  return ['env', '-i', ...assignments, 'pnpm', 'desktop', `--remote-debugging-port=${opts['--cdp-port']}`];
}

function main() {
  const opts = parse(process.argv.slice(2));
  const worktree = checkWorktree(opts.rawWorktree);
  if (!opts.dryRun && !process.env.FLEET_CONSOLE_WORKSPACE_SESSION_ID && !process.env.CLAUDE_CODE_SESSION_ID) {
    refuse('refusing to claim a run without a session id (Fleet Objective or Claude Code session); isolation ownership needs it');
  }
  const plan = checkPlan(opts);

  let command = null;
  if (opts.dryRun) {
    process.stderr.write(`prepare-owned-desktop: dry-run; no ownership claim and no file writes; handing the preflight to launch-owned-desktop\n`);
  } else {
    claim(opts);
    // claim() created the owned slots; this only adds the link directory the Desktop's PATH uses.
    plan.pathbinDir = ownedPathbin(plan);
    const choice = agentChoice(opts, plan, worktree);
    command = launchCommand(plan, opts, choice);
    process.stderr.write(`prepare-owned-desktop: run=${plan.runDir} cdp=${opts['--cdp-port']} inspector=${opts['--inspector-port']} agent-cli=${opts['--agent-cli']}; handing the launch to launch-owned-desktop\n`);
  }

  const gateArgs = [
    gate, worktree,
    '--console-dir', plan.owned.console,
    '--cdp-port', opts['--cdp-port'],
    '--inspector-port', opts['--inspector-port'],
    ...(opts.json ? ['--json'] : []),
    ...(opts.dryRun ? ['--dry-run'] : ['--', ...command]),
  ];
  const child = spawnSync(process.execPath, gateArgs, { stdio: 'inherit', cwd: worktree });
  if (child.error) refuse(`cannot start the launch gate: ${child.error.message}`);
  process.exitCode = child.status === null ? 1 : child.status;
}

try {
  main();
} catch (error) {
  process.stderr.write(`prepare-owned-desktop: refused (${error.message}); Electron was not started\n`);
  process.exitCode = 20;
}
