import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { formatDesktopResourceRootMarker, isDesktopResourceRootMarkerValid } from "@fleet-console/desktop-protocol";

import {
  DESKTOP_DEVELOPMENT_ENV,
  DESKTOP_OWNER_ID_ENV,
  DESKTOP_OWNER_KIND_ENV,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION_ENV,
  DESKTOP_RESOURCE_ROOT_ENV,
  DESKTOP_RESOURCE_ROOT_MARKER,
  isCompatibleDesktopOwner,
  readDesktopProtocolEnvironment,
  resolveCanonicalLocalConsolePaths,
  resolveCanonicalStableConsolePaths,
} from "../core/host/desktop-protocol.js";

const TEMP_DIRS: string[] = [];
const CONSOLE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("desktop protocol", () => {
  it("shares the version-1 resource-root marker formatter and trim-tolerant validator", () => {
    expect(formatDesktopResourceRootMarker()).toBe("1\n");
    expect(isDesktopResourceRootMarkerValid("1\n")).toBe(true);
    expect(isDesktopResourceRootMarkerValid(" \t1\r\n")).toBe(true);
    expect(isDesktopResourceRootMarkerValid("2\n")).toBe(false);
  });

  it("keeps the shared contract free of host and filesystem ownership", () => {
    const source = fs.readFileSync(path.join(CONSOLE_PACKAGE_ROOT, "desktop-protocol", "index.ts"), "utf8");

    expect(source).not.toMatch(/node:(?:fs|child_process)/);
    expect(source).not.toMatch(/(?:@dotobokuri\/|fleet-desktop|fleet-plugins)/);
    expect(source).not.toMatch(/\b(?:process|electron)\b/);
    expect(source).not.toContain("DESKTOP_TITLE_BAR_OVERLAYS");
    expect(source).not.toContain("desktopThemeSnapshot");
  });

  it("publishes no theme transport exports", () => {
    const source = fs.readFileSync(path.join(CONSOLE_PACKAGE_ROOT, "desktop-protocol", "index.ts"), "utf8");

    expect(source).not.toMatch(/^export (?:type |interface |const |function )(?:ConsoleThemeId|DesktopThemeId|DesktopTitleBarOverlay|DesktopThemeSnapshot|DESKTOP_THEME_PATH|DESKTOP_THEME_EVENTS_PATH|DESKTOP_THEME_EVENT|isDesktopThemeSnapshot)\b/gmu);
  });

  it("validates the marked resource root and exact owner protocol", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-resource-"));
    TEMP_DIRS.push(root);
    fs.writeFileSync(path.join(root, DESKTOP_RESOURCE_ROOT_MARKER), `${DESKTOP_PROTOCOL_VERSION}\n`);
    const env = {
      [DESKTOP_RESOURCE_ROOT_ENV]: root,
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_OWNER_ID_ENV]: "desktop-owner-1",
      [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION),
    } as NodeJS.ProcessEnv;

    const desktop = readDesktopProtocolEnvironment(env, { expectedPackageRoot: root });

    expect(desktop).toEqual({ owner: { kind: "desktop", id: "desktop-owner-1", protocolVersion: 1 }, resourceRoot: fs.realpathSync(root) });
    expect(isCompatibleDesktopOwner(desktop?.owner, "1.2.3", { id: "desktop-owner-1", version: "1.2.3" })).toBe(true);
    expect(isCompatibleDesktopOwner(desktop?.owner, "1.2.4", { id: "desktop-owner-1", version: "1.2.3" })).toBe(false);
  });

  it("rejects incomplete or unmarked desktop environments", () => {
    expect(() => readDesktopProtocolEnvironment({ [DESKTOP_OWNER_ID_ENV]: "desktop-owner-1" })).toThrow("desktop_protocol_environment_incomplete");
    expect(() => readDesktopProtocolEnvironment({
      [DESKTOP_RESOURCE_ROOT_ENV]: "/not-a-real-resource-root",
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_OWNER_ID_ENV]: "desktop-owner-1",
      [DESKTOP_PROTOCOL_VERSION_ENV]: "1",
    })).toThrow();
  });

  it("rejects an arbitrary marked resource root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-resource-"));
    TEMP_DIRS.push(root);
    fs.writeFileSync(path.join(root, DESKTOP_RESOURCE_ROOT_MARKER), `${DESKTOP_PROTOCOL_VERSION}\n`);

    expect(() => readDesktopProtocolEnvironment({
      [DESKTOP_RESOURCE_ROOT_ENV]: root,
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_OWNER_ID_ENV]: "desktop-owner-1",
      [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION),
    })).toThrow("desktop_resource_root_invalid");
  });

  it("accepts only this source package root for an explicitly development-scoped desktop", () => {
    const env = {
      [DESKTOP_DEVELOPMENT_ENV]: "1",
      [DESKTOP_RESOURCE_ROOT_ENV]: CONSOLE_PACKAGE_ROOT,
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_OWNER_ID_ENV]: "desktop-owner-1",
      [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION),
    } as NodeJS.ProcessEnv;

    expect(readDesktopProtocolEnvironment(env)?.resourceRoot).toBe(fs.realpathSync(CONSOLE_PACKAGE_ROOT));
    expect(resolveCanonicalLocalConsolePaths({ packageRoot: CONSOLE_PACKAGE_ROOT }).dir).toBe(path.join(path.resolve(CONSOLE_PACKAGE_ROOT, "..", ".."), ".fleet", "console"));
    expect(() => readDesktopProtocolEnvironment({ ...env, [DESKTOP_RESOURCE_ROOT_ENV]: "/tmp/not-the-console-package" })).toThrow("desktop_development_resource_root_invalid");
  });

  it("resolves the one stable lock and durable-data namespace without host imports", () => {
    const paths = resolveCanonicalStableConsolePaths({
      tmpDir: "/tmp",
      uid: 42,
      fleetDataDir: "/home/operator/.fleet",
    });

    expect(paths).toEqual({
      dir: "/tmp/fleet-console-42-stable",
      lockFile: "/tmp/fleet-console-42-stable/console.lock",
      dataDir: "/home/operator/.fleet/console",
      stateFile: "/home/operator/.fleet/console/state.json",
      settingsFile: "/home/operator/.fleet/console/settings.json",
      capturesDir: "/home/operator/.fleet/console/captures",
    });
    expect(resolveCanonicalStableConsolePaths({
      tmpDir: "/tmp",
      uid: 42,
      fleetDataDir: "/ignored",
      consoleDirOverride: "/isolated/console",
    }).dataDir).toBe("/isolated/console");
  });
});
