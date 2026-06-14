import { fetchLatestVersion, type UpdateChannel } from "@dotobokuri/core-agent";

export type { UpdateChannel };

const FLEET_CLI_PACKAGE_NAME = "@dotobokuri/fleet-cli";

export async function fetchLatestFleetCliVersion(channel: UpdateChannel): Promise<string | undefined> {
  return await fetchLatestVersion(FLEET_CLI_PACKAGE_NAME, channel);
}
