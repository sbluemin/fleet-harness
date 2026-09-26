import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { OwnedTempAccess } from "@fleet-console/sdk/mcp";

export const OWNED_TEMP_LIMITS = { inactiveMs: 7 * 24 * 60 * 60 * 1000, inactiveBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3, roots: 1000, gcMs: 60 * 60 * 1000, pathBytes: 3000 } as const;
type Entry = { id: string; operationId: string; sessionId?: string; touched: number };
export interface OwnedTempLease {
  readonly env: Readonly<Record<string, string>>;
  bindSession(sessionId: string): void;
  release(): void;
}

/** execution이 발급한 임시 root만 소유한다. cwd·외부 scratchpad·사용자가 선언한 root는 입양하지 않는다. */
export function createOwnedFileScopes(options: { readonly dataDir: string; readonly now?: () => number; readonly limits?: { readonly [K in keyof typeof OWNED_TEMP_LIMITS]?: number } }) {
  const now = options.now ?? Date.now;
  const limits = { ...OWNED_TEMP_LIMITS, ...options.limits };
  const base = path.join(options.dataDir, "ot");
  const index = path.join(base, "index.json");
  const active = new Map<string, { entry: Entry; live: boolean; access: OwnedTempAccess }>();
  let entries: Entry[] | undefined;
  let disposed = false;
  const unavailable = (reason: string): OwnedTempAccess => ({ read: () => ({ error: "scope_unavailable", reason }) });
  const fail = (code: string): never => { throw new Error(code); };
  const ownDirectory = (dir: string) => {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)) fail("scope_unsafe_directory");
  };
  const rootOf = (entry: Entry) => {
    if (!/^[a-f0-9]{8}$/.test(entry.id)) return fail("scope_invalid_manifest");
    const root = path.join(base, entry.id);
    ownDirectory(base); ownDirectory(root);
    if (path.dirname(fs.realpathSync(root)) !== fs.realpathSync(base)) return fail("scope_unsafe_directory");
    return fs.realpathSync(root);
  };
  const save = () => {
    ownDirectory(base);
    const temp = path.join(base, `${randomBytes(8).toString("hex")}.tmp`);
    try { fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, index); }
    finally { try { fs.unlinkSync(temp); } catch { /* rename 뒤에는 없다. */ } }
  };
  const load = () => {
    if (entries) return;
    if (!path.isAbsolute(options.dataDir)) fail("scope_invalid_data_root");
    fs.mkdirSync(options.dataDir, { recursive: true });
    try { fs.mkdirSync(base, { mode: 0o700 }); entries = []; save(); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    ownDirectory(base);
    const stat = fs.lstatSync(index);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) fail("scope_invalid_manifest");
    const stored = JSON.parse(fs.readFileSync(index, "utf8"));
    if (stored?.version !== 1 || !Array.isArray(stored.entries) || stored.entries.length > limits.roots) fail("scope_invalid_manifest");
    if (stored.entries.some((entry: Entry) => !entry || !/^[a-f0-9]{8}$/.test(entry.id) || typeof entry.operationId !== "string" || entry.operationId.length > 128 || (entry.sessionId !== undefined && typeof entry.sessionId !== "string") || !Number.isFinite(entry.touched))) fail("scope_invalid_manifest");
    if (new Set(stored.entries.map((entry: Entry) => entry.id)).size !== stored.entries.length) fail("scope_invalid_manifest");
    entries = stored.entries;
  };
  const busy = (id: string) => [...active.values()].some((lease) => lease.live && lease.entry.id === id);
  const sizeOf = (dir: string, root = fs.realpathSync(dir)): number => {
    const resolved = fs.realpathSync(dir);
    const relative = path.relative(root, resolved);
    if (fs.lstatSync(dir).isSymbolicLink() || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail("scope_unsafe_directory");
    let bytes = 0;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      const stat = fs.lstatSync(file);
      bytes += stat.isDirectory() && !stat.isSymbolicLink() ? sizeOf(file, root) : stat.size;
    }
    return bytes;
  };
  const remove = (entry: Entry) => {
    // registry에 있는 자체 root만 지운다. 링크로 바뀐 자리의 대상은 따라가지 않는다.
    const root = rootOf(entry);
    fs.rmSync(root, { recursive: true, force: false });
    entries = entries!.filter((candidate) => candidate.id !== entry.id);
  };
  const collect = () => {
    load();
    let changed = false;
    const sizes = new Map<string, number>();
    for (const entry of [...entries!]) {
      try { sizes.set(entry.id, sizeOf(rootOf(entry))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || busy(entry.id)) throw error;
        entries = entries!.filter((candidate) => candidate.id !== entry.id); changed = true;
      }
    }
    let inactiveBytes = entries!.filter((entry) => !busy(entry.id)).reduce((sum, entry) => sum + (sizes.get(entry.id) ?? 0), 0);
    for (const entry of [...entries!].sort((a, b) => a.touched - b.touched)) {
      if (busy(entry.id)) continue;
      if (now() - entry.touched <= limits.inactiveMs && inactiveBytes <= limits.inactiveBytes) continue;
      remove(entry); inactiveBytes -= sizes.get(entry.id) ?? 0; sizes.delete(entry.id); changed = true;
    }
    if (changed) save();
    return [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  };
  const release = (label: string, state: { entry: Entry; live: boolean }) => {
    if (!state.live) return;
    state.live = false;
    if (active.get(label) === state) active.delete(label);
    state.entry.touched = now();
    if (!state.entry.sessionId && !busy(state.entry.id)) remove(state.entry);
    save();
  };
  const timer = setInterval(() => { if (!disposed && entries) try { collect(); } catch { console.warn("[execution] owned_temp_gc_failed"); } }, limits.gcMs);
  timer.unref?.();
  return {
    acquire(input: { readonly operationId: string; readonly label: string; readonly provider: string; readonly resume?: string; readonly env: NodeJS.ProcessEnv }): OwnedTempLease {
      if (disposed) return fail("scope_unavailable");
      if (input.provider !== "claude") return fail("scope_unsupported_provider");
      if (active.has(input.label)) return fail("scope_lease_busy");
      load();
      if (collect() >= limits.totalBytes || entries!.length >= limits.roots) return fail("scope_capacity");
      let entry = input.resume ? entries!.find((candidate) => candidate.operationId === input.operationId && candidate.sessionId === input.resume) : undefined;
      if (!entry) {
        let id = randomBytes(4).toString("hex");
        for (let attempt = 0; fs.existsSync(path.join(base, id)) && attempt < 5; attempt += 1) id = randomBytes(4).toString("hex");
        const root = path.join(base, id);
        if (Buffer.byteLength(root) > limits.pathBytes) return fail("root_path_too_long");
        fs.mkdirSync(root, { mode: 0o700 });
        entry = { id, operationId: input.operationId, ...(input.resume ? { sessionId: input.resume } : {}), touched: now() };
        entries!.push(entry);
        try { save(); } catch (error) { entries!.pop(); fs.rmdirSync(root); throw error; }
      }
      const owned = entry;
      const root = rootOf(owned);
      const state = { entry: owned, live: true, access: unavailable("lease_revoked") };
      state.access = { read: () => {
        if (!state.live || disposed) return { error: "scope_unavailable", reason: "lease_revoked" };
        try { return { id: owned.id, root: rootOf(owned) }; }
        catch { return { error: "scope_unavailable", reason: "unsafe_root" }; }
      } };
      active.set(input.label, state);
      return {
        // messaging과 vscode-ipc의 base는 opt-in 전과 같다. Bash의 일반 TMPDIR fallback은 별도 CLI 정책이다.
        env: { CLAUDE_CODE_TMPDIR: root, FLEET_OWNED_TEMP_SCOPE: owned.id, XDG_RUNTIME_DIR: input.env.XDG_RUNTIME_DIR || input.env.CLAUDE_CODE_TMPDIR || "/tmp" },
        bindSession(sessionId) { if (!state.live) return; if (owned.sessionId && owned.sessionId !== sessionId) fail("scope_session_mismatch"); owned.sessionId = sessionId; owned.touched = now(); save(); },
        release: () => release(input.label, state),
      };
    },
    access(label: string): OwnedTempAccess { return active.get(label)?.access ?? unavailable("not_issued"); },
    purge(operationId: string) {
      if (!entries && !fs.existsSync(base)) return;
      load();
      for (const [label, state] of active) if (state.entry.operationId === operationId) release(label, state);
      for (const entry of [...entries!]) if (entry.operationId === operationId) remove(entry);
      save();
    },
    collect,
    dispose() { if (disposed) return; disposed = true; clearInterval(timer); for (const [label, state] of active) release(label, state); },
  };
}
