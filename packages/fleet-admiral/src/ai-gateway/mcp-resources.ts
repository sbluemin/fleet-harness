import type { McpResource } from "@dotobokuri/core-agent";
import { EMBEDDED_AI_GATEWAY_ASSETS } from "../agent-cli/assets.generated.js";

export const FLEET_AI_GATEWAY_INSTRUCTIONS = "Fleet AI Gateway helps you route useful independent research, review, and verification to models across providers. Before delegating, read fleet://ai-gateway/routing and follow its exact guide URIs (or list resources; never invent a guide URI); verification is covered by the review guide; immediately before dispatch, read fleet://ai-gateway/models for the live session roster. Choose an explicit eligible model rather than inheriting the host model by accident. Do not create branches merely to use more providers. Execute through the host's existing Agent/Workflow surfaces, respecting their permissions and opt-in requirements; final decisions and integration remain on the host. No Fleet skill is required. Fleet supplies this internal server's session credentials; no separate MCP OAuth login is required. Some hosts label resource-only servers 'not authenticated' despite a working session. Successful resource reads confirm access; an actual authorization error must be reported, not ignored or bypassed. Never request, display, or copy session tokens to resolve a status label.";

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
