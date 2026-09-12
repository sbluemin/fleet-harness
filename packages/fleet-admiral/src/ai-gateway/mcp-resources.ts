import type { McpResource } from "@dotobokuri/core-agent";
import { EMBEDDED_AI_GATEWAY_ASSETS } from "../agent-cli/assets.generated.js";

export const FLEET_AI_GATEWAY_INSTRUCTIONS = "Resources: fleet://ai-gateway/routing indexes the routing guides; fleet://ai-gateway/models returns the current session roster and execution availability. Use the exact guide URIs from the index or resources/list; verification uses the review guide. Fleet supplies session credentials; no separate OAuth login is required. Report authorization errors without exposing or copying tokens.";

export function buildGatewayPolicyResources(): readonly McpResource[] {
  return EMBEDDED_AI_GATEWAY_ASSETS.map((asset) => {
    const name = asset.relativePath.replace(/\.md$/, "");
    return {
      uri: name === "routing" ? "fleet://ai-gateway/routing" : `fleet://ai-gateway/guides/${name}`,
      name,
      description: name === "routing" ? "Read before delegation: minimal execution graph, host ownership, acceptance, and safety." : `On-demand gateway ${name} guidance.`,
      mimeType: "text/markdown",
      read: () => asset.content,
    };
  });
}
