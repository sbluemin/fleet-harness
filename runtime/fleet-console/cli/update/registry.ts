import { fetchConsoleRelease, type ConsoleReleaseLookup } from "@fleet-console/updates";

/** The release `fleet update` follows: latest stable, or the tag FLEET_CONSOLE_RELEASE_TAG names. */
export async function fetchFleetCliRelease(env: NodeJS.ProcessEnv = process.env): Promise<ConsoleReleaseLookup> {
  return await fetchConsoleRelease({ env });
}
