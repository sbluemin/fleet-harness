/**
 * protocols/doctrine — Admiral prompt / plugin / MCP doctrine axis
 *
 * Orthogonal to metaphor: classic keeps carrier_dispatch-centric wording; gateway
 * names no executor at all and describes execution as workflow stages, leaving the
 * surface those stages run on to the `workflow` skill and the live tool metadata.
 * native is console-launch only: no Admiral system prompt, wiki skills + console
 * hooks only, and wiki MCP without carrier operation tools.
 */

export type AdmiralDoctrine = "classic" | "gateway" | "native";

/** Resolve prompt doctrine from the active Agent CLI id. */
export function resolveDoctrineFromCliId(cliId: string): AdmiralDoctrine {
  if (cliId === "claude-gateway") return "gateway";
  if (cliId === "claude-native") return "native";
  return "classic";
}
