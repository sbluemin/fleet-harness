import type { AdmiralDoctrine } from "./protocols/doctrine.js";

export const FLEET_MCP_SERVER_NAME = "fleet";

/** Gateway host sessions receive every registered Fleet tool. */
export function isHostSessionToolAllowed(_toolId: string, _doctrine: AdmiralDoctrine): boolean {
  return true;
}
