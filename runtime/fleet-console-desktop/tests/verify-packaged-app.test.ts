import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
});
