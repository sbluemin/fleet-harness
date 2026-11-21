export function feedbackToolSpec({ toolset, tools, description }: { readonly toolset: string; readonly tools: readonly string[]; readonly description: string }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(toolset)) throw new Error("invalid_feedback_toolset");
  return {
    name: "report_feedback",
    description,
    inputSchema: {
      type: "object" as const,
      properties: {
        tool: { type: "string" as const, enum: [...new Set([...tools.filter((tool) => tool !== "report_feedback"), "general"])] },
        kind: { type: "string" as const, enum: ["failure", "inefficiency", "confusing", "missing", "other"] },
        summary: { type: "string" as const, minLength: 1, maxLength: 200 },
        details: { type: "string" as const, maxLength: 4000, description: "Expected vs observed, what you tried, what would have helped." },
        errorCode: { type: "string" as const, maxLength: 80 },
      },
      required: ["tool", "kind", "summary"],
      additionalProperties: false,
    },
  };
}
