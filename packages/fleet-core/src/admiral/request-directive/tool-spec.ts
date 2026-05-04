import type { AgentToolSpec } from "../../infra/tool-registry/index.js";
import { registerToolPromptManifest } from "../../infra/tool-registry/index.js";

import { REQUEST_DIRECTIVE_MANIFEST, RequestDirectiveParams } from "./prompts.js";
import type { DirectiveQuestion } from "./types.js";
import { clampHeader, validateQuestions } from "./request-directive-execute.js";

export function buildRequestDirectiveToolSpec(): AgentToolSpec {
  registerToolPromptManifest(REQUEST_DIRECTIVE_MANIFEST);

  return {
    name: "request_directive",
    label: "Request Directive",
    description: REQUEST_DIRECTIVE_MANIFEST.description,
    promptSnippet: REQUEST_DIRECTIVE_MANIFEST.promptSnippet,
    promptGuidelines: [
      ...REQUEST_DIRECTIVE_MANIFEST.whenToUse,
      ...REQUEST_DIRECTIVE_MANIFEST.whenNotToUse.map((line) => `NOT: ${line}`),
      ...REQUEST_DIRECTIVE_MANIFEST.usageGuidelines,
      ...(REQUEST_DIRECTIVE_MANIFEST.guardrails ?? []),
    ],

    parameters: RequestDirectiveParams,

    async execute(args: unknown) {
      const params = args as { questions?: DirectiveQuestion[] };
      const questions = params.questions;
      if (!questions || questions.length === 0) {
        return {
          content: [{ type: "text", text: "Error: request_directive requires host tool execution through the MCP/PI toolcall cycle. Invoked directly without questions." }],
          isError: true,
        };
      }

      const clamped = questions.map((q) => ({
        ...q,
        header: clampHeader(q.header),
        multiSelect: q.multiSelect === true,
      }));
      const validationError = validateQuestions(clamped);
      if (validationError) {
        return {
          content: [{ type: "text", text: validationError }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: "request_directive requires host tool execution through the MCP/PI toolcall cycle. This fleet-core fallback does not provide UI interaction.",
        }],
        isError: true,
      };
    },
  };
}
