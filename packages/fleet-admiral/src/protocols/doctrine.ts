/**
 * protocols/doctrine — Admiral prompt / plugin / MCP doctrine axis
 *
 * gateway names no executor at all and describes execution as workflow stages, leaving
 * the surface those stages run on to the `workflow` skill and the live tool metadata.
 * native is console-launch only: no Admiral system prompt, wiki skills + console hooks
 * only, and wiki MCP.
 */

export type AdmiralDoctrine = "gateway" | "native";

/** Resolve prompt doctrine from the active Agent CLI id. */
export function resolveDoctrineFromCliId(cliId: string): AdmiralDoctrine {
  return cliId === "claude-native" ? "native" : "gateway";
}
