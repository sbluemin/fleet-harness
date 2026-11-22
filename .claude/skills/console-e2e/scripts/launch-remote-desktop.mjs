#!/usr/bin/env node
/**
 * Launch one host-built Desktop package on a remote Mac over SSH and hold it
 * in the foreground with a loopback-only CDP tunnel.
 *
 *   FLEET_E2E_SSH_TARGET=<ssh-host-alias|user@host> \
 *   node launch-remote-desktop.mjs <worktree> \
 *     --package <abs.zip> --package-sha256 <64hex> --package-revision <rev> \
 *     --run-id <id> --local-port <n> --remote-port <n> \
 *     [--cdp-timeout-ms <n>] [--dry-run] [--json]
 *
 * This tool is remote-only: a missing or invalid FLEET_E2E_SSH_TARGET fails
 * (exit 20) and never falls back to a local launch. Whether to run local or
 * remote is decided by the shared entrypoint, not here.
 *
 * Lifetime: after printing one READY JSON line to stdout, the process stays in
 * the foreground holding the SSH tunnel. While it runs, CDP is usable at
 * http://127.0.0.1:<local-port>/ on this host. It reclaims only the resources
 * this run owns (the remote app tree started here, the tunnel child, and the
 * verified remote run directory) when the remote app exits, the tunnel drops,
 * or this process gets SIGTERM/SIGINT.
 *
 * Ownership and supervision:
 * - The remote run directory is claimed atomically: one `mkdir` (no -p) that
 *   fails when the name is taken, followed by an exclusive ownership marker
 *   (`.e2e-remote-run.json` with runId + nonce) that is read back in the same
 *   step. Reclaim removes the directory only when the marker still matches;
 *   anything else is left alone and reported.
 * - Killing is chain-based for the app tree and marker-based for reparented
 *   processes: a process that lost its tree link still matches only on strict
 *   run-anchored markers (the pinned app executable, `<latest>/dist/cli.mjs`
 *   with `serve`, run-scoped helper prefixes). Command shells (`sh -c ...`)
 *   never qualify on affinity alone, however many owned paths their command
 *   line carries, so generic SSH plumbing is never signalled. Every signal is
 *   preceded by a fresh per-PID re-verification inside the same remote call.
 *   A pid row with no readable command, e.g. `(node)`, is a zombie: dead, with
 *   its pid slot still held, so it cannot have been recycled.
 * - Deletion is gated: the directory goes only with a fresh scan proving no
 *   live owned app/Console/helper remains (tree or reparented), plus a
 *   post-removal re-verification, so a late writer cannot recreate state
 *   after us. A blocked deletion reports incomplete and retries instead.
 * - Completion is strict: only a verified-gone (or never-created) app and
 *   directory count as complete. An unproven state exits non-zero, never 0.
 * - A remote watchdog is tied to a dedicated control SSH connection started
 *   right after the claim. It learns the app PID over its stdin, and when that
 *   connection closes (launcher exit, signal, or network drop) it kills the
 *   owned tree and removes the verified directory itself. The launcher's own
 *   reclaim hands off with `release` only after it verified the directory is
 *   gone, so the watchdog is a backstop, never a second deleter.
 * - In-progress work and reclaim are ordered: an abort flag stops the main
 *   flow after every remote step, in-flight remote commands are killed, and
 *   reclaim runs serialized with retries until it reports complete. No exit
 *   handler sweeps tracked children: a sweep could hit replacements the
 *   reclaim itself just spawned. A signal handler skips its sweep while a
 *   reclaim is already running for the same reason.
 *
 * Safety rules (no exceptions):
 * - The SSH target is the single value of FLEET_E2E_SSH_TARGET (Host alias or
 *   user@host); anything else fails before any connection is opened.
 * - CDP is loopback-only on both ends: the forward is
 *   `-L 127.0.0.1:<local>:127.0.0.1:<remote>`. READY is printed only after a
 *   poll loop (bounded by --cdp-timeout-ms) observes a listener on the remote
 *   port whose PID is the launched app AND whose address is loopback, while
 *   the tunnel is alive, and a `/console/` target answers through the tunnel.
 *   A listener owned by any other PID fails immediately (port-owner mismatch).
 * - A local port that already answers is a conflict (exit 20): this tool opens
 *   no CDP session to it and sends it zero bytes past the TCP handshake.
 * - The package input is explicit (`--package` + `--package-sha256` with a
 *   40-hex `--package-revision` source commit); there is no public-download
 *   fallback. The sha256 is verified on the host and again on the remote side
 *   before extraction. Single-format contract: the zip root holds exactly
 *   fleet-package-identity.json, `Fleet Console.app`, and console/. The
 *   identity in all three places (root, app Contents/Resources, console/) is
 *   verified byte-identical and then field-exact: schemaVersion 1,
 *   kind fleet-remote-mac-package, sourceRevision equal to the CLI 40-hex
 *   revision, bundleId com.dotobokuri.fleet-console, productName Fleet
 *   Console. Info.plist must carry the same bundle ID and revision, and its
 *   executable must be exactly `Fleet Console`, which then runs only at the
 *   pinned `Fleet Console.app/Contents/MacOS/Fleet Console` path.
 * - Before start, the transferred console/ is staged as latest into the
 *   isolated HOME's runtime (<home>/.fleet/desktop/runtime/console/latest)
 *   and the app launches with FLEET_CONSOLE_RELEASE_TAG=source. That tag is
 *   not a release tag, so the packaged release check reports unavailable and
 *   installs nothing: no public Console install or substitution can happen.
 *   Node keeps its existing managed acquisition path.
 * - READY additionally verifies the managed Console child: a descendant of
 *   the app running <latest>/dist/cli.mjs serve, with cwd pinned at the
 *   staged latest and the staged identity intact (sidecar-supervisor spawns
 *   `node cli.mjs serve` with cwd at latest).
 * - FLEET_E2E_SSH_TARGET grants no OS input permission. This tool sends no
 *   input anywhere and changes no host input-protection path.
 * - No waiting on other runs, no lock files, no snapshots: a taken run name
 *   or an occupied port fails immediately.
 * - stdout carries only the READY line; stderr carries only stable error codes
 *   and the reclaim summary. Remote command output, the SSH target, key
 *   material, tokens, and absolute remote home paths are never printed.
 *
 * Remote isolation (cross-checked against the packaged Desktop environment
 * contract, runtime/fleet-desktop/src/environment.ts):
 * - FLEET_CONSOLE_DATA_DIR=<run>/console selects the Console slot
 *   (resolveConsoleDirectoryOverride, honored when packaged).
 * - FLEET_DESKTOP_DATA_DIR=<run>/desktop selects the Desktop userData
 *   (resolveDesktopDataDirectoryOverride, packaged override).
 * - FLEET_DATA_DIR=<run>/fleet-data selects the Fleet root, so legacy
 *   browser-profile state stays under the run
 *   (resolveFleetDataDir/resolveLegacyBrowserProfileRoot); the legacy-profile
 *   migration is skipped while overrides are set.
 * - HOME=<run>/home keeps managed-runtime procurement (resolveRuntimePaths
 *   from os.homedir) and ~/Library resolution under the run, off the remote
 *   user's real home. --user-data-dir=<run>/userData pins Electron's userData.
 * - The managed Console itself is procured by the packaged shell into that
 *   per-run HOME; pinning it to the host revision is the packager's job. This
 *   launcher records package sha256 + revision, the app bundle version, and
 *   the live CDP Browser string so the verifier can prove no substitution.
 *
 * Preconditions on the remote Mac: the SSH user has a logged-in GUI session,
 * plus `ditto`, `plutil`, `shasum` (or `sha256sum`), `lsof`, `ps`, `awk`, `grep`.
 *
 * Exit codes: 0 reclaimed and complete after normal remote exit or SIGTERM;
 * 130 SIGINT with complete reclaim; 1 runtime failure, dropped tunnel, or any
 * incomplete reclaim (never 0 when owned resources may remain); 20 pre-launch
 * refusal before the app was started.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SSH_ENV = 'FLEET_E2E_SSH_TARGET';
const TARGET_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9._-]{0,253}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** CLI revision is the 40-hex source commit; it must match the packaged identity. */
const REVISION_RE = /^[0-9a-f]{40}$/;
const APP_BUNDLE_ID = 'com.dotobokuri.fleet-console';
const APP_DIRNAME = 'Fleet Console.app';
const APP_EXECUTABLE = 'Fleet Console';
const IDENTITY_FILENAME = 'fleet-package-identity.json';
// Identity schema of the host-built package (prepare-remote-mac-package.mjs):
// { schemaVersion: 1, kind: 'fleet-remote-mac-package', sourceRevision,
//   bundleId, productName }. Kept literal here until the shared entrypoint
// single-sources it; the env-contract test pins the behavior instead.
const IDENTITY_SCHEMA = 1;
const IDENTITY_KIND = 'fleet-remote-mac-package';
const IDENTITY_PRODUCT = 'Fleet Console';
const REMOTE_BASENAME = (runId) => `e2e-remote-${runId}`;
const MARKER = '.e2e-remote-run.json';
const DEFAULT_CDP_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ToolError extends Error {
  constructor(code, stable) {
    super(stable);
    this.exitCode = code;
    this.stable = stable;
  }
}

