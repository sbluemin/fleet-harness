/**
 * protocols/doctrine — Admiral prompt doctrine axis
 *
 * Orthogonal to metaphor: classic keeps carrier_dispatch-centric wording;
 * gateway reframes orchestration around the Workflow tool / agent stages.
 */

export type AdmiralDoctrine = "classic" | "gateway";

/** Resolve prompt doctrine from the active Agent CLI id. */
export function resolveDoctrineFromCliId(cliId: string): AdmiralDoctrine {
  return cliId === "claude-gateway" ? "gateway" : "classic";
}
