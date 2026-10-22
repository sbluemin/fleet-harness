import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "../process.js";
import { observeConsoleLockFile } from "../lock-file.js";
import { privateSessionDirectory, sessionHostPaths } from "./files.js";

const GENERATION = /^[a-f0-9]{64}$/;
function trusted(file: string, directory: boolean): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw new Error("untrusted_generation_entry");
  return stat;
}
function baseOf(dataDir: string): string {
  const slot = sessionHostPaths(dataDir).dir;
  privateSessionDirectory(slot);
  const base = path.join(slot, "generations"); privateSessionDirectory(base);
  const real = fs.realpathSync(base);
  if (real !== path.join(fs.realpathSync(slot), "generations")) throw new Error("generation_outside_slot");
  return real;
}
function readPrivate(file: string): string {
  const stat = trusted(file, false);
  if (stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("untrusted_generation_record");
  return fs.readFileSync(file, "utf8");
}
/** 완성된 lock record를 hard-link로 publish하여 작성 중 owner 공백을 만들지 않는다. */
export function withSessionGenerationLock<T>(dataDir: string, run: () => T, reclaim = false): T {
  const base = baseOf(dataDir); const lock = path.join(base, ".lock");
  const content = JSON.stringify({ v: 1, pid: process.pid, nonce: randomUUID() });
  const staging = path.join(base, `.lock-${process.pid}-${randomUUID()}`);
  fs.writeFileSync(staging, content, { flag: "wx", mode: 0o600 });
  let held = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.linkSync(staging, lock); held = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const consoleOwner = observeConsoleLockFile(sessionHostPaths(dataDir).lockFile);
        if (!reclaim || consoleOwner.kind !== "owner" || consoleOwner.untrusted || consoleOwner.instance.pid !== process.pid) throw new Error("session_generation_busy");
        const bytes = readPrivate(lock); let owner: { pid?: number };
        try { owner = JSON.parse(bytes) as { pid?: number }; } catch { throw new Error("session_generation_lock_unverified"); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 1 || isPidAlive(owner.pid!)) throw new Error("session_generation_busy");
        if (readPrivate(lock) !== bytes || isPidAlive(owner.pid!)) throw new Error("session_generation_busy");
        fs.unlinkSync(lock);
      }
    }
    if (!held) throw new Error("session_generation_busy");
    return run();
  } finally {
    fs.rmSync(staging, { force: true });
    if (held && fs.existsSync(lock) && readPrivate(lock) === content) fs.unlinkSync(lock);
  }
}
function rootOf(dataDir: string, id: string): string {
  if (!GENERATION.test(id)) throw new Error("invalid_generation_id");
  const base = baseOf(dataDir); const root = path.join(base, id); trusted(root, true);
  if (fs.realpathSync(root) !== root || readPrivate(path.join(root, ".complete")) !== id) throw new Error("untrusted_generation_root");
  return root;
}
function writeRecord(root: string, name: string, value: unknown): void {
  const dest = path.join(root, name);
  if (fs.existsSync(dest)) readPrivate(dest);
  const tmp = `${dest}.${process.pid}.${randomUUID()}`;
  try { fs.writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, dest); }
  finally { fs.rmSync(tmp, { force: true }); }
}
/** 호출자는 generation lock을 쥔다. prepare와 attach 사이에는 살아 있는 Console pin이 보호한다. */
export function pinSessionGeneration(dataDir: string, id: string): void {
  writeRecord(rootOf(dataDir, id), ".pin", { v: 1, pid: process.pid });
}
/** runner spawn/owner attach 전에 lock 안에서 이전 retirement 증명을 무효화한다. */
export function activateSessionGeneration(dataDir: string, id: string): void {
  const root = rootOf(dataDir, id);
  for (const name of [".retired", ".pin"]) { const file = path.join(root, name); if (fs.existsSync(file)) { readPrivate(file); fs.unlinkSync(file); } }
}
/** host가 자신의 child exit 또는 미사용 inventory를 확인한 경우에만 호출한다. */
export function retireSessionGeneration(dataDir: string, id: string, hostId: string): void {
  writeRecord(rootOf(dataDir, id), ".retired", { v: 1, generation: id, hostId, pid: process.pid });
}
export interface SessionGenerationGcOptions {
  readonly dataDir: string;
  readonly hostId: string;
  readonly keep: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
  readonly diagnostic: (kind: string, generation: string | null, reason: string) => void;
  /** Windows는 POSIX uid가 없으므로 조합부가 현재 사용자 SID 소유 증명을 주입한다. */
  readonly owns?: (file: string) => boolean;
}
/** 증명하지 못하면 보존한다. GC 실패는 기동이나 실행을 막지 않는다. */
export function collectSessionGenerations(options: SessionGenerationGcOptions): void {
  try {
    if (process.platform === "win32" && !options.owns) throw new Error("windows_generation_owner_unverified");
    withSessionGenerationLock(options.dataDir, () => {
      const base = baseOf(options.dataDir);
      if (options.owns && (!options.owns(path.dirname(base)) || !options.owns(base))) throw new Error("untrusted_generation_owner");
      for (const id of fs.readdirSync(base)) {
        if (!GENERATION.test(id) || options.keep.has(id)) continue;
        try {
          const root = rootOf(options.dataDir, id); const proofFile = path.join(root, ".retired");
          if (!fs.existsSync(proofFile)) continue;
          const proof = JSON.parse(readPrivate(proofFile)) as { v: number; generation: string; hostId: string; pid: number };
          if (proof.v !== 1 || proof.generation !== id || !Number.isSafeInteger(proof.pid) || proof.pid <= 1 || typeof proof.hostId !== "string") throw new Error("invalid_retirement_proof");
          const localProof = proof.pid === process.pid && proof.hostId === options.hostId && options.retired.has(id);
          if (!localProof && isPidAlive(proof.pid)) { options.diagnostic("session_generation_gc_deferred", id, "retirement_owner_alive"); continue; }
          const pin = path.join(root, ".pin");
          if (fs.existsSync(pin)) {
            const value = JSON.parse(readPrivate(pin)) as { pid: number };
            if (!Number.isSafeInteger(value.pid) || value.pid <= 1) throw new Error("generation_pin_unverified");
            if (isPidAlive(value.pid)) { options.diagnostic("session_generation_gc_deferred", id, "generation_pin_alive"); continue; }
          }
          const inspect = (entry: string): void => {
            const stat = fs.lstatSync(entry);
            if (stat.isSymbolicLink() || (process.platform !== "win32" && stat.uid !== process.getuid?.()) || (options.owns && !options.owns(entry))) throw new Error("untrusted_generation_tree");
            if (!stat.isDirectory() && !stat.isFile()) throw new Error("invalid_generation_tree");
            if (stat.isDirectory()) for (const child of fs.readdirSync(entry)) inspect(path.join(entry, child));
          };
          inspect(root);
          // 마지막 검사도 lock 안이다. 교체된 root나 symlink를 따라 슬롯 밖을 삭제하지 않는다.
          if (options.keep.has(id) || fs.realpathSync(root) !== path.join(base, id) || !fs.lstatSync(root).isDirectory()) throw new Error("generation_changed");
          const trash = path.join(base, `.gc-${id}-${randomUUID()}`);
          fs.renameSync(root, trash);
          try { fs.rmSync(trash, { recursive: true }); }
          catch (error) {
            if (!fs.existsSync(root) && fs.existsSync(trash)) {
              fs.renameSync(trash, root);
              writeRecord(root, ".retired", proof);
              fs.writeFileSync(path.join(root, ".complete"), id, { mode: 0o600 });
            }
            throw error;
          }
          options.diagnostic("session_generation_collected", id, "proven_retired");
        } catch (error) { options.diagnostic("session_generation_gc_deferred", id, error instanceof Error ? error.message : "gc_failed"); }
      }
    });
  } catch (error) { options.diagnostic("session_generation_gc_deferred", null, error instanceof Error ? error.message : "gc_failed"); }
}
