import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DESKTOP_DEVELOPMENT_ENV, DESKTOP_OWNER_ID_ENV, DESKTOP_OWNER_KIND_ENV, DESKTOP_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION_ENV, DESKTOP_RESOURCE_ROOT_ENV } from "../core/host/desktop-protocol.js";
import { readFleetConsoleRelease } from "../core/host/release.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Console release classification", () => {
  it("keeps valid v1 Desktop provenance out of Console feature channel classification", () => {
    const env = {
      [DESKTOP_DEVELOPMENT_ENV]: "1",
      [DESKTOP_RESOURCE_ROOT_ENV]: PACKAGE_ROOT,
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_OWNER_ID_ENV]: "desktop-owner-1",
      [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION),
    } as NodeJS.ProcessEnv;
    const release = readFleetConsoleRelease(env);
    expect(release).toMatchObject({ channel: "local", packageRoot: PACKAGE_ROOT });
    expect(release.channel).not.toBe("desktop");
  });
});
