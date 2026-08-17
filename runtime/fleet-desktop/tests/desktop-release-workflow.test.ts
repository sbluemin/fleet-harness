import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = path.join(repoRoot, ".github/workflows/desktop-release.yml");
const signingDocPath = path.join(repoRoot, "runtime/fleet-desktop/SIGNING.md");

function macosJob(source: string): string {
  const match = source.match(/\n {2}macos:[\s\S]*?\n {2}windows:/);
  if (!match) throw new Error("macos job not found in desktop-release.yml");
  return match[0];
}

function namedStep(job: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = job.match(new RegExp(`- name: ${escaped}\\n[\\s\\S]*?(?=\\n {6}- name: |$)`));
  if (!match) throw new Error(`step "${name}" not found in macos job`);
  return match[0];
}

describe("desktop-release macOS fail-closed signing", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const macos = macosJob(workflow);
  const packageStep = namedStep(macos, "Package shell installers (mac arm64)");
  const verifyStep = namedStep(macos, "Verify shell-only package");
  const signingDoc = fs.readFileSync(signingDocPath, "utf8");

  it("binds the mac job to the macos-release environment", () => {
    expect(macos).toMatch(/^\s{4}environment: macos-release$/m);
  });

  it("maps repository secrets onto electron-builder names without MAC_* intermediates", () => {
    expect(packageStep).toContain("CSC_LINK: ${{ secrets.MAC_CSC_LINK }}");
    expect(packageStep).toContain("CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}");
    expect(packageStep).toContain("APPLE_ID: ${{ secrets.APPLE_ID }}");
    expect(packageStep).toContain("APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}");
    expect(packageStep).toContain("APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}");
    expect(packageStep).not.toMatch(/^\s+MAC_(?:CSC_LINK|CSC_KEY_PASSWORD|APPLE_)/m);
    expect(packageStep).not.toContain("MAC_APPLE_");
  });

  it("preflights then force-signs and notarizes arm64 without an unsigned fallback", () => {
    expect(packageStep).toContain("FLEET_DESKTOP_TARGET: darwin-arm64");
    expect(packageStep).not.toMatch(/^\s+FLEET_DESKTOP_RELEASE:/m);
    expect(packageStep).toContain("FLEET_DESKTOP_RELEASE=1 pnpm --filter @dotobokuri/fleet-desktop run prepackage:release");
    expect(packageStep).toContain("pnpm --filter @dotobokuri/fleet-desktop exec electron-builder --mac --arm64 --publish never --config.forceCodeSigning=true --config.mac.notarize=true");
    expect(packageStep).not.toMatch(/FLEET_DESKTOP_RELEASE=1 pnpm --filter @dotobokuri\/fleet-desktop exec electron-builder/);
    expect(packageStep).not.toMatch(/configured=/);
    expect(packageStep).not.toMatch(/Partial macOS signing configuration/);
    expect(packageStep).not.toMatch(/or remove all five/);
  });

  it("verifies the signed package with release flags and without CSC/APPLE secrets", () => {
    expect(verifyStep).toContain("FLEET_DESKTOP_RELEASE: '1'");
    expect(verifyStep).toContain("FLEET_DESKTOP_TARGET: darwin-arm64");
    expect(verifyStep).toContain("pnpm --filter @dotobokuri/fleet-desktop run verify:package --release");
    expect(verifyStep).not.toContain("verify:package -- --release");
    expect(verifyStep).not.toMatch(/CSC_|APPLE_/);
  });

  it("documents fail-closed Developer ID release, not an unsigned public installer", () => {
    expect(signingDoc).toContain("macos-release");
    expect(signingDoc).toContain("Developer ID Application");
    expect(signingDoc).toContain("fail the mac job");
    expect(signingDoc).toContain("There is no unsigned public-release");
    expect(signingDoc).toContain("first real signed release remains **[Unverified]** until");
    expect(signingDoc).not.toMatch(/unsigned apps need right-click/);
    expect(signingDoc).not.toMatch(/automatically starts signing once the secrets/);
  });
});