const refuse = (stable) => { throw new ToolError(20, stable); };
const failRun = (stable) => { throw new ToolError(1, stable); };

/** POSIX-shell single-quote an arbitrary string for the remote command line. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function resolveSshTarget(raw) {
  const target = String(raw ?? '').trim();
  if (!target) throw new ToolError(20, 'ssh-selector-missing');
  if (target.length > 300 || !TARGET_RE.test(target) || target.startsWith('-')) {
    throw new ToolError(20, 'ssh-selector-invalid');
  }
  return target;
}

export function parsePort(raw, name) {
  if (!/^\d+$/.test(String(raw ?? ''))) throw new ToolError(20, `${name}-invalid`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ToolError(20, `${name}-invalid`);
  return port;
}

function parseTimeout(raw) {
  if (!/^\d+$/.test(String(raw))) throw new ToolError(20, 'cdp-timeout-invalid');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 300_000) throw new ToolError(20, 'cdp-timeout-invalid');
  return value;
}

export function parseArgs(argv) {
  const [rawWorktree, ...rest] = argv;
  if (!rawWorktree || rawWorktree.startsWith('--')) throw new ToolError(20, 'worktree-required');
  const opts = { rawWorktree, dryRun: false, json: false, cdpTimeoutMs: DEFAULT_CDP_TIMEOUT_MS };
  const valued = new Set(['--package', '--package-sha256', '--package-revision', '--run-id', '--local-port', '--remote-port', '--cdp-timeout-ms']);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--dry-run' && !opts.dryRun) { opts.dryRun = true; continue; }
    if (flag === '--json' && !opts.json) { opts.json = true; continue; }
    if (!valued.has(flag) || opts[flag] !== undefined) throw new ToolError(20, 'arg-unknown-or-repeated');
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new ToolError(20, 'arg-needs-value');
    opts[flag] = value;
  }
  for (const flag of ['--package', '--package-sha256', '--package-revision', '--run-id', '--local-port', '--remote-port']) {
    if (opts[flag] === undefined) throw new ToolError(20, 'arg-required');
  }
  if (!SHA256_RE.test(opts['--package-sha256'])) throw new ToolError(20, 'package-digest-invalid');
  if (!REVISION_RE.test(opts['--package-revision'])) throw new ToolError(20, 'package-revision-invalid');
  if (!RUN_ID_RE.test(opts['--run-id'])) throw new ToolError(20, 'run-id-invalid');
  opts.localPort = parsePort(opts['--local-port'], 'local-port');
  opts.remotePort = parsePort(opts['--remote-port'], 'remote-port');
  if (opts['--cdp-timeout-ms'] !== undefined) opts.cdpTimeoutMs = parseTimeout(opts['--cdp-timeout-ms']);
  if (!path.isAbsolute(opts['--package'])) throw new ToolError(20, 'package-not-absolute');
  if (path.extname(opts['--package']).toLowerCase() !== '.zip') throw new ToolError(20, 'package-not-zip');
  return opts;
}

export function checkWorktree(rawWorktree) {
  try {
    return realpathSync(rawWorktree);
  } catch {
    throw new ToolError(20, 'worktree-unreadable');
  }
}

/** The exact owned remote directory; the only remote path this tool may remove. */
export function ownedRemoteDir(tempRoot, runId) {
  const root = tempRoot.trim().replace(/\/+$/, '');
  if (!root.startsWith('/') || /[\0-\x1f\x7f]/.test(root) || path.posix.normalize(root) !== root) {
    throw new ToolError(20, 'remote-temp-root-unusable');
  }
  return `${root}/${REMOTE_BASENAME(runId)}`;
}

export function assertOwnedRemoteDir(tempRoot, runId, candidate) {
  if (candidate !== ownedRemoteDir(tempRoot, runId)) throw new ToolError(20, 'remote-path-not-owned');
}

/**
 * Parse `lsof -Fcn` listener lines for one port: which PIDs listen, and where.
 * Returns { ownLoopback, foreign } where foreign lists every listener whose
 * PID is not the launched app (any address): adopting one as READY is refused.
 */
export function parseLsofOwnership(lsofOut, port, pid) {
  const ownLoopback = { value: false };
  const foreign = [];
  let currentPid = null;
  const isLoopback = (addr) => /^(127\.\d+\.\d+\.\d+|\[::1\]):/.test(addr);
  for (const rawLine of String(lsofOut).split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('p') && /^\d+$/.test(line.slice(1))) {
      currentPid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith('n') && currentPid !== null) {
      // lsof may append a state suffix ("127.0.0.1:9222 (LISTEN)"); compare the address token only.
      const addr = line.slice(1).split(/[\s(]/)[0];
      if (!addr.endsWith(`:${port}`)) continue;
      if (currentPid === pid) {
        if (isLoopback(addr)) ownLoopback.value = true;
        else foreign.push({ pid: currentPid, addr, reason: 'not-loopback' });
      } else {
        foreign.push({ pid: currentPid, addr, reason: 'other-pid' });
      }
    }
  }
  return { ownLoopback: ownLoopback.value, foreign };
}

/** Parse `ps -ax -o pid= -o ppid= -o command=` into rows (multiline argv may
 * yield unparseable continuation lines, which are dropped). */
export function parsePsTable(text) {
  return String(text).split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]*)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3] } : null;
  }).filter(Boolean);
}

const isZombieCmd = (cmd) => /^\([^()]*\)$/.test(String(cmd).trim());

/**
 * A generic local command shell (`sh -c`, `bash -c`, `zsh -c`): our own
 * plumbing, a transient wrapper, or someone else's shell. Never a signal
 * target on string affinity alone, in any class.
 */
export function isShellCommand(cmd) {
  return /(^|[/ ])(sh|bash|zsh) -c( |$)/.test(String(cmd));
}

/** Executable-path prefix with a boundary (end of command, a space, or a
 * slash for directory prefixes). A program that merely carries the path as
 * an argument never matches. */
