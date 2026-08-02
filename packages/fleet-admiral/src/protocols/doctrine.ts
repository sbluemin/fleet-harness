/**
 * protocols/doctrine — Admiral prompt doctrine axis
 *
 * Orthogonal to metaphor: classic keeps carrier_dispatch-centric wording; gateway
 * names no executor at all and describes execution as workflow stages, leaving the
 * surface those stages run on to the `workflow` skill and the live tool metadata.
 */

export type AdmiralDoctrine = "classic" | "gateway";

/** Resolve prompt doctrine from the active Agent CLI id. */
export function resolveDoctrineFromCliId(cliId: string): AdmiralDoctrine {
  return cliId === "claude-gateway" ? "gateway" : "classic";
}
