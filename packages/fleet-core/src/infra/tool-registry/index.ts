import * as mcp from "../../admiral/_shared/mcp.js";
import { deriveToolDescription, deriveToolPromptGuidelines, deriveToolPromptSnippet } from "./derive.js";
import * as derive from "./derive.js";
import * as formatter from "./formatter.js";
import * as registry from "./registry.js";
import { getAllToolPromptManifests, registerToolPromptManifest } from "./registry.js";
import { renderToolPromptManifestTagBlock } from "./formatter.js";
import * as snapshot from "./tool-snapshot.js";
import * as types from "./types.js";

export type {
  AgentToolCtx,
  AgentToolMcpDescriptor,
  AgentToolPiDescriptor,
  AgentToolRenderDescriptor,
  AgentToolSpec,
  CompletionPushPayload,
  FleetLogLevel,
  ToolPromptManifest,
  TypeBoxSchema,
} from "./types.js";
export type { Tool, RegisteredTool } from "./tool-snapshot.js";
export { registerToolPromptManifest, getAllToolPromptManifests } from "./registry.js";
export { renderToolPromptManifestTagBlock } from "./formatter.js";
export { deriveToolDescription, deriveToolPromptSnippet, deriveToolPromptGuidelines } from "./derive.js";
export {
  convertToolSchema,
  registerToolsForSession,
  getToolsForSession,
  getToolNamesForSession,
  removeToolsForSession,
  clearAllTools,
  computeToolHash,
} from "./tool-snapshot.js";

export const toolRegistry = {
  registry,
  formatter,
  derive,
  snapshot,
  types,
  mcp,
  deriveToolDescription,
  deriveToolPromptGuidelines,
  deriveToolPromptSnippet,
  getAllToolPromptManifests,
  registerToolPromptManifest,
  renderToolPromptManifestTagBlock,
};