export function hasPrefixBoundary(cmd, prefix) {
  if (!prefix) return false;
  const text = String(cmd);
  return text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}/`);
}

export function isExecPrefix(cmd, exePath) {
  return hasPrefixBoundary(cmd, exePath);
}

/**
 * Strict command markers identifying owned app/Console processes. Every
 * marker embeds the run-specific directory, so a sibling run's paths can
 * never match (the `/` after the run id anchors each marker). Null-safe:
 * unknown paths simply match nothing.
 *
 * - exe: the pinned app executable; matched as a command prefix.
 * - nodeCli: `<managed-node> <latest>/dist/cli.mjs serve` prefixes, one per
 *   latest spelling; the managed sidecar runs exactly this argv head.
 * - helpDirs: run-scoped helper directory prefixes (node-pty prebuilds, the
 *   Computer Use helper bundle).
 */
export function orphanMarkers({ appPath, latestDir, latestReal, homeDir }) {
  const markers = { exe: null, nodeCli: [], helpDirs: [] };
  if (appPath) {
    markers.exe = `${appPath}/Contents/MacOS/Fleet Console`;
    markers.helpDirs.push(`${appPath}/Contents/Helpers`);
  }
  const latests = [];
  for (const latest of [latestReal, latestDir]) {
    if (latest && !latests.includes(latest)) latests.push(latest);
  }
  const nodeBin = homeDir ? `${homeDir}/.fleet/desktop/runtime/node/bin/node` : null;
  for (const latest of latests) {
    if (nodeBin) markers.nodeCli.push(`${nodeBin} ${latest}/dist/cli.mjs serve`);
    markers.helpDirs.push(`${latest}/node_modules`);
  }
  return markers;
}

/** True when cmd proves an owned app/Console/helper process that lost its
 * tree link. Command shells never qualify, however many owned paths their
 * command line carries. */
export function isOrphanTarget(cmd, markers) {
  const text = String(cmd);
  if (isShellCommand(text)) return false;
  if (hasPrefixBoundary(text, markers.exe)) return true;
  for (const prefix of [...markers.nodeCli, ...markers.helpDirs]) {
    if (hasPrefixBoundary(text, prefix)) return true;
  }
  return false;
}

/**
 * Split live rows into the root's tree (chain plus directory affinity, never
 * command shells) and marker-proven orphans (reparented processes the chain
 * no longer reaches). Zombie rows are dead in both classes: their pid slot
 * is still held, so it cannot have been recycled to a live process.
 */
export function scanOwnedProcesses(rows, { rootPid, dir, markers }) {
  const byPid = new Map();
  const byParent = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row.pid);
  }
  const inTree = new Set();
  if (Number.isSafeInteger(rootPid) && rootPid > 0) {
    inTree.add(rootPid);
    const queue = [rootPid];
    while (queue.length) {
      for (const child of byParent.get(queue.pop()) ?? []) {
        if (!inTree.has(child)) {
          inTree.add(child);
          queue.push(child);
        }
      }
    }
  }
  const tree = [];
  const orphans = [];
  for (const row of rows) {
    if (row.pid <= 0 || isZombieCmd(row.cmd) || isShellCommand(row.cmd)) continue;
    if (inTree.has(row.pid)) {
      if (row.cmd.includes(dir)) tree.push(row.pid);
    } else if (isOrphanTarget(row.cmd, markers)) {
      orphans.push(row.pid);
    }
  }
  return { tree, orphans };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Exact identity-document check against the host package contract. */
export function checkIdentityDocument(text, revision) {
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch {
    throw new ToolError(1, 'package-identity-mismatch');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || doc.schemaVersion !== IDENTITY_SCHEMA
      || doc.kind !== IDENTITY_KIND
      || doc.sourceRevision !== revision
      || doc.bundleId !== APP_BUNDLE_ID
      || doc.productName !== IDENTITY_PRODUCT) {
    throw new ToolError(1, 'package-identity-mismatch');
  }
  return doc;
}

/** Exact app-plist check: release bundle, stamped revision, pinned executable. */
export function checkAppPlist(text, identity) {
  const bundleVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? null;
  const bundleExecutable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? null;
  const bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? null;
  const sourceRevision = /<key>FleetSourceRevision<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? null;
  if (bundleId !== identity.bundleId || bundleId !== APP_BUNDLE_ID) throw new ToolError(1, 'package-identity-mismatch');
  if (sourceRevision !== identity.sourceRevision) throw new ToolError(1, 'package-identity-mismatch');
  // Only the contract's executable name is allowed; it runs at the pinned
  // `Fleet Console.app/Contents/MacOS/Fleet Console` path, never elsewhere.
  if (bundleExecutable !== APP_EXECUTABLE) throw new ToolError(1, 'package-identity-mismatch');
  return { bundleVersion, bundleExecutable };
}

/** True when something already answers on 127.0.0.1:port. Connects only; no CDP traffic. */
export function localPortOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const SSH_BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];

/** Remote watchdog: kills the owned tree and removes the verified directory when
 * its stdin (the control SSH connection) closes or it is HUPed. It learns the
 * app PID over stdin (`pid <n>`); `release` exits quietly after the launcher
 * verified its own reclaim. Every destructive step re-verifies ownership. */
const WATCHDOG = `
DIR=$1; RUNID=$2; NONCE=$3; PID=""
EXE="$DIR/pkg/Fleet Console.app/Contents/MacOS/Fleet Console"
APPHELPERS="$DIR/pkg/Fleet Console.app/Contents/Helpers"
refresh_markers() {
  L="$DIR/home/.fleet/desktop/runtime/console/latest"
  LR=""
  if [ -d "$L" ]; then LR=$(cd "$L" 2>/dev/null && /bin/pwd -P 2>/dev/null); fi
  NODEBIN="$DIR/home/.fleet/desktop/runtime/node/bin/node"
  NCLI1=""; NCLI2=""; AUX1=""; AUX2="$APPHELPERS"
  if [ -n "$LR" ]; then
    NCLI1="$NODEBIN $LR/dist/cli.mjs serve"
    AUX1="$LR/node_modules"
  fi
  if [ -d "$L" ]; then
    UNRESOLVED="$NODEBIN $L/dist/cli.mjs serve"
    if [ "$UNRESOLVED" != "$NCLI1" ]; then NCLI2="$UNRESOLVED"; fi
  fi
}
scan() {
  # Values travel via the environment, never argv: otherwise this very scan
  # would match its own command line (which carries every marker) and the
  # deletion gate below could never observe an empty, all-clear listing.
  # Ownership here mirrors the launcher exactly: chain plus directory
  # affinity excluding command shells, or executable prefix boundaries
  # excluding command shells. A program that merely carries an owned path as
  # an argument never qualifies.
  table=$(ps -ax -o pid= -o ppid= -o command= 2>/dev/null) || return 1
  printf '%s\\n' "$table" | \
    W_ROOT="$PID" W_DIR="$DIR" W_EXE="$EXE" \
    W_NCLI1="$NCLI1" W_NCLI2="$NCLI2" W_AUX1="$AUX1" W_AUX2="$AUX2" awk '
  BEGIN {
    root = ENVIRON["W_ROOT"] + 0
    dir = ENVIRON["W_DIR"]; exe = ENVIRON["W_EXE"]
    ncli1 = ENVIRON["W_NCLI1"]; ncli2 = ENVIRON["W_NCLI2"]
    aux1 = ENVIRON["W_AUX1"]; aux2 = ENVIRON["W_AUX2"]
  }
  function prefixed(c, p) {
    if (p == "") return 0
    if (index(c, p) != 1) return 0
    if (length(c) == length(p)) return 1
    s = substr(c, length(p)+1, 1)
    return (s == " " || s == "/")
  }
  function isshell(c) {
    return (c ~ /(^|[\\/ ])(sh|bash|zsh) -c( |$)/)
  }
  {
    pid=$1+0; ppid=$2+0
    line=$0; sub(/^[ \\t]*[0-9]+[ \\t]+[0-9]+[ \\t]+/, "", line)
    if (pid<=0) next
    P[pid]=ppid; C[pid]=line
    CH[ppid]=CH[ppid] " " pid
  }
  END {
    top=0
    if ((root+0)>0) stack[++top]=root+0
    while (top>0) {
      cur=stack[top--]+0
      if (cur<=0 || seen[cur]) continue
      seen[cur]=1
      n=split(CH[cur], a, " ")
      for (i=1;i<=n;i++) if (a[i]!="") stack[++top]=a[i]+0
    }
    for (p in P) {
      cmd=C[p]
      d=cmd; gsub(/^[ \\t]+|[ \\t]+$/, "", d)
      if (d ~ /^\\([^()]*\\)$/) continue
      if (seen[p]) {
        if (!isshell(cmd) && index(cmd, dir)>0) print "T " p
      } else {
        if (isshell(cmd)) continue
        hit=0
        if (prefixed(cmd, exe)) hit=1
        else if (prefixed(cmd, ncli1)) hit=1
        else if (prefixed(cmd, ncli2)) hit=1
        else if (prefixed(cmd, aux1)) hit=1
        else if (prefixed(cmd, aux2)) hit=1
        if (hit) print "O " p
      }
    }
  }'
}
root_known() {
  [ -n "$PID" ] || return 1
  cmd=$(ps -p "$PID" -o command= 2>/dev/null) || return 1
  [ -n "$cmd" ] || return 1
  case "$cmd" in *"$DIR"*) return 0;; *) PID=""; return 1;; esac
}
is_prefixed() { rest=\${1#"$2"}; [ "$rest" != "$1" ] || return 1; case $rest in ''|' '*|'/'*) return 0;; *) return 1;; esac; }
is_shell() { printf '%s' "$1" | grep -E -q '(^|/)(sh|bash|zsh) -c( |$)'; }
sig_one() {
  p=$1
  case $p in ''|*[!0-9]*) return 0;; esac
  cmd=$(ps -p "$p" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//') || return 0
  [ -n "$cmd" ] || return 0
  if [ "$3" = T ]; then
    is_shell "$cmd" && return 0
    case "$cmd" in *"$DIR"*) ;; *) return 0;; esac
  else
    is_shell "$cmd" && return 0
    if is_prefixed "$cmd" "$EXE"; then :;
    elif is_prefixed "$cmd" "$NCLI1"; then :;
    elif is_prefixed "$cmd" "$NCLI2"; then :;
    elif is_prefixed "$cmd" "$AUX1"; then :;
    elif is_prefixed "$cmd" "$AUX2"; then :;
    else return 0; fi
  fi
  kill -s "$2" "$p" 2>/dev/null || true
}
cleanup() {
  refresh_markers
  root_known || true
  round=1
  while [ "$round" -le 4 ]; do
    if [ "$round" -ge 3 ]; then sig=KILL; else sig=TERM; fi
    scan | while read -r class pid; do
      sig_one "$pid" "$sig" "$class"
    done
    sleep 1
    round=$((round+1))
  done
  # Deletion gate: remove only with a successful scan proving no live owned
  # processes remain. A failed scan reads as unknown, never as all-clear.
  if scanned=$(scan); then
    if [ -z "$(printf '%s' "$scanned" | tr -d ' \\n')" ]; then
      M="$DIR/${MARKER}"
      if [ -f "$M" ] && grep -F -q "$RUNID" "$M" 2>/dev/null && grep -F -q "$NONCE" "$M" 2>/dev/null; then
        rm -rf -- "$DIR"
      fi
    fi
  fi
}
trap 'cleanup; exit 0' HUP INT TERM
while IFS= read -r line; do
  case "$line" in pid\\ *) PID=\${line#pid };; release) exit 0;; esac
done
cleanup
`.trim();

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  checkWorktree(opts.rawWorktree);
  const target = resolveSshTarget(process.env[SSH_ENV]);
  const runId = opts['--run-id'];
  const nonce = randomBytes(16).toString('hex');
  const log = (message) => process.stderr.write(`launch-remote-desktop: ${message}\n`);

  const pkg = opts['--package'];
  if (!existsSync(pkg) || !lstatSync(pkg).isFile()) throw new ToolError(20, 'package-missing');
  if ((await sha256File(pkg)) !== opts['--package-sha256']) {
    throw new ToolError(20, 'package-digest-mismatch');
  }
  if (await localPortOccupied(opts.localPort)) {
    throw new ToolError(20, 'local-port-occupied');
  }

  if (opts.dryRun) {
    log(`dry-run ok; selector from ${SSH_ENV} (value withheld); run=${runId} local-port=${opts.localPort} remote-port=${opts.remotePort}`);
    return 0;
  }

  // ---- live state ----------------------------------------------------------
  let tempRoot = null;
  let remoteDir = null;
  let stage = 'start'; // start < claimed < transferred < extracted < launched < ready
  let startedApp = false;
  let launchAttempted = false;
  let remotePid = null;
  let aborted = false;
  let holding = false;
  let exitSignal = null;
  const activeChildren = new Set();
  let tunnel = null;
  let control = null;
  let controlStdinClosed = false;

  const checkAborted = () => {
    if (aborted) {
      throw new ToolError(1, exitSignal === 'SIGTERM' ? 'aborted-sigterm' : exitSignal === 'SIGINT' ? 'aborted-sigint' : 'aborted');
    }
  };

  function stopInFlightCommands() {
    for (const child of activeChildren) {
      // Keep the watchdog connected until primary reclaim finishes. Closing it
      // first would let both the watchdog and the launcher remove the run.
      if (child !== control && child !== tunnel) child.kill('SIGKILL');
    }
  }

  /** Spawn with tracking so shutdown can kill in-flight remote commands first. */
  function tracked(child) {
    activeChildren.add(child);
    child.on('exit', () => activeChildren.delete(child));
    child.on('error', () => activeChildren.delete(child));
    return child;
  }

  function execRemote(remoteCommand, { timeout = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = tracked(spawn('ssh', [...SSH_BASE, target, remoteCommand], { stdio: ['ignore', 'pipe', 'pipe'] }));
      let stdout = '';
      let stderr = '';
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          child.kill('SIGKILL');
          reject(new ToolError(1, 'ssh-timeout'));
        }
      }, timeout);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          const failure = new ToolError(1, 'ssh-spawn-failed');
          failure.cause = error;
          reject(failure);
        }
      });
      child.on('exit', (code) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          // Remote stderr is never surfaced: stable codes only.
          if (code === 0) resolve({ stdout, stderrBytes: Buffer.byteLength(stderr) });
          else reject(new ToolError(1, 'ssh-command-failed'));
        }
      });
    });
  }

  const ssh = async (remoteCommand, stable, options) => {
    try {
      return await execRemote(remoteCommand, options);
    } catch (error) {
      if (error instanceof ToolError && error.stable === stable) throw error;
      if (error instanceof ToolError) throw new ToolError(error.exitCode, stable);
      throw new ToolError(1, stable);
    }
  };

  /** The app executable itself, wherever the tree link points. Used only when
   * the launch PID reply was lost; never matches command shells. */
  async function discoverOwnedPids() {
    if (!remoteDir || !appPath) return [];
    const markers = orphanMarkers({
      appPath,
      latestDir,
      latestReal,
      homeDir: `${remoteDir}/home`,
    });
    try {
      const { stdout } = await execRemote('ps -ax -o pid= -o ppid= -o command=', { timeout: 15_000 });
      const found = [];
      for (const row of parsePsTable(stdout)) {
        if (row.pid > 0 && !isShellCommand(row.cmd) && hasPrefixBoundary(row.cmd, markers.exe)) found.push(row.pid);
      }
      return found;
    } catch {
      return [];
    }
  }

  /** Fresh tree-plus-orphan scan for the deletion gate and the kill rounds. */
  async function snapshotOwned(rootPid) {
    const { stdout } = await execRemote('ps -ax -o pid= -o ppid= -o command=', { timeout: 15_000 });
    return scanOwnedProcesses(parsePsTable(stdout), {
      rootPid,
      dir: remoteDir,
      markers: orphanMarkers({
        appPath,
        latestDir,
        latestReal,
        homeDir: remoteDir ? `${remoteDir}/home` : null,
      }),
    });
  }

  /**
   * One remote script that re-verifies every victim immediately before its
   * signal, with the same conditions as the scan: tree victims by directory
   * affinity excluding command shells, orphans by executable prefix
   * boundaries excluding command shells.
   */
  function buildKillScript({ tree, orphans, dir, markers, signal }) {
    const nums = (list) => list.filter((p) => Number.isSafeInteger(p) && p > 0).join(' ');
    const shellGuard = `printf '%s' "$cmd" | grep -E -q '(^|/)(sh|bash|zsh) -c( |$)'`;
    const orphanTests = [];
    if (markers.exe) orphanTests.push(`is_prefixed "$cmd" ${shQuote(markers.exe)}`);
    for (const prefix of [...markers.nodeCli, ...markers.helpDirs]) {
      orphanTests.push(`is_prefixed "$cmd" ${shQuote(prefix)}`);
    }
    const lines = [
      `is_prefixed() { rest=\${1#"$2"}; [ "$rest" != "$1" ] || return 1; case $rest in ''|' '*|'/'*) return 0;; *) return 1;; esac; }`,
      `fetch_cmd() { cmd=$(ps -p "$1" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//') || return 1; [ -n "$cmd" ] || return 1; }`,
    ];
    if (tree.length > 0) {
      lines.push(`for pid in ${nums(tree)}; do`);
      lines.push(`  fetch_cmd "$pid" || continue`);
      lines.push(`  if ${shellGuard}; then continue; fi`);
      lines.push(`  if printf '%s' "$cmd" | grep -F -q -- ${shQuote(dir)}; then kill -s ${signal} "$pid" 2>/dev/null || true; fi`);
      lines.push(`done`);
    }
    if (orphans.length > 0 && orphanTests.length > 0) {
      lines.push(`for pid in ${nums(orphans)}; do`);
      lines.push(`  fetch_cmd "$pid" || continue`);
      lines.push(`  if ${shellGuard}; then continue; fi`);
      lines.push(`  if ${orphanTests.join(' || ')}; then kill -s ${signal} "$pid" 2>/dev/null || true; fi`);
      lines.push(`done`);
    }
    lines.push('exit 0');
    return lines.join('\n');
  }

  /**
   * Kill the owned app tree and any reparented owned processes. Discovery is
   * chain-based for the tree and marker-based for orphans, and every signal
   * is preceded by a fresh per-PID re-verification inside one remote call.
   */
  async function killOwnedTree(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'not-started';
    const markers = orphanMarkers({
      appPath,
      latestDir,
      latestReal,
      homeDir: remoteDir ? `${remoteDir}/home` : null,
    });
    for (let round = 0; round < 3; round++) {
      let scan;
      try {
        const { stdout } = await execRemote('ps -ax -o pid= -o ppid= -o command=', { timeout: 15_000 });
        scan = scanOwnedProcesses(parsePsTable(stdout), { rootPid: pid, dir: remoteDir, markers });
      } catch {
        return false;
      }
      if (scan.tree.length === 0 && scan.orphans.length === 0) return true;
      const signal = round < 2 ? 'TERM' : 'KILL';
      try {
        await execRemote(
          buildKillScript({ tree: scan.tree, orphans: scan.orphans, dir: remoteDir, markers, signal }),
          { timeout: 30_000 },
        );
      } catch {
        // Keep polling; a dead PID races the kill.
      }
      await sleep(1000);
    }
    const final = await snapshotOwned(pid).catch(() => null);
    if (final === null) return false;
    return final.tree.length === 0 && final.orphans.length === 0 ? true : false;
  }

  // ---- serialized, retryable reclaim ---------------------------------------
  let shuttingDown = false;
  let attempts = 0;
  let lastSummary = null;
  let settledAppGone = false;
  let settledDirGone = false;
  const summaryComplete = (summary) => summary !== null
    && (summary.appGone === true || summary.appGone === 'not-started')
    && (summary.dirGone === true || summary.dirGone === 'not-created');

  async function doShutdown(reason) {
    const summary = {
      reason,
      runId,
      localPort: opts.localPort,
      remotePort: opts.remotePort,
      remoteDirName: remoteDir ? REMOTE_BASENAME(runId) : null,
      appGone: startedApp ? null : 'not-started',
      tunnelGone: tunnel ? null : 'not-started',
      dirGone: remoteDir ? null : 'not-created',
      supervisor: control ? 'control-closed' : 'not-started',
    };
    stopInFlightCommands();
    // A launch whose PID reply was lost (signal during the launch call) may
    // still have started: discover owned PIDs instead of trusting the reply.
    if (launchAttempted && remotePid === null) {
      try {
        const owned = await discoverOwnedPids();
        if (owned.length > 0) {
          remotePid = owned[0];
          startedApp = true;
        }
      } catch { /* discovery is best-effort; the watchdog is the backstop */ }
    }
    if (startedApp && remotePid !== null) {
      try {
        const result = await killOwnedTree(remotePid);
        summary.appGone = result === true ? true : result;
      } catch {
        summary.appGone = false;
      }
      // Kept until after the deletion gate below so the gate still sees the
      // tree; orphans are root-independent and cover a live app regardless.
    }
    if (tunnel) {
      try {
        tunnel.kill('SIGKILL');
        summary.tunnelGone = true;
      } catch {
        summary.tunnelGone = false;
      }
      tunnel = null;
    }
    if (remoteDir) {
      try {
        assertOwnedRemoteDir(tempRoot, runId, remoteDir);
        const markerPath = `${remoteDir}/${MARKER}`;
        const { stdout: marker } = await execRemote(
          `cat ${shQuote(markerPath)} 2>/dev/null || true`, { timeout: 15_000 },
        ).catch(() => ({ stdout: '' }));
        let markerOk = false;
        try {
          const parsed = JSON.parse(marker);
          markerOk = parsed.runId === runId && parsed.nonce === nonce;
        } catch {
          markerOk = false;
        }
        if (markerOk) {
          // Deletion gate: no live owned app/Console/helper may remain, whether
          // still in the tree or reparented. Deleting under a live writer lets
          // it recreate state (e.g. console/) after us, so a blocked deletion
          // reports incomplete and retries instead.
          const live = await snapshotOwned(remotePid).catch(() => null);
          if (live === null || live.tree.length > 0 || live.orphans.length > 0) {
            summary.dirGone = false;
            summary.dirBlockedBy = live === null ? 'scan-failed'
              : { tree: live.tree.length, orphans: live.orphans.length };
          } else {
            await execRemote(
              `test ! -L ${shQuote(remoteDir)} && rm -rf -- ${shQuote(remoteDir)} && test ! -e ${shQuote(remoteDir)}`,
              { timeout: 30_000 },
            );
            // A dying writer could still recreate state in the gap: re-verify
            // after a breath before calling the directory gone.
            await sleep(2000);
            await execRemote(`test ! -e ${shQuote(remoteDir)}`, { timeout: 15_000 });
            summary.dirGone = true;
          }
        } else {
          // Never delete a directory whose ownership proof is missing: it may
          // belong to another run after a partial claim. Report, do not touch.
          const { stdout: listing } = await execRemote(
            `test ! -e ${shQuote(remoteDir)} && printf gone || printf present`, { timeout: 15_000 },
          ).catch(() => ({ stdout: 'unknown' }));
          summary.dirGone = listing.trim() === 'gone' ? true : 'marker-unverified-left-alone';
          if (summary.dirGone !== true) summary.dirGone = false;
        }
      } catch {
        summary.dirGone = false;
      }
      remotePid = null;
    }
    if (control && !controlStdinClosed) {
      controlStdinClosed = true;
      try {
        if (summary.dirGone === true) control.stdin.write('release\n');
      } catch { /* the backstop then owns cleanup */ }
      try { control.stdin.end(); } catch { /* already closed */ }
      await sleep(1500);
      try {
        control.kill('SIGKILL');
      } catch { /* already gone */ }
      control = null;
    }
    // Verified-gone is monotonic within one run: nothing recreates the app or
    // the directory after they were verified gone, so a later attempt that has
    // nothing left to check keeps the earlier proof instead of reporting
    // unknown. A verified-present (false) is never upgraded.
    if (summary.appGone === true) settledAppGone = true;
    else if (settledAppGone && summary.appGone === null) summary.appGone = true;
    if (summary.dirGone === true) settledDirGone = true;
    else if (settledDirGone && summary.dirGone === null) summary.dirGone = true;
    process.stderr.write(`remote-reclaim: ${JSON.stringify(summary)}\n`);
    return summary;
  }

  async function shutdown(reason) {
    while (shuttingDown) await sleep(200);
    if (lastSummary && summaryComplete(lastSummary)) return lastSummary;
    if (attempts >= 3) return lastSummary;
    shuttingDown = true;
    attempts += 1;
    try {
      lastSummary = await doShutdown(reason);
    } finally {
      shuttingDown = false;
    }
    if (!summaryComplete(lastSummary) && attempts < 3) {
      await sleep(500);
      return shutdown(`${reason}/retry`);
    }
    return lastSummary;
  }

  // One exiter only: the main flow. A signal sets the abort flag and, unless a
  // reclaim is already running (whose fresh children must not be hit),
  // kills in-flight remote commands so the flow unblocks; the main flow joins
  // the serialized reclaim and returns the single exit code.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      aborted = true;
      exitSignal = signal;
      if (!shuttingDown) stopInFlightCommands();
      if (holding || startedApp || launchAttempted) void shutdown(signal === 'SIGTERM' ? 'sigterm' : 'sigint');
    });
  }

  const exitCodeFor = (summary, base) => (summaryComplete(summary) ? base : 1);

  try {
    // ---- claim (atomic mkdir + exclusive marker, verified in one step) -----
    {
      try {
        tempRoot = (await execRemote('/usr/bin/getconf DARWIN_USER_TEMP_DIR', { timeout: 15_000 })).stdout;
      } catch {
        throw new ToolError(20, 'ssh-unreachable');
      }
      remoteDir = ownedRemoteDir(tempRoot, runId);
      const q = shQuote(remoteDir);
      const markerJson = shQuote(JSON.stringify({ schema: 1, kind: 'e2e-remote-run', runId, nonce }));
      let claimOut;
      try {
        claimOut = await execRemote(
          `umask 077; mkdir ${q} || exit 1; `
          + `if ! printf '%s' ${markerJson} > ${q}/${MARKER}; then rm -f ${q}/${MARKER}; rmdir ${q}; exit 1; fi; `
          + `cat ${q}/${MARKER}`,
          { timeout: 30_000 },
        );
      } catch {
        // mkdir without -p fails when the name is taken. Never remove a
        // directory unless the marker proves this invocation created it.
        let state = 'unknown';
        try {
          const { stdout } = await execRemote(
            `test ! -e ${q} && printf absent || (cat ${q}/${MARKER} 2>/dev/null || printf no-marker)`,
            { timeout: 15_000 },
          );
          state = stdout;
        } catch { /* leave state unknown */ }
        if (state === 'absent') throw new ToolError(20, 'claim-failed');
        let parsed = null;
        try { parsed = JSON.parse(state); } catch { parsed = null; }
        if (parsed && parsed.runId === runId && parsed.nonce === nonce) {
          throw new ToolError(20, 'claim-retry-needed');
        }
        throw new ToolError(20, 'remote-dir-exists');
      }
      let markerOk = false;
      try {
        const parsed = JSON.parse(claimOut.stdout);
        markerOk = parsed.runId === runId && parsed.nonce === nonce;
      } catch {
        markerOk = false;
      }
      if (!markerOk) throw new ToolError(20, 'claim-unverified');
      stage = 'claimed';
    }
    checkAborted();

    // ---- supervisor tied to the control connection's lifetime --------------
    control = tracked(spawn('ssh', [...SSH_BASE, target,
      `sh -c ${shQuote(WATCHDOG)} watchdog ${shQuote(remoteDir)} ${shQuote(runId)} ${shQuote(nonce)}`,
    ], { stdio: ['pipe', 'ignore', 'ignore'] }));
    // If the supervisor connection drops on its own, the remote watchdog owns
    // cleanup from there: stop working and let the failure path reclaim. The
    // tunnel is useless without it, so closing the tunnel trips the hold race
    // at once. No sweep here: killing tracked children from this handler
    // could hit replacements the reclaim itself just spawned.
    control.on('error', () => {});
    control.on('exit', () => {
      if (!controlStdinClosed) {
        aborted = true;
        try { tunnel?.kill('SIGTERM'); } catch { /* already gone */ }
      }
    });
    checkAborted();

    // ---- remote port must be free before anything listens on it ------------
    try {
      await execRemote(
        `python3 -c ${shQuote(`import socket,sys;s=socket.socket();s.settimeout(2);sys.exit(0 if s.connect_ex(("127.0.0.1",${opts.remotePort}))!=0 else 1)`)}`,
        { timeout: 30_000 },
      );
    } catch {
      throw new ToolError(20, 'remote-port-occupied');
    }
    checkAborted();

    // ---- transfer + verify --------------------------------------------------
    await new Promise((resolve, reject) => {
      const child = tracked(spawn('scp',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', pkg, `${target}:${remoteDir}/package.zip`],
        { stdio: 'ignore' }));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ToolError(1, 'transfer-timeout'));
      }, 300_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        const failure = new ToolError(1, 'transfer-failed');
        failure.cause = error;
        reject(failure);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new ToolError(1, 'transfer-failed'));
      });
    });
    checkAborted();
    stage = 'transferred';
    {
      const { stdout } = await ssh(
        `cd ${shQuote(remoteDir)} && (command -v shasum >/dev/null && shasum -a 256 package.zip || sha256sum package.zip)`,
        'digest-remote-unreadable',
        { timeout: 120_000 },
      );
      if (!String(stdout).startsWith(opts['--package-sha256'])) throw new ToolError(1, 'digest-remote-mismatch');
    }
    checkAborted();

    // ---- extract + packaged-identity verification -----------------------------
    // Single-format contract: the zip root holds exactly
    // fleet-package-identity.json, `Fleet Console.app`, and console/.
    // The identity triple is verified byte-identical, then field-exact
    // (checkIdentityDocument); the plist check (checkAppPlist) pins the
    // bundle ID, the revision, and the `Fleet Console` executable name.
    var identityContent = null;
    var stagedConsoleVersion = null;
    {
      const q = shQuote(remoteDir);
      const { stdout: listing } = await ssh(
        `cd ${q} && mkdir pkg && /usr/bin/ditto -x -k package.zip pkg && ls -A pkg`,
        'extract-failed',
        { timeout: 180_000 },
      );
      const entries = String(listing).split('\n').map((line) => line.trim()).filter(Boolean).sort();
      const expected = [APP_DIRNAME, 'console', IDENTITY_FILENAME].sort();
      if (entries.length !== expected.length || !entries.every((entry, index) => entry === expected[index])) {
        throw new ToolError(1, 'package-layout-unexpected');
      }
      var appPath = `${remoteDir}/pkg/${APP_DIRNAME}`;
      const idRoot = `${remoteDir}/pkg/${IDENTITY_FILENAME}`;
      const idApp = `${appPath}/Contents/Resources/${IDENTITY_FILENAME}`;
      const idConsole = `${remoteDir}/pkg/console/${IDENTITY_FILENAME}`;
      const { stdout: digests } = await ssh(
        `(command -v shasum >/dev/null && shasum -a 256 ${shQuote(idRoot)} ${shQuote(idApp)} ${shQuote(idConsole)} `
        + `|| sha256sum ${shQuote(idRoot)} ${shQuote(idApp)} ${shQuote(idConsole)})`,
        'package-identity-unreadable',
        { timeout: 30_000 },
      );
      const hashes = String(digests).split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
      if (hashes.length !== 3 || !(hashes[0] === hashes[1] && hashes[1] === hashes[2])) {
        throw new ToolError(1, 'package-identity-mismatch');
      }
      const { stdout: identity } = await ssh(`cat ${shQuote(idRoot)}`, 'package-identity-unreadable', { timeout: 30_000 });
      // The triple digest above proves all three files byte-identical, so the
      // exact field check on this copy covers all three places.
      var identityDoc = checkIdentityDocument(String(identity), opts['--package-revision']);
      identityContent = String(identity);
      const { stdout: consolePkg } = await ssh(
        `cat ${shQuote(`${remoteDir}/pkg/console/package.json`)}`,
        'console-payload-incomplete',
        { timeout: 30_000 },
      );
      try {
        const parsed = JSON.parse(String(consolePkg));
        if (typeof parsed.version !== 'string' || !parsed.version) throw new Error('no version');
        stagedConsoleVersion = parsed.version;
      } catch {
        throw new ToolError(1, 'console-payload-incomplete');
      }
      await ssh(
        `test -f ${shQuote(`${remoteDir}/pkg/console/dist/cli.mjs`)}`,
        'console-payload-incomplete',
        { timeout: 30_000 },
      );
    }
    checkAborted();
    stage = 'extracted';

    // ---- app identity --------------------------------------------------------
    // Only the contract's `Fleet Console` executable is allowed, at the pinned
    // `Fleet Console.app/Contents/MacOS/Fleet Console` path (the packager's
    // EXECUTABLE_RELATIVE_PATH); anything else refuses before any launch.
    var bundleVersion = null;
    var bundleExecutable = null;
    {
      const { stdout: plist } = await ssh(
        `/usr/bin/plutil -convert xml1 -o - ${shQuote(`${appPath}/Contents/Info.plist`)}`,
        'app-identity-unreadable',
        { timeout: 30_000 },
      );
      let checked;
      try {
        checked = checkAppPlist(String(plist), identityDoc);
      } catch (error) {
        if (error instanceof ToolError && error.stable === 'package-identity-mismatch') throw error;
        throw new ToolError(1, 'app-identity-unreadable');
      }
      bundleVersion = checked.bundleVersion;
      bundleExecutable = checked.bundleExecutable;
    }
    checkAborted();

    // ---- stage console/ into the isolated HOME's runtime -----------------------
    // The packaged shell procures its Console from <HOME>/.fleet/desktop/
    // runtime; staging the transferred console/ as latest there, together with
    // FLEET_CONSOLE_RELEASE_TAG=source (an invalid tag, so the release check
    // reports unavailable and installs nothing), blocks any public install or
    // substitution. Node keeps its existing managed acquisition path.
    var latestDir = `${remoteDir}/home/.fleet/desktop/runtime/console/latest`;
    // lsof reports the physical cwd (/private/var vs /var, ...): canonicalize
    // the staged dir the same way so the child check compares equal spellings.
    var latestReal = null;
    {
      const staged = shQuote(latestDir);
      const fromConsole = shQuote(`${remoteDir}/pkg/console`);
      const { stdout: stagedPkg } = await ssh(
        `mkdir -p ${shQuote(`${remoteDir}/home/.fleet/desktop/runtime/console`)} `
        + `&& rm -rf ${staged} && cp -R ${fromConsole} ${staged} `
        + `&& test -f ${staged}/dist/cli.mjs && cat ${staged}/package.json`,
        'console-stage-failed',
        { timeout: 120_000 },
      );
      let stagedOk = false;
      try {
        stagedOk = JSON.parse(String(stagedPkg)).version === stagedConsoleVersion;
      } catch {
        stagedOk = false;
      }
      const { stdout: stagedId } = await ssh(
        `cat ${staged}/${IDENTITY_FILENAME}`,
        'console-stage-failed',
        { timeout: 30_000 },
      );
      if (!stagedOk || String(stagedId) !== identityContent) throw new ToolError(1, 'console-stage-failed');
      const { stdout: physical } = await ssh(
        `cd ${staged} && /bin/pwd -P`,
        'console-stage-failed',
        { timeout: 30_000 },
      );
      latestReal = String(physical).trim();
      if (!latestReal.startsWith('/')) throw new ToolError(1, 'console-stage-failed');
    }
    checkAborted();

    // ---- launch into the per-run home ----------------------------------------
    {
      const appEnv = [
        `HOME=${remoteDir}/home`,
        `TMPDIR=${remoteDir}/tmp`,
        'LANG=en_US.UTF-8',
        `FLEET_DATA_DIR=${remoteDir}/fleet-data`,
        `FLEET_CONSOLE_DATA_DIR=${remoteDir}/console`,
        `FLEET_DESKTOP_DATA_DIR=${remoteDir}/desktop`,
        'FLEET_CONSOLE_RELEASE_TAG=source',
      ].map(shQuote).join(' ');
      // bundleExecutable is proven to be exactly `Fleet Console` above, so this
      // is the pinned contract path, never another bundle binary.
      const executable = `${appPath}/Contents/MacOS/${bundleExecutable}`;
      launchAttempted = true;
      const { stdout: pidOut } = await ssh(
        `mkdir -p ${shQuote(`${remoteDir}/home`)} ${shQuote(`${remoteDir}/userData`)} ${shQuote(`${remoteDir}/tmp`)} `
        + `&& chmod 700 ${shQuote(`${remoteDir}/home`)} `
        // Only the app itself is backgrounded (braces): $! must be the app
        // PID, not a setup subshell. The ownership proof re-checks this.
        + `&& { env -i ${appEnv} /usr/bin/nohup ${shQuote(executable)} `
        + `--remote-debugging-port=${opts.remotePort} ${shQuote(`--user-data-dir=${remoteDir}/userData`)} `
        + `>${shQuote(`${remoteDir}/app.log`)} 2>&1 & echo $!; }`,
        'launch-failed',
        { timeout: 60_000 },
      );
      const pid = Number(String(pidOut).trim().split('\n').pop());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new ToolError(1, 'launch-failed');
      remotePid = pid;
      startedApp = true;
      stage = 'launched';
      try {
        if (!controlStdinClosed) control?.stdin.write(`pid ${pid}\n`);
      } catch { /* supervisor keeps dir-only duty */ }
    }
    checkAborted();

    // ---- ownership proof before any tunnel ------------------------------------
    // The PID must run the extracted executable itself (not a setup wrapper):
    // its command line contains both the owned directory and the executable.
    {
      const { stdout } = await ssh(`ps -p ${remotePid} -o command= || true`, 'ownership-unproven', { timeout: 30_000 });
      const cmd = String(stdout);
      if (!cmd.includes(remoteDir) || !cmd.includes(bundleExecutable)) {
        throw new ToolError(1, 'ownership-unproven');
      }
    }
    checkAborted();

    // ---- loopback-only tunnel held by this foreground process ------------------
    tunnel = tracked(spawn('ssh', [...SSH_BASE,
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${opts.localPort}:127.0.0.1:${opts.remotePort}`,
      target,
    ], { stdio: 'ignore' }));
    tunnel.on('error', () => {});
    const tunnelDied = new Promise((resolve) => tunnel.on('exit', () => resolve('tunnel-dropped')));
    const tunnelEarly = await Promise.race([
      tunnelDied,
      sleep(3000).then(() => 'held'),
    ]);
    if (tunnelEarly === 'tunnel-dropped') throw new ToolError(1, 'tunnel-failed');
    checkAborted();

    // ---- READY gate: owned loopback listener + live tunnel + console target ----
    // The managed Console child must prove itself too: a descendant of the app
    // running <latest>/dist/cli.mjs serve, with its cwd pinned at the staged
    // latest directory and the staged identity intact.
    const verifyConsoleChild = async () => {
      const { stdout: psOut } = await ssh(
        'ps -ax -o pid= -o ppid= -o command=',
        'child-ps-unreadable',
        { timeout: 30_000 },
      );
      const rows = String(psOut).split('\n').map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]*)$/.exec(line);
        return match ? { pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3] } : null;
      }).filter(Boolean);
      const byParent = new Map();
      for (const row of rows) {
        if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
        byParent.get(row.ppid).push(row.pid);
      }
      const descendant = new Set();
      const queue = [remotePid];
      while (queue.length) {
        for (const child of byParent.get(queue.pop()) ?? []) {
          descendant.add(child);
          queue.push(child);
        }
      }
      // argv may spell the dir unresolved (/var/...) while lsof reports the
      // physical cwd (/private/var/...): accept either spelling for the match,
      // but require the physical spelling for the cwd.
      const wanted = [`${latestReal}/dist/cli.mjs`, `${latestDir}/dist/cli.mjs`];
      for (const row of rows) {
        if (!descendant.has(row.pid)) continue;
        if (!wanted.some((spell) => row.cmd.includes(spell)) || !row.cmd.includes('serve')) continue;
        const { stdout: cwdOut } = await ssh(
          `lsof -p ${row.pid} -a -d cwd -F n 2>/dev/null || true`,
          'child-cwd-unreadable',
          { timeout: 30_000 },
        );
        const cwd = String(cwdOut).split('\n').find((line) => line.startsWith('n'))?.slice(1).trim() ?? null;
        if (cwd !== latestReal) continue;
        const { stdout: liveId } = await ssh(
          `cat ${shQuote(`${latestReal}/${IDENTITY_FILENAME}`)}`,
          'child-identity-unreadable',
          { timeout: 30_000 },
        );
        if (String(liveId) !== identityContent) continue;
        return row.pid;
      }
      return null;
    };
    const fetchJson = async (urlPath) => {
      const response = await fetch(`http://127.0.0.1:${opts.localPort}${urlPath}`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error('bad-status');
      return response.json();
    };
    let version = null;
    let consoleTarget = null;
    let consoleChildPid = null;
    {
      const deadline = Date.now() + opts.cdpTimeoutMs;
      let lastGate = 'listener';
      for (;;) {
        checkAborted();
        if (tunnel.exitCode !== null || tunnel.signalCode !== null) throw new ToolError(1, 'tunnel-dropped');
        // lsof exits non-zero with no output while nothing listens yet: that
        // is "not ready", not a failure. Timeouts and spawn errors still fail.
        let lsofOut = '';
        try {
          ({ stdout: lsofOut } = await execRemote(
            `/usr/sbin/lsof -nP -iTCP:${opts.remotePort} -sTCP:LISTEN -Fcn || lsof -nP -iTCP:${opts.remotePort} -sTCP:LISTEN -Fcn`,
            { timeout: 30_000 },
          ));
        } catch (error) {
          if (error instanceof ToolError && error.stable === 'ssh-command-failed') lsofOut = '';
          else throw new ToolError(error instanceof ToolError ? error.exitCode : 1, 'listener-check-failed');
        }
        const { ownLoopback, foreign } = parseLsofOwnership(String(lsofOut), opts.remotePort, remotePid);
        if (foreign.length > 0) {
          log(`listener-refused ${JSON.stringify({ expectedPid: remotePid, ownLoopback, listeners: foreign.map(({ pid, reason }) => ({ pid, reason })) })}`);
          throw new ToolError(1, foreign[0].reason === 'other-pid' ? 'cdp-listener-owner-mismatch' : 'cdp-listener-not-loopback');
        }
        if (ownLoopback) {
          lastGate = 'child';
          try {
            consoleChildPid = await verifyConsoleChild();
          } catch {
            consoleChildPid = null;
          }
          if (consoleChildPid !== null) {
            lastGate = 'target';
            try {
              version = await fetchJson('/json/version');
              const list = await fetchJson('/json/list');
              consoleTarget = Array.isArray(list) ? list.find((candidate) => {
                try {
                  return new URL(candidate.url).pathname.startsWith('/console/');
                } catch {
                  return false;
                }
              }) ?? null : null;
              if (consoleTarget) break;
            } catch {
              version = null;
              consoleTarget = null;
            }
          }
        }
        if (Date.now() > deadline) throw new ToolError(1, lastGate === 'child' ? 'console-child-timeout' : 'cdp-timeout');
        await sleep(500);
      }
    }

    const urlPathOnly = (raw) => {
      try {
        return new URL(raw).pathname || '/';
      } catch {
        return '(unparseable)';
      }
    };
    process.stdout.write(`${JSON.stringify({
      status: 'ready',
      runId,
      localPort: opts.localPort,
      remotePort: opts.remotePort,
      remoteDirName: REMOTE_BASENAME(runId),
      packageSha256: opts['--package-sha256'],
      packageRevision: opts['--package-revision'],
      appBundleVersion: bundleVersion,
      stagedConsoleVersion,
      consoleChildPid,
      browser: version?.Browser ?? null,
      protocolVersion: version?.['Protocol-Version'] ?? null,
      consoleTarget: consoleTarget
        ? { id: consoleTarget.id ?? null, type: consoleTarget.type ?? null, urlPath: urlPathOnly(consoleTarget.url) }
        : null,
    })}\n`);

    // ---- foreground hold ------------------------------------------------------
    holding = true;
    stage = 'ready';
    const remoteGone = (async () => {
      for (;;) {
        if (aborted) return 'aborted';
        let out = null;
        try {
          out = (await execRemote(`ps -p ${remotePid} -o command= || true`, { timeout: 15_000 })).stdout;
        } catch {
          await sleep(2000);
          continue;
        }
        if (!String(out).trim()) return 'remote-exited';
        // A live PID whose command no longer matches is PID reuse: our app is gone.
        if (!String(out).includes(remoteDir)) return 'remote-exited-reused';
        await sleep(2000);
      }
    })();
    const outcome = await Promise.race([remoteGone, tunnelDied]);
    // An abort (signal, or the supervisor connection dying first) wins over
    // whatever the race observed: our own reclaim kills the tunnel, which
    // must not be mistaken for a drop.
    if (aborted || outcome === 'aborted') {
      const reason = exitSignal === 'SIGINT' ? 'sigint' : exitSignal === 'SIGTERM' ? 'sigterm' : 'watchdog-dropped';
      const summary = await shutdown(reason);
      const code = exitCodeFor(summary, reason === 'sigint' ? 130 : reason === 'sigterm' ? 0 : 1);
      log(`run stopped (${reason}); exiting ${code}`);
      return code;
    }
    if (outcome === 'tunnel-dropped') {
      const summary = await shutdown('tunnel-dropped');
      log(`tunnel dropped; reclaimed; exiting ${exitCodeFor(summary, 1)}`);
      return exitCodeFor(summary, 1);
    }
    const summary = await shutdown('remote-exited');
    log(`remote app exited; reclaimed; exiting ${exitCodeFor(summary, 0)}`);
    return exitCodeFor(summary, 0);
  } catch (error) {
    const stable = error instanceof ToolError ? error.stable : 'unexpected';
    const signalled = exitSignal === 'SIGTERM' || exitSignal === 'SIGINT';
    const preLaunch = error instanceof ToolError && error.exitCode === 20 && !startedApp && !launchAttempted;
    const summary = await shutdown(
      signalled ? (exitSignal === 'SIGINT' ? 'sigint' : 'sigterm') : preLaunch ? `refused-${stable}` : `failure-${stable}`,
    ).catch(() => null);
    if (signalled) {
      const base = exitSignal === 'SIGINT' ? 130 : 0;
      process.stderr.write(`launch-remote-desktop: aborted (${stable}); exiting ${exitCodeFor(summary, base)}\n`);
      return exitCodeFor(summary, base);
    }
    const code = preLaunch ? exitCodeFor(summary, 20) : 1;
    // The "not started" record is printed only when no app was started.
    process.stderr.write(preLaunch
      ? `launch-remote-desktop: refused (${stable}); the remote app was not started\n`
      : `launch-remote-desktop: failed (${stable})\n`);
    return code;
  }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invoked) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const stable = error instanceof ToolError ? error.stable : 'unexpected';
      process.stderr.write(`launch-remote-desktop: failed (${stable})\n`);
      process.exit(error instanceof ToolError && error.exitCode === 20 ? 20 : 1);
    },
  );
}
