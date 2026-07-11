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
});
