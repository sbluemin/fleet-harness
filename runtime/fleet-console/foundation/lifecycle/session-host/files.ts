import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { SESSION_HOST_WIRE, type SessionGeneration, type SessionHostManifest } from "@fleet-console/protocol/session-host";
import { isPidAlive } from "../process.js";
import { resolveRealPath } from "../temp-namespace.js";
import { withSessionGenerationLock, pinSessionGeneration } from "./generations.js";

export function privateSessionDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("untrusted_session_directory");
}
export function sessionHostPaths(dataDir: string) {
  const real = resolveRealPath(dataDir);
  const slotKey = createHash("sha256").update(real).digest("hex").slice(0, 24);
  const dir = path.join(real, "session-host");
  const namespace = `fs${process.getuid?.() ?? os.userInfo().username}`;
  const preferredSockets = path.join(os.tmpdir(), namespace);
  const relocatedSocketNamespace = Buffer.byteLength(path.join(preferredSockets, `${slotKey}.sock`)) > 100;
  // A long owned TMPDIR must not widen the control surface to a TCP listener.
  const sockets = relocatedSocketNamespace ? path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", namespace) : preferredSockets;
  const unixSocket = path.join(sockets, `${slotKey}.sock`);
  return { dir, slotKey, lockFile: path.join(real, "console.lock"), manifest: path.join(dir, "host.json"), socket: process.platform === "win32" ? `\\\\.\\pipe\\fleet-sessions-${slotKey}` : unixSocket, sockets, relocatedSocketNamespace };
}
export function readSessionHostManifest(dataDir: string): SessionHostManifest | null {
  const paths = sessionHostPaths(dataDir);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(paths.manifest); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  privateSessionDirectory(paths.dir);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("untrusted_session_manifest");
  let value: SessionHostManifest;
  try { value = JSON.parse(fs.readFileSync(paths.manifest, "utf8")) as SessionHostManifest; }
  catch { throw new Error("invalid_session_manifest"); }
  if (!value || typeof value !== "object" || value.v !== SESSION_HOST_WIRE || value.slotKey !== paths.slotKey || typeof value.socket !== "string" || (process.platform === "win32" ? !value.socket.startsWith(paths.socket + "-") || !/^[a-f0-9-]{36}$/.test(value.socket.slice(paths.socket.length + 1)) : (path.basename(value.socket) !== `${paths.slotKey}.sock` || path.basename(path.dirname(value.socket)) !== `fs${process.getuid?.() ?? os.userInfo().username}` || !path.isAbsolute(value.socket))) || !Number.isSafeInteger(value.pid) || value.pid <= 1 || typeof value.capability !== "string" || value.capability.length < 32 || typeof value.hostId !== "string") throw new Error("invalid_session_manifest");
  if (process.platform !== "win32") privateSessionDirectory(path.dirname(value.socket));
  return value;
}
export function reclaimDeadSessionHost(dataDir: string): void {
  const current = readSessionHostManifest(dataDir);
  if (!current) return;
  if (isPidAlive(current.pid)) throw new Error("session_host_still_alive");
  const paths = sessionHostPaths(dataDir);
  const again = readSessionHostManifest(dataDir);
  if (!again || again.hostId !== current.hostId || isPidAlive(current.pid)) throw new Error("session_host_changed");
  fs.unlinkSync(paths.manifest);
  if (process.platform !== "win32") { try { fs.unlinkSync(current.socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
export function publishSessionHost(dataDir: string, socket?: string): SessionHostManifest {
  const p = sessionHostPaths(dataDir);
  privateSessionDirectory(p.dir);
  const manifest: SessionHostManifest = { v: SESSION_HOST_WIRE, hostId: randomUUID(), pid: process.pid, startedAt: Date.now(), slotKey: p.slotKey, socket: socket ?? p.socket, capability: randomUUID() + randomUUID() };
  const staging = `${p.manifest}.${process.pid}.${randomUUID()}`;
  try { fs.writeFileSync(staging, JSON.stringify(manifest), { flag: "wx", mode: 0o600 }); fs.linkSync(staging, p.manifest); }
  finally { fs.rmSync(staging, { force: true }); }
  return manifest;
}
export function removeOwnSessionManifest(dataDir: string, hostId: string): void {
  const p = sessionHostPaths(dataDir);
  const current = readSessionHostManifest(dataDir);
  if (current?.hostId !== hostId || current.pid !== process.pid) return;
  fs.unlinkSync(p.manifest);
  // net.Server owns unlinking its socket on close; do not unlink a successor's socket here.
}

/** Copy the actual external package closure, not links into an installation an updater will replace. */
export function prepareSessionGeneration(dataDir: string, packageRoot: string, options: { readonly packages: readonly string[]; readonly execPath?: string }): SessionGeneration {
  return withSessionGenerationLock(dataDir, () => {
    const generation = prepareGeneration(dataDir, packageRoot, options);
    pinSessionGeneration(dataDir, generation.id);
    return generation;
  }, true);
}
function prepareGeneration(dataDir: string, packageRoot: string, options: { readonly packages: readonly string[]; readonly execPath?: string }): SessionGeneration {
  const execPath = options.execPath ?? process.execPath;
  const names = ["session-host.mjs", "session-runner.mjs", "session-hook.mjs", "console-reaper.mjs"];
  const hash = createHash("sha256");
  for (const name of names) hash.update(fs.readFileSync(path.join(packageRoot, "dist", name)));
  hash.update(fs.readFileSync(execPath));
  const sourceRequire = createRequire(path.join(packageRoot, "package.json"));
  const external = options.packages;
  const packages = new Map<string, string>();
  function locate(req: NodeRequire, name: string): string {
    let entry: string;
    try { entry = req.resolve(`${name}/package.json`); }
    catch {
      entry = req.resolve(name);
      let dir = path.dirname(entry);
      for (;;) { const file = path.join(dir, "package.json"); if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).name === name) return dir; const parent = path.dirname(dir); if (parent === dir) throw new Error(`session_dependency_missing:${name}`); dir = parent; }
    }
    return path.dirname(entry);
  }
  function discover(name: string, from: NodeRequire): string {
    const root = fs.realpathSync(locate(from, name));
    if (packages.has(root)) return root;
    const body = fs.readFileSync(path.join(root, "package.json"), "utf8");
    packages.set(root, body); hash.update(root).update(body);
    const hashFiles = (dir: string): void => {
      for (const entry of fs.readdirSync(dir).sort()) {
        if (entry === "node_modules") continue;
        const file = path.join(dir, entry); const stat = fs.statSync(file);
        hash.update(path.relative(root, file)).update(String(stat.mode));
        if (stat.isDirectory()) hashFiles(file); else if (stat.isFile()) hash.update(fs.readFileSync(file));
      }
    };
    hashFiles(root);
    const meta = JSON.parse(body) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const req = createRequire(path.join(root, "package.json"));
    for (const dep of Object.keys(meta.dependencies ?? {})) discover(dep, req);
    for (const dep of Object.keys(meta.optionalDependencies ?? {})) { try { discover(dep, req); } catch { /* Optional target-platform packages may be absent. */ } }
    return root;
  }
  for (const name of external) discover(name, sourceRequire);
  const id = hash.digest("hex");
  const base = path.join(sessionHostPaths(dataDir).dir, "generations");
  privateSessionDirectory(base);
  const root = path.join(base, id);
  const node = path.join(root, process.platform === "win32" ? "node.exe" : "node");
  const result: SessionGeneration = { id, root, node, broker: path.join(root, "dist/session-host.mjs"), runner: path.join(root, "dist/session-runner.mjs"), reaper: path.join(root, "dist/console-reaper.mjs"), hook: path.join(root, "dist/session-hook.mjs") };
  if (fs.existsSync(path.join(root, ".complete"))) return result;
  const staging = path.join(base, `.staging-${process.pid}-${randomUUID()}`);
  privateSessionDirectory(staging);
  try {
    fs.mkdirSync(path.join(staging, "dist"));
    fs.copyFileSync(execPath, path.join(staging, path.basename(node))); fs.chmodSync(path.join(staging, path.basename(node)), 0o700);
    for (const name of names) fs.copyFileSync(path.join(packageRoot, "dist", name), path.join(staging, "dist", name));
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name: string; version?: string };
    fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({ name: packageMetadata.name, version: packageMetadata.version, type: "module" }), { mode: 0o600 });
    function copyPackage(name: string, from: NodeRequire, parent: string, ancestors: ReadonlySet<string>): void {
      const source = fs.realpathSync(locate(from, name));
      if (ancestors.has(source)) return;
      const dest = path.join(parent, "node_modules", name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(source, dest, { recursive: true, dereference: true, filter: (src) => path.basename(src) !== "node_modules" });
      const meta = JSON.parse(packages.get(source)!) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
      const next = new Set([...ancestors, source]);
      const req = createRequire(path.join(source, "package.json"));
      for (const dep of Object.keys(meta.dependencies ?? {})) copyPackage(dep, req, dest, next);
      for (const dep of Object.keys(meta.optionalDependencies ?? {})) { try { locate(req, dep); } catch { continue; } copyPackage(dep, req, dest, next); }
    }
    for (const name of external) copyPackage(name, sourceRequire, staging, new Set());
    fs.writeFileSync(path.join(staging, ".complete"), id, { mode: 0o600 });
    try { fs.renameSync(staging, root); } catch (error) { if (!fs.existsSync(path.join(root, ".complete"))) throw error; }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return result;
}
