import { describe, expect, it } from "vitest";

import { stripClaudeUsageLimitDirectives } from "../../src/anthropic/claude-context.js";

/** The three directives measured in Claude Code 2.1.234, verbatim. */
const APPROACHING = "[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work. Don't start subagents or long-running work.]";
const GRACE_WRAP_UP = "[Usage limit reached — grace window active. Wrap up: finish or checkpoint; don't start subagents or long work.]";
const GRACE_CHECKPOINT = "[Usage limit reached — grace window active. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work. Don't start subagents or long-running work.]";

function toolResult(id: string): { role: "user"; content: { type: "tool_result"; tool_use_id: string; content: string }[] } {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] };
}

function userText(text: string): { role: "user"; content: { type: "text"; text: string }[] } {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("stripClaudeUsageLimitDirectives", () => {
  it("drops the injected directive and keeps the turn it interrupted", () => {
    const messages = [
      { role: "user", content: "Fix the composer width." },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      toolResult("t1"),
      userText(APPROACHING),
    ];

    const result = stripClaudeUsageLimitDirectives(messages);

    expect(result.changed).toBe(true);
    expect(result.removed).toBe(1);
    expect(result.messages).toHaveLength(3);
    expect(JSON.stringify(result.messages)).not.toContain("Usage limit");
    // The request still ends on the user turn the directive was pushed behind.
    expect(result.messages[result.messages.length - 1]).toEqual(toolResult("t1"));
  });

  it("drops both grace variants, so a reworded release still matches on shape", () => {
    for (const directive of [GRACE_WRAP_UP, GRACE_CHECKPOINT, "[Usage limit something we have not seen yet.]"]) {
      const result = stripClaudeUsageLimitDirectives([toolResult("t1"), userText(directive)]);
      expect(result.changed, directive).toBe(true);
      expect(result.messages).toHaveLength(1);
    }
  });

  it("drops a directive that arrived as a bare string message", () => {
    const result = stripClaudeUsageLimitDirectives([
      toolResult("t1"),
      { role: "user", content: APPROACHING },
    ]);

    expect(result.changed).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it("removes only the directive block when the message carries other content", () => {
    const result = stripClaudeUsageLimitDirectives([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: APPROACHING },
        ],
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.removed).toBe(1);
    expect(result.messages).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]);
  });

  it("leaves a human's own prose alone when it merely quotes the directive", () => {
    const quoted = `Why did the agent stop? It received ${APPROACHING} mid-task.`;
    const messages = [userText(quoted)];

    const result = stripClaudeUsageLimitDirectives(messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("declines to strip when doing so would end the request on an assistant turn", () => {
    const messages = [
      { role: "user", content: "Go." },
      { role: "assistant", content: [{ type: "text", text: "Working." }] },
      userText(APPROACHING),
    ];

    const result = stripClaudeUsageLimitDirectives(messages);

    expect(result.changed).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("matches a directive padded with whitespace, and leaves a long body untouched", () => {
    const skillBody = `Base directory for this skill: /tmp/skills/dataviz\n\n${"x".repeat(50_000)}`;
    const messages = [
      userText(skillBody),
      { role: "user", content: [{ type: "text", text: `\n  ${APPROACHING}\n` }] },
    ];

    const result = stripClaudeUsageLimitDirectives(messages);

    expect(result.changed).toBe(true);
    expect(result.messages).toEqual([userText(skillBody)]);
  });

  it("returns the same array when nothing matched", () => {
    const messages = [userText("Ship it.")];
    const result = stripClaudeUsageLimitDirectives(messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });
});
