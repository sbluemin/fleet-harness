import { Type } from "typebox";

import type { AgentToolSpec } from "@dotobokuri/core-agent";

/** A session-owned draft supplied by the Cowork host, never resolved from tool input. */
export interface WikiDraftSnapshot {
  readonly body: string;
  readonly revision: number;
}

export interface WikiDraftWriteRequest {
  readonly body: string;
  readonly expectedRevision?: number;
}

/**
 * Host-owned, session-scoped draft storage. Implementations must advance revision
 * monotonically and reject a mismatched expectedRevision without writing.
 */
export interface WikiDraftPort {
  read(): Promise<WikiDraftSnapshot>;
  write(request: WikiDraftWriteRequest): Promise<WikiDraftSnapshot>;
}

export interface CreateWikiDraftToolSpecsDependencies {
  readonly draft: WikiDraftPort;
}

interface DraftEditInput {
  readonly find: string;
  readonly replace: string;
  readonly expectedOccurrences?: number;
  readonly expectedRevision?: number;
}

const DRAFT_TOOL_GUIDELINES = [
  "These tools operate only on the current Cowork session draft supplied by the host.",
  "Do not infer or request a workspace path, entry ID, or session ID.",
] as const;

/**
 * Builds private Cowork draft tools around one explicit session port. These specs
 * are intentionally absent from the Fleet Wiki global agent-tool registry.
 */
export function createWikiDraftToolSpecs(deps: CreateWikiDraftToolSpecsDependencies): AgentToolSpec[] {
  return [
    createReadSpec(deps.draft),
    createEditSpec(deps.draft),
    createWriteSpec(deps.draft),
  ];
}

function createReadSpec(draft: WikiDraftPort): AgentToolSpec {
  return {
    id: "wiki_draft_read",
    tag: "wiki_draft_read",
    title: "Read Cowork Draft",
    description: "Read the current session-bound Cowork draft.",
    promptSnippet: "Read the current draft before proposing an exact edit.",
    whenToUse: ["Need the current body and revision of this Cowork draft"],
    whenNotToUse: ["Need to read a persisted Fleet Wiki entry rather than this session draft"],
    usageGuidelines: DRAFT_TOOL_GUIDELINES,
    parameters: Type.Object({}),
    async execute(args: unknown) {
      assertEmptyObject(args, "wiki_draft_read");
      return success(await draft.read());
    },
  };
}

function createEditSpec(draft: WikiDraftPort): AgentToolSpec {
  return {
    id: "wiki_draft_edit",
    tag: "wiki_draft_edit",
    title: "Edit Cowork Draft",
    description: "Replace exact text in the current session-bound Cowork draft.",
    promptSnippet: "Use exact find/replace text and a revision when coordinating edits.",
    whenToUse: ["Need a precise replacement in the current Cowork draft"],
    whenNotToUse: ["Need to replace the entire draft body — use wiki_draft_write"],
    usageGuidelines: DRAFT_TOOL_GUIDELINES,
    parameters: Type.Object({
      find: Type.String({ description: "Exact draft text to replace" }),
      replace: Type.String({ description: "Replacement text" }),
      expected_occurrences: Type.Optional(Type.Number({ minimum: 1, description: "Required exact match count when supplied" })),
      expected_revision: Type.Optional(Type.Number({ minimum: 0, description: "Draft revision that must still be current" })),
    }),
    async execute(args: unknown) {
      const input = parseEditInput(args);
      const current = await draft.read();
      assertExpectedRevision(input.expectedRevision, current.revision);
      const occurrences = countOccurrences(current.body, input.find);
      const expectedOccurrences = input.expectedOccurrences ?? 1;
      if (occurrences !== expectedOccurrences) {
        throw new Error(`[fleet-wiki] wiki_draft_edit occurrence mismatch: expected ${expectedOccurrences}, found ${occurrences}`);
      }
      const body = current.body.split(input.find).join(input.replace);
      return success(await draft.write({ body, expectedRevision: current.revision }));
    },
  };
}

function createWriteSpec(draft: WikiDraftPort): AgentToolSpec {
  return {
    id: "wiki_draft_write",
    tag: "wiki_draft_write",
    title: "Write Cowork Draft",
    description: "Replace the entire current session-bound Cowork draft.",
    promptSnippet: "Replace the whole draft only when a complete new body is intended.",
    whenToUse: ["Need to replace the complete Cowork draft body"],
    whenNotToUse: ["Need a localized replacement — use wiki_draft_edit"],
    usageGuidelines: DRAFT_TOOL_GUIDELINES,
    parameters: Type.Object({
      body: Type.String({ description: "Complete replacement draft body" }),
      expected_revision: Type.Optional(Type.Number({ minimum: 0, description: "Draft revision that must still be current" })),
    }),
    async execute(args: unknown) {
      const input = parseWriteInput(args);
      return success(await draft.write({ body: input.body, expectedRevision: input.expectedRevision }));
    },
  };
}

function parseEditInput(args: unknown): DraftEditInput {
  const params = assertRecord(args, "wiki_draft_edit");
  assertOnlyKeys(params, ["find", "replace", "expected_occurrences", "expected_revision"], "wiki_draft_edit");
  if (typeof params.find !== "string" || params.find.length === 0) throw new Error("[fleet-wiki] wiki_draft_edit find must be a non-empty string");
  if (typeof params.replace !== "string") throw new Error("[fleet-wiki] wiki_draft_edit replace must be a string");
  return {
    find: params.find,
    replace: params.replace,
    expectedOccurrences: optionalPositiveInteger(params.expected_occurrences, "expected_occurrences", "wiki_draft_edit"),
    expectedRevision: optionalRevision(params.expected_revision, "wiki_draft_edit"),
  };
}

function parseWriteInput(args: unknown): { body: string; expectedRevision?: number } {
  const params = assertRecord(args, "wiki_draft_write");
  assertOnlyKeys(params, ["body", "expected_revision"], "wiki_draft_write");
  if (typeof params.body !== "string") throw new Error("[fleet-wiki] wiki_draft_write body must be a string");
  return { body: params.body, expectedRevision: optionalRevision(params.expected_revision, "wiki_draft_write") };
}

function assertExpectedRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`[fleet-wiki] wiki draft revision conflict: expected ${expected}, current ${actual}`);
  }
}

function countOccurrences(body: string, find: string): number {
  return body.split(find).length - 1;
}

function optionalPositiveInteger(value: unknown, name: string, tool: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`[fleet-wiki] ${tool} ${name} must be a positive integer`);
  return value as number;
}

function optionalRevision(value: unknown, tool: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`[fleet-wiki] ${tool} expected_revision must be a non-negative integer`);
  return value as number;
}

function assertEmptyObject(args: unknown, tool: string): void {
  const params = assertRecord(args, tool);
  assertOnlyKeys(params, [], tool);
}

function assertRecord(args: unknown, tool: string): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error(`[fleet-wiki] ${tool} arguments must be an object`);
  return args as Record<string, unknown>;
}

function assertOnlyKeys(params: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  const unexpected = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`[fleet-wiki] ${tool} does not accept ${unexpected.join(", ")}`);
}

function success(snapshot: WikiDraftSnapshot) {
  return {
    isError: false,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...snapshot }) }],
  };
}
