import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createConsoleHealthClient, observeConsoleLockFile, requestConsoleStop, type ConsoleLockFilePayload } from "@fleet-console/lifecycle";
import { DESKTOP_DEVELOPMENT_ENV, DESKTOP_OWNER_ID_ENV, DESKTOP_OWNER_KIND_ENV, DESKTOP_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION_ENV, DESKTOP_RESOURCE_ROOT_ENV, resolveCanonicalStableConsolePaths } from "@fleet-console/protocol/desktop";
import { classifyConsoleManagement, type ConsoleManagedLifecycle, type ConsoleManagementRelation } from "@fleet-console/protocol/lifecycle/management";

import { downloadVerifiedNodeArchive, type NodeRuntimeManifest } from "./runtime/node-bootstrap.js";
import type { WslHost } from "./wsl-host.js";

/**
 * The WSL Consoles this Desktop manages (docs/console-lifecycle-contract.md, "WSL Consoles").
 *
 * One registered distribution holds one Console, run as that distribution's default Linux user from a runtime this
 * Desktop installed under the user's Fleet directory. Management is proved exactly as for the native Console: the
 * lock's owner record names this Desktop and a token-authenticated health answer comes from the lock's pid. The
 * Console is started detached inside the distribution, so it outlives this process and is found again by that proof;
 * it is stopped only through the stop request. Nothing here signals a Linux process or ends a distribution.
 */
export interface WslConsoleRecord {
  readonly id: string;
  readonly distro: string;
  readonly user: string;
  readonly uid: number;
  readonly home: string;
  readonly arch: "x64" | "arm64";
}

export type WslConsoleFailure = "build-tools" | "download" | "install" | "start" | "other-owner" | "stop";

export interface WslConsoleView {
  readonly key: string;
  readonly distro: string;
  /** Where the Console answers; null while it is not running. */
  readonly origin: string | null;
  readonly version: string | null;
  readonly management: ConsoleManagementRelation;
  readonly lifecycle: ConsoleManagedLifecycle | null;
  readonly identityProven: boolean;
  /** The runtime is being installed before the first start. */
  readonly installing: boolean;
  readonly failure: WslConsoleFailure | null;
  /** A Console started from a terminal holds the slot: the person may hand it to this Desktop. */
  readonly takeover: boolean;
}

/** What one look inside a distribution found, before the person adds it. */
export interface WslInspection {
  readonly distro: string;
  readonly user: string;
  readonly version: 1 | 2 | null;
  readonly runtime: "ready" | "missing";
  /** Build tools the Console's native module needs and the distribution lacks. Desktop never installs them. */
  readonly missingTools: readonly string[];
  /** A Console already in this user's standard slot, by who manages it. `stale` is a lock an ended Console left. */
  readonly existing: "none" | "stale" | ConsoleManagementRelation;
  /** The user installed `fleet` themselves. It is left alone and never run. */
  readonly ownFleet: boolean;
}

export interface WslConsoleManagerOptions {
  readonly host: WslHost;
  readonly ownerId: string;
  readonly registryFile: string;
  /** Windows-side directory for downloaded, verified archives. */
  readonly cacheDirectory: string;
  /** The user's Fleet directory inside the distribution, relative to their home: `.fleet`, or an isolated one in development. */
  readonly fleetDirectory: string;
  /** Development runs keep their data beside their runtime instead of in the user's standard slot. */
  readonly isolatedData: boolean;
  readonly desktopVersion: string;
  readonly development: boolean;
  readonly packageName: string;
  readonly nodeManifest: () => NodeRuntimeManifest;
  /** A verified Console package tarball on the Windows side. */
  readonly consoleTarball: () => Promise<string>;
  /** Extra variables for the Console's environment (development isolation only). */
  readonly extraEnvironment?: Readonly<Record<string, string>>;
  readonly log: { info(message: string): void; error(message: string): void };
  readonly onChange?: () => void;
  readonly probeTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

interface Layout { readonly runtime: string; readonly node: string; readonly pkg: string; readonly cli: string; readonly lock: string; readonly data: string | null; readonly fleet: string; }
interface Observed {
  readonly management: ConsoleManagementRelation;
  readonly lifecycle: ConsoleManagedLifecycle | null;
  readonly identityProven: boolean;
  readonly origin: string | null;
  readonly version: string | null;
  readonly lock: ConsoleLockFilePayload | null;
}

const STOPPED: Observed = { management: "this-desktop", lifecycle: "stopped", identityProven: false, origin: null, version: null, lock: null };
const LINUX_PATH = /^\/[A-Za-z0-9._/-]+$/u;
const BUILD_TOOLS = ["python3", "make", "g++"] as const;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const fields = (output: string): Map<string, string> => new Map(output.split(/\r?\n/u).map((line) => /^([a-z0-9_]+)=(.*)$/u.exec(line)).filter((row): row is RegExpExecArray => row !== null).map((row) => [row[1]!, row[2]!.trim()]));

export class WslConsoleManager {
  private records: WslConsoleRecord[] = [];
  private readonly busy = new Map<string, "installing" | "starting" | "stopping">();
  private readonly failures = new Map<string, WslConsoleFailure>();
  private readonly inspections = new Map<string, WslConsoleRecord>();
  private readonly health = createConsoleHealthClient();
  private watching: ReturnType<typeof setInterval> | null = null;
  private lastSeen = "";

