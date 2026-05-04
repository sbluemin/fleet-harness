import type { AgentToolSpec } from "../agent/types.js";

import { REQUEST_DIRECTIVE_DOCTRINE, RequestDirectiveParams } from "./prompts.js";
import type { DirectiveQuestion } from "./types.js";
import { clampHeader, validateQuestions } from "./request-directive-execute.js";

export function buildRequestDirectiveToolSpec(): AgentToolSpec {
  return {
    ...REQUEST_DIRECTIVE_DOCTRINE,
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
