import path from "node:path";

import { DESKTOP_RESOURCE_ROOT_MARKER as PROTOCOL_MARKER, formatDesktopResourceRootMarker } from "@fleet-console/protocol/desktop";
import { describe, expect, it } from "vitest";

import {
  APP_IDENTITY_RELATIVE_PATH,
  ARCHIVE_NAME,
  BUNDLE_ID,
  DESKTOP_RESOURCE_ROOT_MARKER,
  DESKTOP_RESOURCE_ROOT_MARKER_CONTENT,
  CONSOLE_CLI_RELATIVE_PATH,
  CONSOLE_IDENTITY_RELATIVE_PATH,
  DEV_BUNDLE_ID,
  EXECUTABLE_RELATIVE_PATH,
  PLIST_IDENTITY_KEY,
  RELEASE_CHECK_ENV,
  RELEASE_CHECK_VALUE,
  RUNTIME_LATEST_RELATIVE_TO_HOME,
  assertPackagedAppPath,
  assertReleaseBundleIdentifier,
  identityDocument,
  remoteMacManifest,
  stampInfoPlist,
} from "../scripts/prepare-remote-mac-package.mjs";

const REVISION = "c97895d456bf4ba44f70272fb7598d9c2680fa29";
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key>
<string>${BUNDLE_ID}</string>
</dict></plist>
`;

describe("remote mac package contract", () => {
  it("stamps the release bundle with the source revision and refuses the development bundle", () => {
    const stamped = stampInfoPlist(PLIST, REVISION);
    expect(stamped).toContain(`<key>${PLIST_IDENTITY_KEY}</key>`);
    expect(stamped).toContain(`<string>${REVISION}</string>`);
    expect(stampInfoPlist(stamped, REVISION).match(new RegExp(PLIST_IDENTITY_KEY, "g"))).toHaveLength(1);
    expect(() => stampInfoPlist(PLIST.replace(BUNDLE_ID, DEV_BUNDLE_ID), REVISION)).toThrow(/release Fleet Console/);
    expect(() => assertReleaseBundleIdentifier(DEV_BUNDLE_ID)).toThrow(/refuses bundle id/);
    expect(identityDocument(REVISION)).toEqual({
      schemaVersion: 1,
      kind: "fleet-remote-mac-package",
      sourceRevision: REVISION,
      bundleId: BUNDLE_ID,
      productName: "Fleet Console",
    });
  });

  it("keeps the transferred app inside this worktree release directory", () => {
    const release = "/worktree/runtime/fleet-desktop/release";
    expect(assertPackagedAppPath(`${release}/mac-arm64/Fleet Console.app`, release)).toBe(`${release}/mac-arm64/Fleet Console.app`);
    expect(() => assertPackagedAppPath("/worktree/runtime/fleet-desktop/.stage/dev-app/Fleet Console Dev.app", release)).toThrow(/outside|development/);
    expect(() => assertPackagedAppPath(`${release}/mac-arm64/Fleet Console Dev.app`, release)).toThrow(/renamed or development/);
  });

  it("publishes one zip plus the running app and console identity paths", () => {
    const manifest = remoteMacManifest({
      sourceRevision: REVISION,
      sourceDirty: false,
      archivePath: `/worktree/runtime/fleet-desktop/release/remote-mac/${ARCHIVE_NAME}`,
      archiveSha256: "a".repeat(64),
    });
    expect(manifest).toMatchObject({
      format: "zip",
      sourceDirty: false,
      executableRelativePath: EXECUTABLE_RELATIVE_PATH,
      appIdentityRelativePath: APP_IDENTITY_RELATIVE_PATH,
      consoleCliRelativePath: CONSOLE_CLI_RELATIVE_PATH,
      consoleIdentityRelativePath: CONSOLE_IDENTITY_RELATIVE_PATH,
      runtimeLatestRelativeToHome: RUNTIME_LATEST_RELATIVE_TO_HOME,
      releaseCheckEnv: { name: RELEASE_CHECK_ENV, value: RELEASE_CHECK_VALUE },
    });
    expect(path.basename(manifest.archivePath)).toBe(ARCHIVE_NAME);
    expect(DESKTOP_RESOURCE_ROOT_MARKER).toBe(PROTOCOL_MARKER);
    expect(DESKTOP_RESOURCE_ROOT_MARKER_CONTENT).toBe(formatDesktopResourceRootMarker());
  });
});