  constructor(private readonly options: WslConsoleManagerOptions) {
    try {
      const stored = JSON.parse(fs.readFileSync(options.registryFile, "utf8")) as { readonly consoles?: unknown };
      if (Array.isArray(stored.consoles)) this.records = stored.consoles.filter(isRecord);
    } catch { /* No registry yet, or one that cannot be read: nothing is managed until the person adds it again. */ }
  }

  /** Distributions as `wsl.exe` lists them, with which ones are already managed. Starts none. */
  async distros(): Promise<readonly { readonly name: string; readonly running: boolean; readonly version: 1 | 2 | null; readonly managed: boolean }[]> {
    const managed = new Set(this.records.map((record) => record.distro));
    return (await this.options.host.distros()).map((distro) => ({ ...distro, managed: managed.has(distro.name) }));
  }

  /** The origins of managed Consoles that proved themselves just now; the window may be sent to these. */
  async origins(): Promise<readonly string[]> {
    return (await this.list()).filter((view) => view.origin !== null && view.identityProven).map((view) => view.origin!);
  }

  async list(): Promise<readonly WslConsoleView[]> {
    if (this.records.length === 0) return [];
    const running = new Set((await this.options.host.distros()).filter((distro) => distro.running).map((distro) => distro.name));
    return Promise.all(this.records.map(async (record) => {
      // A stopped distribution runs nothing, and reading its files would start it.
      const seen = running.has(record.distro) ? await this.observe(record).catch(() => unknown()) : STOPPED;
      const phase = this.busy.get(record.id);
      if (seen.lifecycle === "running") this.failures.delete(record.id);
      const failure = this.failures.get(record.id) ?? null;
      const lifecycle = phase === "stopping" ? "stopping" : phase ? "starting" : failure && seen.lifecycle === "stopped" ? "failed" : seen.lifecycle;
      return {
        key: record.id, distro: record.distro, origin: seen.identityProven ? seen.origin : null, version: seen.version, management: seen.management, lifecycle,
        identityProven: seen.identityProven, installing: phase === "installing", failure: phase ? null : failure,
        takeover: !phase && seen.management === "cli" && seen.identityProven,
      };
    }));
  }

