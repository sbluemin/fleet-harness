export const FLEET_MCP_SERVER_NAME = "fleet";

/** Gateway host sessions receive every registered Fleet tool. */
export function isHostSessionToolAllowed(_toolId: string): boolean {
  return true;
}
