import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { bootFleet } from "./boot.js";

export default function fleetPiExtension(pi: ExtensionAPI): void {
  bootFleet(pi);
}