  /** Looks inside one distribution. This is the person's explicit step, so a stopped distribution starts. */
  async inspect(distro: string): Promise<WslInspection> {
    const listed = (await this.options.host.distros()).find((entry) => entry.name === distro);
    if (!listed) throw new Error("wsl_distro_unknown");
    const result = await this.options.host.sh(distro, null, `
echo user=$(id -un); echo uid=$(id -u); echo home=$HOME; echo machine=$(uname -m)
for tool in ${BUILD_TOOLS.join(" ")}; do command -v "$tool" >/dev/null 2>&1 || echo "missing_$(echo "$tool" | tr -c 'a-z0-9\\n' '_')=1"; done
shell=$(getent passwd "$(id -un)" | cut -d: -f7); [ -x "$shell" ] || shell=/bin/sh
own=$(timeout 20 setsid -w "$shell" -lic 'command -v fleet' 2>/dev/null </dev/null | grep '^/' | grep -v '^/mnt/' | tail -1)
[ -n "$own" ] && echo own_fleet=1
echo slots=$(ls -d /tmp/fleet-console-*-stable 2>/dev/null | tr '\\n' ' ')
`, 45_000);
    const read = fields(result.stdout);
    const user = read.get("user") ?? "";
    const uid = Number(read.get("uid"));
    const home = read.get("home") ?? "";
    const arch = read.get("machine") === "x86_64" ? "x64" : read.get("machine") === "aarch64" ? "arm64" : null;
    if (result.code !== 0 || !user || !Number.isSafeInteger(uid) || uid < 0 || !LINUX_PATH.test(home) || arch === null) {
      this.options.log.error(`wsl inspect ${distro} unusable: code=${result.code} user=${user} uid=${read.get("uid")} home=${home} machine=${read.get("machine")} ${result.stderr.slice(-300)}`);
      throw new Error("wsl_distro_unusable");
    }
    const record: WslConsoleRecord = { id: randomUUID(), distro, user, uid, home, arch };
    this.inspections.set(distro, record);
    const runtime = await this.runtime(record);
    // Consoles already in the standard slots of this distribution, by who manages them.
    const ranked: WslInspection["existing"][] = [];
    for (const slot of (read.get("slots") ?? "").split(" ").filter((entry) => /^\/tmp\/fleet-console-\d+-stable$/u.test(entry))) {
      const seen = await this.observeLock(record, `${slot}/console.lock`).catch(() => unknown());
      ranked.push(seen.management === "unknown" ? "unknown" : seen.lock === null ? "none" : seen.identityProven || seen.lifecycle !== "stopped" ? seen.management : "stale");
    }
    const order: readonly WslInspection["existing"][] = ["other-desktop", "this-desktop", "cli", "unknown", "stale", "none"];
    const existing = order.find((kind) => ranked.includes(kind)) ?? "none";
    return {
      distro, user, version: listed.version, runtime: runtime.node && runtime.console ? "ready" : "missing",
      missingTools: BUILD_TOOLS.filter((tool) => read.has(`missing_${tool.replace(/[^a-z0-9]/gu, "_")}`)), existing, ownFleet: read.has("own_fleet"),
    };
  }

  /** Registers a distribution the person just inspected. Registering starts and installs nothing. */
  add(distro: string): WslConsoleRecord {
    const existing = this.records.find((record) => record.distro === distro);
    if (existing) return existing;
    const record = this.inspections.get(distro);
    if (!record) throw new Error("wsl_distro_not_inspected");
    this.records = [...this.records, record];
    this.save();
    return record;
  }

  /** Forgets the registration only. The Console's data, the installed runtime, and the distribution stay. */
  async remove(key: string): Promise<boolean> {
    const view = (await this.list()).find((entry) => entry.key === key);
    // A Console this Desktop still runs would be left without a manager.
    if (!view || this.busy.has(key) || (view.management === "this-desktop" && view.lifecycle !== "stopped" && view.lifecycle !== "failed")) return false;
    this.records = this.records.filter((record) => record.id !== key);
    this.failures.delete(key);
    this.save();
    return true;
  }

  async start(key: string): Promise<string> {
    const record = this.record(key);
    return this.exclusive(record, "starting", async () => {
      const before = await this.observe(record);
      if (before.management === "this-desktop" && before.lifecycle === "running" && before.origin) return before.origin;
      // Another owner's Console holds the slot. It is neither stopped nor started beside.
      if (before.lifecycle !== "stopped") throw this.fail(record, "other-owner");
      await this.ensureRuntime(record);
      this.busy.set(record.id, "starting");
      this.options.onChange?.();
      const launched = await this.options.host.sh(record.distro, record.user, this.launchScript(record), 60_000);
      if (launched.code !== 0 || !launched.stdout.includes("launched")) { this.options.log.error(`wsl start ${record.distro}: ${launched.stderr.slice(-400)}`); throw this.fail(record, "start"); }
      const deadline = Date.now() + (this.options.startTimeoutMs ?? 60_000);
      while (Date.now() < deadline) {
        const seen = await this.observe(record).catch(() => unknown());
        if (seen.management === "this-desktop" && seen.lifecycle === "running" && seen.origin) return seen.origin;
        if (seen.lock !== null && seen.management !== "this-desktop") throw this.fail(record, "other-owner");
        await sleep(300);
      }
      throw this.fail(record, "start");
    });
  }

  async stop(key: string): Promise<void> {
    const record = this.record(key);
    await this.exclusive(record, "stopping", async () => {
      const seen = await this.observe(record);
      if (seen.lifecycle === "stopped") return;
      // Only a Console this Desktop manages and has just proved is asked to stop.
      if (seen.management !== "this-desktop" || !seen.identityProven || !seen.lock) throw this.fail(record, "other-owner");
      await this.requestStop(record, seen.lock);
    });
  }

