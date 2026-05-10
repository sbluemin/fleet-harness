import type { ExtensionAPI } from "@sbluemin/fleet-coding-agent";

import { bootFleet } from "./boot.js";

export default function fleetPiExtension(pi: ExtensionAPI): void {
  bootFleet(pi);
}
