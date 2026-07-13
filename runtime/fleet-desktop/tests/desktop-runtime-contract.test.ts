import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readDesktopFile = (relativePath: string): string => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

describe("desktop shell runtime contract", () => {
  it("keeps local entry and pairing assets with Node metadata in the packaged shell", () => {
    const verifier = readDesktopFile("scripts/verify-packaged-app.mjs");
    expect(verifier).toContain("Embedded sidecar directory is forbidden");
    expect(verifier).toContain('"dist/assets/entry/index.html"');
    expect(verifier).toContain('"dist/assets/entry/entry.css"');
    expect(verifier).toContain('"dist/assets/pairing/index.html"');
    expect(verifier).toContain('"dist/assets/pairing/pairing.css"');
    expect(verifier).toContain('"dist/build/node-runtime.json"');
    expect(verifier).toContain('"dist/cli.mjs"');
    expect(verifier).toContain('"node_modules/"');
    expect(verifier).toContain("latest.*\\.yml");
    expect(verifier).toContain("endsWith(\".blockmap\")");
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