  async restart(key: string): Promise<string> {
    await this.stop(key);
    return this.start(key);
  }

  /**
   * The person hands a Console they started from a terminal to this Desktop: it is asked to stop through its own stop
   * request, and this Desktop starts it again as its manager. Never done unasked, and never to another Desktop's Console.
   */
  async takeOver(key: string): Promise<string> {
    const record = this.record(key);
    await this.exclusive(record, "stopping", async () => {
      const seen = await this.observe(record);
      if (seen.management !== "cli" || !seen.identityProven || !seen.lock) throw this.fail(record, "other-owner");
      await this.requestStop(record, seen.lock);
    });
    return this.start(key);
  }

  /** Quit: the Consoles this Desktop manages and that answer as its own are asked to stop. A stopped distribution is not woken. */
  async stopAll(): Promise<void> {
    if (this.records.length === 0) return;
    const running = new Set((await this.options.host.distros().catch(() => [])).filter((distro) => distro.running).map((distro) => distro.name));
    await Promise.all(this.records.filter((record) => running.has(record.distro)).map((record) => this.stop(record.id).catch((error) => this.options.log.error(`wsl stop on quit ${record.distro}: ${String(error)}`))));
  }

  /**
   * A managed WSL Console has no child handle to tell this Desktop it ended, so its state is read again on an interval
   * and `onChange` fires when it differs. Nothing is read while nothing is registered.
   */
  watch(intervalMs: number): void {
    if (this.watching) return;
    this.watching = setInterval(() => {
      if (this.records.length === 0 || this.busy.size > 0) return;
      void this.list().then((views) => {
        const seen = JSON.stringify(views.map((view) => [view.key, view.lifecycle, view.management, view.origin]));
        if (seen !== this.lastSeen) { this.lastSeen = seen; this.options.onChange?.(); }
      }).catch(() => undefined);
    }, intervalMs);
    this.watching.unref?.();
  }

  unwatch(): void {
    if (this.watching) clearInterval(this.watching);
    this.watching = null;
  }

  private record(key: string): WslConsoleRecord {
    const record = this.records.find((entry) => entry.id === key);
    if (!record) throw new Error("wsl_console_unknown");
    return record;
  }

  private async exclusive<T>(record: WslConsoleRecord, phase: "starting" | "stopping", run: () => Promise<T>): Promise<T> {
    if (this.busy.has(record.id)) throw new Error("wsl_console_busy");
    this.busy.set(record.id, phase);
    this.failures.delete(record.id);
    this.options.onChange?.();
    try { return await run(); } finally { this.busy.delete(record.id); this.options.onChange?.(); }
  }

  private fail(record: WslConsoleRecord, failure: WslConsoleFailure): Error {
    this.failures.set(record.id, failure);
    return new Error(`wsl_console_${failure.replace("-", "_")}`);
  }

  private layout(record: WslConsoleRecord): Layout {
    const fleet = `${record.home}/${this.options.fleetDirectory}`;
    const runtime = `${fleet}/desktop/runtime`;
    const pkg = `${runtime}/console/latest/node_modules/${this.options.packageName}`;
    const data = this.options.isolatedData ? `${fleet}/console` : null;
    // The standard slot is the one a terminal `fleet` uses too, so one lock guards the user's data whoever starts it.
    const lock = data ? `${data}/console.lock` : resolveCanonicalStableConsolePaths({ tmpDir: "/tmp", uid: record.uid, fleetDataDir: fleet }).lockFile.replace(/\\/gu, "/");
    return { fleet, runtime, node: `${runtime}/node/bin/node`, pkg, cli: `${pkg}/dist/cli.mjs`, lock, data };
  }

  private observe(record: WslConsoleRecord): Promise<Observed> {
    return this.observeLock(record, this.layout(record).lock);
  }

