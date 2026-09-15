import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { x as untar } from "tar";
import { unzipSync } from "fflate";
import { CUA_LICENSE } from "./cua-license.js";

const exec = promisify(execFile);
export const CUA_VERSION = "0.28.1";
const RELEASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_VERSION}/`;
const ASSETS: Record<string, { name: string; hash: string }> = {
  darwin: { name: "darwin-universal.tar.gz", hash: "52fdabd1947c9b252d881a257d3169372ed1a2d4ea90cdcce7dd624e8360d133" },
  "linux-arm64": { name: "linux-arm64-binary.tar.gz", hash: "02693499d34d6fe30bef99ef2f3051974ee7989469e3e7a9edc404896bdc6bbd" },
  "linux-x64": { name: "linux-x86_64-binary.tar.gz", hash: "71aa92533de90a68a0a2af930243f1770d23e45b896b57d67a1763da4bfaeaf7" },
  "win32-arm64": { name: "windows-arm64-binary.zip", hash: "d260e6110e029680d543d317f3c3c09569475f8d65855fcedda202e2ee989bf0" },
  "win32-x64": { name: "windows-x86_64-binary.zip", hash: "ab90418a54f84102f549cde4537daef3a0e20ba8254b7e24524a50fc5f4174d3" },
};
export function cuaInstallSupported(): boolean { return Boolean(ASSETS[process.platform === "darwin" ? "darwin" : `${process.platform}-${process.arch}`]); }
function managedBinary(root: string): string {
  return path.join(root, "driver", CUA_VERSION, process.platform === "darwin" ? "CuaDriver.app/Contents/MacOS/cua-driver" : process.platform === "win32" ? "cua-driver.exe" : "cua-driver");
}
export async function resolveCuaDriver(root: string): Promise<string | null> {
  const candidates = [managedBinary(root), ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(p => path.join(p, process.platform === "win32" ? "cua-driver.exe" : "cua-driver"))];
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      const { stdout } = await exec(candidate, ["--version"], { timeout: 3000, windowsHide: true });
      if (stdout.trim() === `cua-driver ${CUA_VERSION}`) return candidate;
    } catch { /* 다음 설치 후보를 확인한다. */ }
  }
  return null;
}

/** 사용자 설치본·공유 데몬·PATH·OS 권한을 변경하지 않는 Fleet 전용 설치. */
export class CuaDriverInstaller {
  private pending: Promise<void> | null = null;
  private phase: "idle" | "downloading" | "verifying" | "installing" | "ready" | "failed" = "idle";
  private error: string | null = null;
  constructor(private readonly root: string) {}
  status() { return { phase: this.phase, error: this.error, version: CUA_VERSION, supported: cuaInstallSupported(), license: "MIT", source: "https://github.com/trycua/cua" }; }
  install(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.perform().catch(() => { this.phase = "failed"; this.error = "computer_use_install_failed"; throw new Error(this.error); }).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async perform(): Promise<void> {
    const asset = ASSETS[process.platform === "darwin" ? "darwin" : `${process.platform}-${process.arch}`];
    if (!asset) throw new Error("computer_use_platform_unsupported");
    const destination = path.join(this.root, "driver", CUA_VERSION);
    try { if ((await fs.stat(managedBinary(this.root))).isFile()) { this.phase = "ready"; return; } } catch {}
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const staging = await fs.mkdtemp(path.join(path.dirname(destination), ".install-"));
    this.error = null;
    try {
      this.phase = "downloading";
      const response = await fetch(`${RELEASE}cua-driver-rs-${CUA_VERSION}-${asset.name}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error("download_failed");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength; if (bytes > 150 * 1024 * 1024) throw new Error("download_too_large"); chunks.push(Buffer.from(chunk));
      }
      const archive = Buffer.concat(chunks);
      this.phase = "verifying";
      if (crypto.createHash("sha256").update(archive).digest("hex") !== asset.hash) throw new Error("checksum_mismatch");
      const unpacked = path.join(staging, "unpacked"); await fs.mkdir(unpacked);
      const safe = (name: string) => !name.includes("\\") && !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && !name.split("/").includes("..");
      if (asset.name.endsWith(".zip")) {
        const files = unzipSync(archive); let expanded = 0;
        for (const [name, data] of Object.entries(files)) {
          if (!safe(name)) throw new Error("unsafe_archive");
          expanded += data.byteLength; if (expanded > 500 * 1024 * 1024) throw new Error("archive_too_large");
          if (name.endsWith("/")) { await fs.mkdir(path.join(unpacked, name), { recursive: true }); continue; }
          await fs.mkdir(path.dirname(path.join(unpacked, name)), { recursive: true }); await fs.writeFile(path.join(unpacked, name), data);
        }
      } else {
        const archivePath = path.join(staging, "archive.tar.gz"); await fs.writeFile(archivePath, archive);
        await untar({ file: archivePath, cwd: unpacked, strict: true, preservePaths: false, filter: (name, entry) => {
          if (!safe(name) || !("type" in entry) || !["File", "Directory", "SymbolicLink"].includes(entry.type) || entry.type === "SymbolicLink" && !safe(entry.linkpath ?? "")) throw new Error("unsafe_archive");
          return true;
        } });
      }
      const entries = await fs.readdir(unpacked);
      const payload = entries.length === 1 && entries[0] !== "CuaDriver.app" && (await fs.stat(path.join(unpacked, entries[0]!))).isDirectory() ? path.join(unpacked, entries[0]!) : unpacked;
      const binary = path.join(payload, process.platform === "darwin" ? "CuaDriver.app/Contents/MacOS/cua-driver" : process.platform === "win32" ? "cua-driver.exe" : "cua-driver");
      await fs.access(binary);
      if (process.platform !== "win32") await fs.chmod(binary, 0o755);
      if (process.platform === "darwin") await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(payload, "CuaDriver.app")], { timeout: 30_000 });
      const version = await exec(binary, ["--version"], { timeout: 5000, windowsHide: true });
      if (version.stdout.trim() !== `cua-driver ${CUA_VERSION}`) throw new Error("version_mismatch");
      this.phase = "installing";
      // 사용하지 않는 FFI 런타임은 설치하지 않는다. 별도 라이선스 의존성도 함께 줄인다.
      const retained = new Set(process.platform === "darwin" ? ["CuaDriver.app"] : process.platform === "win32" ? ["cua-driver.exe", "cua-cursor-theme.exe"] : ["cua-driver", "cua-cursor-theme"]);
      for (const name of await fs.readdir(payload)) if (!retained.has(name)) await fs.rm(path.join(payload, name), { recursive: true, force: true });
      await fs.writeFile(path.join(payload, "LICENSE-Cua-Driver.txt"), CUA_LICENSE);
      // 목적지가 이미 있으면 덮어쓰지 않는다. 실행 중인 버전 교체는 별도 업데이트 계약이다.
      await fs.rename(payload, destination);
      this.phase = "ready";
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
}
