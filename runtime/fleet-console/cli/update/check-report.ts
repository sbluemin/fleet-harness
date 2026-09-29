import { hasDesktopGithubReleaseConsoleSource } from "@fleet-console/protocol/desktop";

import { readFleetCliRelease } from "../release.js";
import { checkUpdateStatus, describeReleaseLookupFailure, type UpdateCheckResult } from "./check.js";
import type { UpdateCommandIo } from "./dispatcher.js";
import { isDesktopManagedInstall } from "./installer.js";

export async function runFleetUpdateCheck(io: UpdateCommandIo): Promise<number> {
  const release = readFleetCliRelease();
  if (release.channel === "local") {
    io.stdout.write(`Fleet is running from a local development build (v${release.version}) — nothing to update here.\n`);
    return 0;
  }
  const result = await checkUpdateStatus(release, { forceRefresh: true }).catch((): UpdateCheckResult => ({ status: "unavailable" }));
  if (result.status === "current") {
    io.stdout.write(`Fleet is already on the latest version (v${release.version}).\n`);
    return 0;
  }
  if (result.status === "update") {
    // fleet update defers to Fleet Desktop for its own install tree, so the hint must not promise otherwise.
    const next = !isDesktopManagedInstall()
      ? "Run fleet update to install it."
      : hasDesktopGithubReleaseConsoleSource(process.env)
        ? "Apply it from the Console update menu, or restart Fleet Desktop."
        : "Update Fleet Desktop first; it brings the new Console with it.";
    io.stdout.write(`A newer Fleet version is available: v${result.latest} (installed v${release.version}).\n${next}\n`);
    return 0;
  }
  io.stdout.write(`${describeReleaseLookupFailure(result.reason)} Could not check for updates.\n`);
  return 1;
}