  /** Reads one lock in a running distribution and proves, or fails to prove, the instance behind it. */
  private async observeLock(record: WslConsoleRecord, lockFile: string): Promise<Observed> {
    const seen = observeConsoleLockFile(this.options.host.windowsPath(record.distro, lockFile));
    if (seen.kind === "absent") return STOPPED;
    if (seen.kind !== "owner" || seen.untrusted !== null) return unknown();
    const lock = seen.instance.payload;
    const management = classifyConsoleManagement(lock.owner, this.options.ownerId);
    const mine = management === "this-desktop";
    let origin: string;
    try { origin = new URL(lock.endpoint).origin; } catch { return unknown(); }
    const version = typeof lock.version === "string" && lock.version ? lock.version : null;
    const probe = await this.health.probe({ pid: lock.pid, endpoint: lock.endpoint, token: lock.token }, { timeoutMs: this.options.probeTimeoutMs ?? 2_500 });
    if (probe.healthy && probe.health?.pid === lock.pid) return { management, lifecycle: mine ? "running" : null, identityProven: true, origin, version, lock };
    if (probe.starting) return { management, lifecycle: mine ? "starting" : null, identityProven: false, origin: null, version, lock };
    // The lock's pid is a Linux pid: only the distribution can say whether its writer still lives.
    const alive = (await this.options.host.sh(record.distro, record.user, `[ -d /proc/${lock.pid} ] && echo alive || echo gone`, 10_000)).stdout.includes("alive");
    // An ended Console's lock is left for the Console that starts next to reclaim; nobody else removes it.
    if (!alive) return { ...STOPPED, lock };
    return { management, lifecycle: mine ? "stopping" : null, identityProven: false, origin: null, version, lock };
  }

  private async requestStop(record: WslConsoleRecord, lock: ConsoleLockFilePayload): Promise<void> {
    const asked = await requestConsoleStop({ pid: lock.pid, endpoint: lock.endpoint, token: lock.token }, { timeoutMs: 5_000 });
    if (asked.kind === "rejected") throw this.fail(record, "stop");
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const seen = await this.observe(record).catch(() => unknown());
      if (seen.lifecycle === "stopped" || (seen.lock !== null && seen.lock.pid !== lock.pid)) return;
      await sleep(250);
    }
    // It did not end in time. It is left running and reported; no signal follows.
    throw this.fail(record, "stop");
  }

