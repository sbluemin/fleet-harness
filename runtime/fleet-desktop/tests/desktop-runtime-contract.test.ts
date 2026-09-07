import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readDesktopFile = (relativePath: string): string => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

describe("desktop shell runtime contract", () => {
  it("keeps the local entry asset with Node metadata in the packaged shell", async () => {
    const verifier = readDesktopFile("scripts/verify-packaged-app.mjs");
    expect(verifier).toContain("Embedded sidecar directory is forbidden");
    expect(verifier).toContain('"dist/assets/entry/index.html"');
    expect(verifier).toContain('"dist/assets/entry/entry.css"');
    expect(verifier).toContain('"dist/build/node-runtime.json"');
    expect(verifier).toContain('"dist/cli.mjs"');
    expect(verifier).toContain('"node_modules/"');
    const { verifyPackagedApplication } = await import(pathToFileURL(path.join(desktopRoot, "scripts", "verify-packaged-app.mjs")).href);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fc-updater-contract-"));
    try {
      for (const name of ["latest-mac.yml", "app.dmg.blockmap"]) {
        const artifact = path.join(root, name);
        fs.writeFileSync(artifact, "updater artifact");
        await expect(verifyPackagedApplication(root)).rejects.toThrow(`Updater artifact is forbidden: ${artifact}`);
        expect(fs.existsSync(artifact)).toBe(true);
        fs.unlinkSync(artifact);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs npm-cli.js with the bundled Node binary instead of a host npm command", () => {
    const installer = readDesktopFile("src/runtime/console-installer.ts");
    expect(installer).toContain("nodeBinaryPath(options.nodeRoot, options.platform)");
    expect(installer).toContain("npmCliPath(options.nodeRoot, options.platform)");
    expect(installer).toContain("npm-cli.js");
    expect(installer).toContain('"--global=false"');
    expect(installer).toContain('"--force=false"');
    expect(installer).not.toMatch(/\bnpx\b/);
  });

  it("pins the five required Electron fuse states with boolean flip configuration", () => {
    const verifier = readDesktopFile("scripts/verify-packaged-app.mjs");
    expect(verifier).toContain("[FuseV1Options.RunAsNode]: false");
    expect(verifier).toContain("[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false");
    expect(verifier).toContain("[FuseV1Options.EnableNodeCliInspectArguments]: false");
    expect(verifier).toContain("[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true");
    expect(verifier).toContain("[FuseV1Options.OnlyLoadAppFromAsar]: true");
    expect(verifier).toContain("FuseState.DISABLE");
    expect(verifier).toContain("FuseState.ENABLE");
  });
});
