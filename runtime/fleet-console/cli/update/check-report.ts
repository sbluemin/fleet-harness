import { readFleetCliRelease } from "../release.js";
import { checkUpdateStatus } from "./check.js";
import type { UpdateCommandIo } from "./types.js";

export async function runFleetUpdateCheck(io: UpdateCommandIo): Promise<number> {
  const release = readFleetCliRelease();
  if (release.channel === "local") {
    io.stdout.write(`Fleet is running from a local development build (v${release.version}) — nothing to update here.\n`);
    return 0;
  }
  const result = await checkUpdateStatus(release, { forceRefresh: true }).catch(() => ({ status: "unavailable" as const }));
  if (result.status === "current") {
    io.stdout.write(`Fleet is already on the latest version (v${release.version}).\n`);
    return 0;
  }
  if (result.status === "update") {
    io.stdout.write(`A newer Fleet version is available: v${result.latest} (installed v${release.version}).\nRun fleet update to install it.\n`);
    return 0;
  }
  io.stdout.write("Could not reach the npm registry to check for updates.\n");
  return 1;
}