  private async runtime(record: WslConsoleRecord): Promise<{ readonly node: boolean; readonly console: boolean; readonly missingTools: readonly string[] }> {
    const { node, cli } = this.layout(record);
    const result = await this.options.host.sh(record.distro, record.user, `
echo node=$("${node}" -v 2>/dev/null)
[ -f "${cli}" ] && echo console=1
for tool in ${BUILD_TOOLS.join(" ")}; do command -v "$tool" >/dev/null 2>&1 || echo "tool=$tool"; done
`, 20_000);
    const read = fields(result.stdout);
    return { node: read.get("node") === `v${this.options.nodeManifest().version}`, console: read.has("console"), missingTools: result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("tool=")).map((line) => line.slice(5).trim()) };
  }

  /** Installs what is missing of the managed runtime. Files are downloaded and verified on Windows, then handed in. */
  private async ensureRuntime(record: WslConsoleRecord): Promise<void> {
    const present = await this.runtime(record);
    if (present.node && present.console) return;
    // Desktop does not run sudo: the person installs the build tools, then starts again.
    if (!present.console && present.missingTools.length > 0) throw this.fail(record, "build-tools");
    this.busy.set(record.id, "installing");
    this.options.onChange?.();
    const { runtime } = this.layout(record);
    if (!present.node) {
      const manifest = this.options.nodeManifest();
      const target = manifest.targets[`linux-${record.arch}`];
      if (!target) throw this.fail(record, "download");
      let archive: string;
      try { archive = (await downloadVerifiedNodeArchive({ directory: this.options.cacheDirectory, manifest, target })).path; } catch (error) { this.options.log.error(`wsl node download: ${String(error)}`); throw this.fail(record, "download"); }
      const staged = `${runtime}/node.staging`;
      const placed = await this.options.host.pipe(record.distro, record.user, { archive }, `rm -rf ${staged} && mkdir -p ${staged} && tar -xf - -C ${staged} --strip-components=1 && rm -rf ${runtime}/node && mv ${staged} ${runtime}/node`, TRANSFER_TIMEOUT_MS);
      if (placed.code !== 0) { this.options.log.error(`wsl node install ${record.distro}: ${placed.stderr.slice(-400)}`); throw this.fail(record, "install"); }
    }
    if (!present.console) {
      let tarball: string;
      try { tarball = await this.options.consoleTarball(); } catch (error) { this.options.log.error(`wsl console download: ${String(error)}`); throw this.fail(record, "download"); }
      const home = `${runtime}/console`;
      const handed = await this.options.host.pipe(record.distro, record.user, { file: tarball }, `mkdir -p ${home} && cat > ${home}/.incoming.tgz`, TRANSFER_TIMEOUT_MS);
      const installed = handed.code !== 0 ? handed : await this.options.host.sh(record.distro, record.user, `
cd "${home}" && rm -rf .staging && env -i HOME="$HOME" PATH="${runtime}/node/bin:/usr/local/bin:/usr/bin:/bin" npm_config_userconfig="${home}/.no-user-npmrc" npm_config_globalconfig="${home}/.no-global-npmrc" npm_config_update_notifier=false \\
  npm install --prefix .staging --no-audit --no-fund --loglevel=error ./.incoming.tgz </dev/null \\
  && rm -rf latest.old && { [ ! -d latest ] || mv latest latest.old; } && mv .staging latest && rm -rf latest.old .incoming.tgz && echo installed
`, INSTALL_TIMEOUT_MS);
      if (installed.code !== 0 || !installed.stdout.includes("installed")) { this.options.log.error(`wsl console install ${record.distro}: ${installed.stderr.slice(-600)}`); throw this.fail(record, "install"); }
    }
  }

  /**
   * Starts the Console in a session of its own, so it does not end with the `wsl.exe` that carried the command. Its PATH
   * is the user's login-shell PATH without the Windows entries WSL appends, so agent CLIs resolve as in their terminal.
   * The login shell is asked in a session of its own too: an interactive shell that shares the command's terminal is
   * stopped by job control and never answers. The command returns only once the Console leads its own session: the
   * session that carried the command is torn down the moment it returns, and a Console still in it dies with it.
   */
  private launchScript(record: WslConsoleRecord): string {
    const { node, cli, pkg, runtime, data, fleet } = this.layout(record);
    const environment: Record<string, string> = {
      [DESKTOP_OWNER_KIND_ENV]: "desktop", [DESKTOP_OWNER_ID_ENV]: this.options.ownerId, [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION), [DESKTOP_RESOURCE_ROOT_ENV]: pkg,
      FLEET_CONSOLE_DESKTOP_VERSION: this.options.desktopVersion,
      ...(this.options.development ? { [DESKTOP_DEVELOPMENT_ENV]: "1" } : {}),
      ...(data ? { FLEET_DATA_DIR: fleet, FLEET_CONSOLE_DATA_DIR: data, FLEET_CONSOLE_DIR: data } : {}),
      ...this.options.extraEnvironment,
    };
    const assignments = Object.entries(environment).filter(([name, value]) => /^[A-Z][A-Z0-9_]*$/u.test(name) && /^[A-Za-z0-9 _./:@=+-]*$/u.test(value)).map(([name, value]) => `${name}="${value}"`).join(" ");
    return `
cd "$HOME" || exit 1
name=$(id -un)
shell=$(getent passwd "$name" | cut -d: -f7); [ -x "$shell" ] || shell=/bin/sh
found=$(timeout 20 setsid -w "$shell" -lic 'printf "\\n__FLEET_PATH__%s\\n" "$PATH"' 2>/dev/null </dev/null | sed -n 's/^__FLEET_PATH__//p' | tail -1)
[ -n "$found" ] || found=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
found=$(printf %s "$found" | tr ':' '\\n' | grep -v '^/mnt/' | paste -sd: -)
nohup setsid env -i HOME="$HOME" USER="$name" LOGNAME="$name" SHELL="$shell" LANG="\${LANG:-C.UTF-8}" TERM=xterm-256color PATH="${runtime}/node/bin:$found" ${assignments} "${node}" "${cli}" serve >/dev/null 2>&1 </dev/null &
child=$!
tries=0
while [ $tries -lt 50 ]; do
  [ "$(cut -d' ' -f6 "/proc/$child/stat" 2>/dev/null)" = "$child" ] && break
  tries=$((tries + 1)); sleep 0.1
done
echo launched
`;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.options.registryFile), { recursive: true });
    const staging = `${this.options.registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(staging, `${JSON.stringify({ v: 1, consoles: this.records }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(staging, this.options.registryFile);
    this.options.onChange?.();
  }
}

function unknown(): Observed {
  return { management: "unknown", lifecycle: null, identityProven: false, origin: null, version: null, lock: null };
}

function isRecord(value: unknown): value is WslConsoleRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.distro === "string" && typeof record.user === "string" && Number.isSafeInteger(record.uid)
    && typeof record.home === "string" && LINUX_PATH.test(record.home) && (record.arch === "x64" || record.arch === "arm64");
}
