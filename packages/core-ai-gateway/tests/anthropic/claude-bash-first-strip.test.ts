import { describe, expect, it } from "vitest";

import { stripClaudeBashFirstDirective } from "../../src/anthropic/claude-context.js";

/** The paragraph Claude Code composes, with its tool names already interpolated. */
const DIRECTIVE = "Do your work through the Bash tool wherever it can accomplish the job: read files"
  + " with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs,"
  + " or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a"
  + " dedicated tool only when Bash genuinely cannot do the job.";

const BYPASS_MESSAGE = `- security-review: Complete a security review of the pending changes on the current branch

While bypass permissions mode is active:

${DIRECTIVE}

<total_tokens>15000000 tokens left</total_tokens>`;

describe("stripClaudeBashFirstDirective", () => {
  it("removes the bypass-mode directive from a string-content message", () => {
    const result = stripClaudeBashFirstDirective([
      { role: "system", content: BYPASS_MESSAGE },
    ]);

    expect(result.changed).toBe(true);
    expect(result.messages[0]?.content).toBe(
      "- security-review: Complete a security review of the pending changes on the current branch"
      + "\n\n<total_tokens>15000000 tokens left</total_tokens>",
    );
  });

  it("removes the directive from a text block and leaves its neighbours alone", () => {
    const result = stripClaudeBashFirstDirective([
      {
        role: "system",
        content: [
          { type: "text", text: "keep me" },
          { type: "text", text: BYPASS_MESSAGE },
          { type: "tool_result", content: "untouched" },
        ],
      },
    ]);

    expect(result.changed).toBe(true);
    const blocks = result.messages[0]?.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "keep me" });
    expect(blocks[1]?.text).not.toContain("Do your work through the Bash tool");
    expect(blocks[1]?.text).not.toContain("While bypass permissions mode is active");
    expect(blocks[2]).toEqual({ type: "tool_result", content: "untouched" });
  });

  it("removes the auto-mode and bare variants of the same paragraph", () => {
    const auto = stripClaudeBashFirstDirective([
      { role: "system", content: `While auto mode is active:\n\n${DIRECTIVE}` },
    ]);
    const bare = stripClaudeBashFirstDirective([
      { role: "system", content: DIRECTIVE },
    ]);

    expect(auto.changed).toBe(true);
    expect(auto.messages[0]?.content).toBe("");
    expect(bare.changed).toBe(true);
    expect(bare.messages[0]?.content).toBe("");
  });

  // 문단 표현이 릴리스마다 바뀌므로, 못 알아본 요청은 손대지 않고 통과시켜야 한다.
  it("leaves a request untouched when the paragraph does not match", () => {
    const messages = [
      { role: "user", content: "Use Bash to search this repository for the failing test." },
      {
        role: "system",
        content: "While bypass permissions mode is active:\n\nDo your work however you like.",
      },
    ];

    const result = stripClaudeBashFirstDirective(messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("does not run past a truncated paragraph into the rest of the message", () => {
    const truncated = "While bypass permissions mode is active:\n\nDo your work through the Bash tool"
      + " wherever it can accomplish the job: read files with cat.\n\nKeep this line.";

    const result = stripClaudeBashFirstDirective([{ role: "system", content: truncated }]);

    expect(result.changed).toBe(false);
    expect(result.messages[0]?.content).toBe(truncated);
  });
});
