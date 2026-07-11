import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("release package verification", () => {
  it("runs Linux checksum signing and artifact verification only for release verification", async () => {
    const verifier = await readFile(path.join(desktopRoot, "scripts", "verify-packaged-app.mjs"), "utf8");
    expect(verifier).toContain('if (requiresReleaseSignature && platform === "linux") await signAndVerifyLinuxRelease(releaseDirectory);');
    expect(verifier).toContain('"sign-linux-checksums.mjs"');
    expect(verifier).toContain('"verify-release-artifacts.mjs"');
  });

  it("targets the macOS Electron Framework binary for fuse apply and assertion", async () => {
    const verifier = await readFile(path.join(desktopRoot, "scripts", "verify-packaged-app.mjs"), "utf8");
    // macOS fuse 와이어는 런처가 아니라 프레임워크 바이너리에 있다 — 하드닝 적용/검증이 프레임워크를 겨냥해야 한다.
    expect(verifier).toContain('"Electron Framework.framework", "Versions", "A", "Electron Framework"');
    expect(verifier).toContain("await flipFuses(application.fuseBinary,");
    expect(verifier).toContain("await assertFuses(application.fuseBinary);");
  });

  it("accepts the expected PE architecture and rejects a mismatched Electron binary", async () => {
    // Windows 실기는 [Unverified]지만 PE 헤더 판독은 fixture로 고정한다.
    const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-electron-arch-"));
    const binary = path.join(directory, "Fleet Console.exe");
    const header = Buffer.alloc(0x40);
    header.write("MZ", 0, "ascii");
    header.writeUInt32LE(0x20, 0x3c);
    header.write("PE\0\0", 0x20, "ascii");
    header.writeUInt16LE(0x8664, 0x24);
    await writeFile(binary, header);
    try {
      const verifier = await import(pathToFileURL(path.join(desktopRoot, "scripts", "verify-packaged-app.mjs")).href);
      await expect(verifier.assertElectronArchitecture(binary, "win32", "x64")).resolves.toBeUndefined();
      await expect(verifier.assertElectronArchitecture(binary, "win32", "arm64")).rejects.toThrow("Electron binary target mismatch");
      expect(verifier.expectedArchitectureFromDirectory(path.join(directory, "win-x64-unpacked", "resources"))).toBe("x64");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
