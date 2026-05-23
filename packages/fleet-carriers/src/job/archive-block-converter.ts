import type { ArchiveBlock } from "./job-types.js";

const MAX_TEXT_CHARS = 24_000;
const MAX_RAW_OUTPUT_CHARS = 12_000;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g },
  { label: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { label: "github_token", pattern: /gh[psour]_[A-Za-z0-9]{36}/g },
  { label: "generic_secret", pattern: /\b[A-Z_]+_(?:KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s]*[^\s-](?=\s|$)/g },
  { label: "pem_private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export function toMessageArchiveBlock(source: string, text: string, label?: string, timestamp = Date.now()): ArchiveBlock {
  return {
    kind: "text",
    timestamp,
    source: sanitizeArchiveText(source, 400),
    label: label ? sanitizeArchiveText(label, 400) : undefined,
    text: sanitizeArchiveText(text, MAX_TEXT_CHARS),
  };
}

export function toThoughtArchiveBlock(source: string, text: string, label?: string, timestamp = Date.now()): ArchiveBlock {
  return {
    kind: "thought",
    timestamp,
    source: sanitizeArchiveText(source, 400),
    label: label ? sanitizeArchiveText(label, 400) : undefined,
    text: sanitizeArchiveText(text, MAX_TEXT_CHARS),
  };
}

export function toToolCallArchiveBlock(
  source: string,
  title: string,
  status: string,
  rawOutput?: unknown,
  toolCallId?: string,
  label?: string,
  timestamp = Date.now(),
): ArchiveBlock {
  return {
    kind: "tool_call",
    timestamp,
    source: sanitizeArchiveText(source, 400),
    label: label ? sanitizeArchiveText(label, 400) : undefined,
    title: sanitizeArchiveText(title, 800),
    status: sanitizeArchiveText(status, 200),
    rawOutput: rawOutput === undefined ? undefined : safeSerialize(rawOutput, MAX_RAW_OUTPUT_CHARS),
    toolCallId: toolCallId ? sanitizeArchiveText(toolCallId, 400) : undefined,
  };
}

export function sanitizeArchiveText(value: string, maxChars = MAX_TEXT_CHARS): string {
  const cleaned = value.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n[truncated ${cleaned.length - maxChars} chars]`;
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, { label, pattern }) => text.replace(pattern, `[REDACTED:${label}]`),
    value,
  );
}

function safeSerialize(value: unknown, maxChars: number): string {
  if (typeof value === "string") return sanitizeArchiveText(value, maxChars);
  try {
    return sanitizeArchiveText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return sanitizeArchiveText(String(value), maxChars);
  }
}
