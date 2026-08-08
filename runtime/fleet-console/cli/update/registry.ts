import { fetchLatestVersion, type UpdateChannel } from "@dotobokuri/core-agent";

export type { UpdateChannel };

const FLEET_CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";

export async function fetchLatestFleetCliVersion(channel: UpdateChannel): Promise<string | undefined> {
  return await fetchLatestVersion(FLEET_CONSOLE_PACKAGE_NAME, channel);
}
