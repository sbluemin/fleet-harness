import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredAsarFiles = ["dist/assets/entry/index.html", "dist/assets/entry/entry.css", "dist/assets/pairing/index.html", "dist/assets/pairing/pairing.css", "dist/build/node-runtime.json", "dist/build/icon.png", "dist/build/trayTemplate.png", "dist/build/trayTemplate@2x.png"];

describe("shell-only packaged layout", () => {
  it("keeps runtime payload out of every available packaged resource directory", () => {
    for (const resources of findResourceDirectories()) {
      expect(fs.existsSync(path.join(resources, "app.asar"))).toBe(true);
      expect(fs.existsSync(path.join(resources, "sidecar"))).toBe(false);
    }
  });

  it("packages passive entry and pairing assets with the Node manifest inside ASAR without Console payload", () => {
    for (const resources of findResourceDirectories()) {
      const files = listPackage(path.join(resources, "app.asar"), { isPack: false }).map((file) => file.replace(/^\//, ""));
      for (const required of requiredAsarFiles) expect(files).toContain(required);
      expect(files.some((file) => file === "dist/cli.mjs" || file.includes("/fleet-console/") || file.includes("/node-pty/") || file.includes("/node_modules/"))).toBe(false);
    }
  });
});

function findResourceDirectories(): string[] {
  const release = path.join(desktopRoot, "release");
  if (!fs.existsSync(release)) return [];
  return fs.readdirSync(release, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith("Resources/app.asar"))
    .map((entry) => path.dirname(path.join(release, entry)));
}
