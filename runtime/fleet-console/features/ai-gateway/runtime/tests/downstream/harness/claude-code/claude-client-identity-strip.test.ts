import { describe, expect, it } from "vitest";

import { stripClaudeClientIdentity } from "../../../../src/downstream/harness/claude-code/context.js";

/** The three blocks measured on the wire, one per Claude Code execution mode. */
const BILLING_CLI = "x-anthropic-billing-header: cc_version=2.1.239.707; cc_entrypoint=cli;";
const BILLING_SUBAGENT =
  "x-anthropic-billing-header: cc_version=2.1.239.37d; cc_entrypoint=cli; cc_is_subagent=true;";
const IDENTITY_CLI = "You are Claude Code, Anthropic's official CLI for Claude.";
const IDENTITY_SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

function block(text: string) {
  return { type: "text" as const, text };
}

describe("claude client identity strip", () => {
  it.each([
    ["interactive billing header", BILLING_CLI],
    ["subagent billing header", BILLING_SUBAGENT],
    ["interactive identity opener", IDENTITY_CLI],
    ["agent sdk identity opener", IDENTITY_SDK],
  ])("drops the %s block", (_label, text) => {
    const prompt = block("You are an interactive agent that helps with software tasks.");
    const result = stripClaudeClientIdentity([block(text), prompt]);
    expect(result.changed).toBe(true);
    expect(result.removed).toBe(1);
    expect(result.system).toEqual([prompt]);
  });

  it("drops the header and both openers from one prompt", () => {
    const prompt = block("# Harness\n - Reference code as `file_path:line_number`.");
    const result = stripClaudeClientIdentity([
      block(BILLING_CLI),
      block(IDENTITY_CLI),
      block(IDENTITY_SDK),
      prompt,
    ]);
    expect(result.removed).toBe(3);
    expect(result.system).toEqual([prompt]);
  });

  // The block must be the whole of the metadata, or a real instruction that merely opens
  // the same way would be deleted along with it.
  it.each([
    [
      "an instruction that opens like the identity sentence but continues",
      `${IDENTITY_CLI}\n\nAlways answer in Korean and cite file paths.`,
    ],
    // Same line, not just the next one: the opener alone is also how a caller's own
    // one-line instruction starts, so the sentence has to end where the metadata's does.
    ["a one-line instruction opening with the CLI opener", "You are Claude Code. Always answer in Korean and cite file paths."],
    ["a one-line instruction opening with the SDK opener", "You are a Claude agent. Use absolute paths."],
    ["the identity sentence with instructions appended after it", `${IDENTITY_CLI} Always answer in Korean.`],
    ["an opener continued without naming Anthropic", "You are Claude Code, the best assistant ever"],
    // A single sentence naming Anthropic is still ordinary prose a caller can write, which is
    // why the identity test is a literal set and not a shape.
    [
      "a one-sentence instruction that also names Anthropic",
      "You are Claude Code, Anthropic's coding assistant, and you must always answer in Korean.",
    ],
    ["a near-miss of the CLI sentence", "You are Claude Code, Anthropic's official CLI."],
    ["a near-miss of the SDK sentence", "You are a Claude agent built on the Claude Agent SDK."],
    ["a sentence that only mentions Claude", "Explain how Claude Code handles subagents."],
    ["prose about the billing header", "The x-anthropic-billing-header: line is telemetry."],
    ["a different agent identity", "You are a Gemini agent, built on Google's Agent SDK."],
  ])("keeps %s", (_label, text) => {
    const system = [block(text)];
    expect(stripClaudeClientIdentity(system).changed).toBe(false);
  });
});
