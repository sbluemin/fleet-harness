import type { OperationNode } from "./types.js";

export interface OperationSanitizeOptions {
  readonly sensitiveFields?: readonly string[];
}

const FIXED_SENSITIVE_OPERATION_FIELDS = new Set([
  "canonicalCwd",
  "cwd",
  "persona",
  "prompt",
  "providerSession",
  "ticket",
  "token",
  "toolAllowlist",
  "transcriptPath",
]);

export function createSanitizedOpDto(node: OperationNode, options: OperationSanitizeOptions = {}): OperationNode {
  const sensitiveFields = new Set([...FIXED_SENSITIVE_OPERATION_FIELDS, ...(options.sensitiveFields ?? [])]);
  return {
    ...node,
    payload: sanitizeRecord(node.payload, sensitiveFields),
    state: sanitizeRecord(node.state, sensitiveFields),
  };
}

function sanitizeRecord(value: Record<string, unknown>, sensitiveFields: ReadonlySet<string>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveFields.has(key)) continue;
    output[key] = sanitizeValue(item, sensitiveFields);
  }
  return output;
}

function sanitizeValue(value: unknown, sensitiveFields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, sensitiveFields));
  if (!isRecord(value)) return value;
  return sanitizeRecord(value, sensitiveFields);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
