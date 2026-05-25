import { createRequire } from "node:module";

export type FleetCliChannel = "stable" | "canary" | "local";

export interface FleetCliRelease {
  readonly channel: FleetCliChannel;
  readonly version: string;
}

export function readFleetCliRelease(): FleetCliRelease {
  const requireFromHere = createRequire(import.meta.url);
  const pkg = requireFromHere("../package.json") as { private?: boolean; version?: string };
  const version = pkg.version ?? "";
  if (pkg.private === true) {
    return { channel: "local", version };
  }
  return { channel: version.includes("-") ? "canary" : "stable", version };
}
