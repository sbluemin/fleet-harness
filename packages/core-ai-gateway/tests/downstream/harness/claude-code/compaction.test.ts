import { describe, expect, it } from "vitest";

import {
  CLAUDE_COMPACT_CONTINUATION_MARKER,
  CLAUDE_COMPACT_PROMPT_MARKER,
  hasClaudeCompactContinuation,
  isClaudeCompactSummaryRequest,
  stripClaudeCompactContinuation,
  stripClaudeCompactPrompt,
} from "../../../../src/index.js";

describe("Claude Code compact request shapes", () => {
  it("classifies and strips only the private compact prompt block", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "keep this" }] },
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "boundary" },
          { type: "text", text: `${CLAUDE_COMPACT_PROMPT_MARKER}\nSummarize the conversation.` },
        ],
      },
    ];
    expect(isClaudeCompactSummaryRequest(messages)).toBe(true);
    expect(stripClaudeCompactPrompt(messages)).toEqual([
      messages[0],
      messages[1],
      { role: "user", content: [{ type: "text", text: "boundary" }] },
    ]);
  });

  it("classifies and removes Claude's replacement summary message", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: `${CLAUDE_COMPACT_CONTINUATION_MARKER}\n\nsummary` }],
      },
      { role: "assistant", content: [{ type: "text", text: "after compact" }] },
      { role: "user", content: "continue" },
    ];
    expect(hasClaudeCompactContinuation(messages)).toBe(true);
    expect(stripClaudeCompactContinuation(messages)).toEqual(messages.slice(1));
  });

  it("does not classify near-match user prose", () => {
    const messages = [{ role: "user", content: "Please compact this conversation manually." }];
    expect(isClaudeCompactSummaryRequest(messages)).toBe(false);
    expect(hasClaudeCompactContinuation(messages)).toBe(false);
    expect(stripClaudeCompactPrompt(messages)).toEqual(messages);
  });
});
