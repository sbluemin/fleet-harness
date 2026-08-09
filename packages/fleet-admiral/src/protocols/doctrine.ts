/**
 * protocols/doctrine — Admiral prompt / plugin / MCP doctrine axis
 *
 * gateway names no executor at all and describes execution as workflow stages, leaving
 * the surface those stages run on to the `workflow` skill and the live tool metadata.
 */

export type AdmiralDoctrine = "gateway";

/** Resolve prompt doctrine from the active Agent CLI id. */
export function resolveDoctrineFromCliId(_cliId: string): AdmiralDoctrine {
  return "gateway";
}
