import { describe, expect, it } from "vitest";

import {
  CLAUDE_SKILL_BODY_BUDGET_FRACTION,
  pruneClaudeSkillPayloads,
} from "../../src/anthropic/claude-context.js";

const CONTEXT_WINDOW = 272_000;
const BUDGET_TOKENS = CONTEXT_WINDOW * CLAUDE_SKILL_BODY_BUDGET_FRACTION;

/** Claude Code's own skill-body preamble, followed by enough text to blow the budget. */
function skillBody(name: string, chars: number): string {
  const head = `Base directory for this skill: /tmp/bundled-skills/2.1.222/abc123/${name}\n\n`;
  return head + "x".repeat(Math.max(0, chars - head.length));
}

const LISTING = [
  "The following skills are available for use with the Skill tool:",
  "",
  "- agent-browser: Browser automation CLI for AI agents.",
  "- claude-api: Reference for the Claude API / Anthropic SDK.",
  "TRIGGER — read BEFORE opening the target file; don't skip because it looks like a one-liner.",
  "SKIP only when another provider is being worked on.",
  "- fleet:workflow: Run a staged multi-agent operation.",
  "- dataviz: Use this skill whenever you are about to create ANY chart.",
].join("\n");

function userText(text: string): { role: "user"; content: { type: "text"; text: string }[] } {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("pruneClaudeSkillPayloads", () => {
  it("withholds a skill body over the model's per-skill budget", () => {
    // 4 chars/token against a 272_000 window puts this well past the 27_200 ceiling.
    const messages = [userText(skillBody("claude-api", 400_000))];

    const result = pruneClaudeSkillPayloads(messages, { contextWindow: CONTEXT_WINDOW });

    expect(result.changed).toBe(true);
    expect(result.withheld).toEqual([{ name: "claude-api", tokens: 100_000 }]);
    const [block] = result.messages[0]!.content;
    expect(block!.text).toMatch(/^\[Fleet AI gateway withheld the "claude-api" skill/);
    expect(block!.text).toContain(`${BUDGET_TOKENS}-token ceiling`);
    expect(block!.text).not.toContain("xxxx");
  });

  it("leaves a skill body inside the budget byte-for-byte intact", () => {
    const body = skillBody("git-worktree", 20_000);
    const messages = [userText(body)];

    const result = pruneClaudeSkillPayloads(messages, { contextWindow: CONTEXT_WINDOW });

    expect(result.changed).toBe(false);
    expect(result.withheld).toEqual([]);
    expect(result.messages[0]!.content[0]!.text).toBe(body);
  });

  it("leaves every body alone when the model declares no window", () => {
    const body = skillBody("claude-api", 400_000);

    const result = pruneClaudeSkillPayloads([userText(body)], {});

    expect(result.changed).toBe(false);
    expect(result.messages[0]!.content[0]!.text).toBe(body);
  });

  it("drops the withheld skill's listing entry and its continuation lines", () => {
    const messages = [
      userText(LISTING),
      userText(skillBody("claude-api", 400_000)),
    ];

    const result = pruneClaudeSkillPayloads(messages, { contextWindow: CONTEXT_WINDOW });

    expect(result.delisted).toEqual(["claude-api"]);
    const listing = result.messages[0]!.content[0]!.text;
    expect(listing).not.toContain("claude-api");
    expect(listing).not.toContain("TRIGGER —");
    expect(listing).not.toContain("SKIP only when");
    // Neighbouring entries survive, including the one directly after the dropped block.
    expect(listing).toContain("- agent-browser: Browser automation CLI for AI agents.");
    expect(listing).toContain("- fleet:workflow: Run a staged multi-agent operation.");
    expect(listing).toContain("- dataviz: Use this skill whenever");
  });

  it("delists from the first request when the caller already learned the skill", () => {
    const result = pruneClaudeSkillPayloads([userText(LISTING)], {
      contextWindow: CONTEXT_WINDOW,
      withheld: new Set(["claude-api"]),
    });

    expect(result.changed).toBe(true);
    expect(result.withheld).toEqual([]);
    expect(result.messages[0]!.content[0]!.text).not.toContain("claude-api");
  });

  it("matches a namespaced listing name against the skill's directory name", () => {
    const result = pruneClaudeSkillPayloads([userText(LISTING)], {
      contextWindow: CONTEXT_WINDOW,
      withheld: new Set(["workflow"]),
    });

    expect(result.delisted).toEqual(["fleet:workflow"]);
    expect(result.messages[0]!.content[0]!.text).not.toContain("fleet:workflow");
    expect(result.messages[0]!.content[0]!.text).toContain("- claude-api:");
  });

  it("reads and rewrites plain string content as well as block arrays", () => {
    const messages = [{ role: "user" as const, content: skillBody("claude-api", 400_000) }];

    const result = pruneClaudeSkillPayloads(messages, { contextWindow: CONTEXT_WINDOW });

    expect(result.withheld).toEqual([{ name: "claude-api", tokens: 100_000 }]);
    expect(result.messages[0]!.content).toMatch(/^\[Fleet AI gateway withheld/);
  });

  it("returns the original messages untouched when nothing crosses the budget", () => {
    const messages = [userText("just a normal turn"), userText(LISTING)];

    const result = pruneClaudeSkillPayloads(messages, { contextWindow: CONTEXT_WINDOW });

    expect(result.changed).toBe(false);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
  });

  it("keeps the stub stable across turns so the cached prefix survives", () => {
    const body = skillBody("claude-api", 400_000);

    const first = pruneClaudeSkillPayloads([userText(body)], { contextWindow: CONTEXT_WINDOW });
    const second = pruneClaudeSkillPayloads([userText(body)], {
      contextWindow: CONTEXT_WINDOW,
      withheld: new Set(["claude-api"]),
    });

    expect(second.messages[0]!.content[0]!.text).toBe(first.messages[0]!.content[0]!.text);
  });

  it("keeps a payload a 1M model can afford, and refuses it on every smaller window", () => {
    // The skill body measured in the incident: 650,724 characters, 162,681 tokens.
    const body = skillBody("claude-api", 650_724);

    const onOneMillion = pruneClaudeSkillPayloads([userText(body)], { contextWindow: 1_000_000 });
    const onTwoSeventyTwo = pruneClaudeSkillPayloads([userText(body)], { contextWindow: CONTEXT_WINDOW });
    const onFiveHundred = pruneClaudeSkillPayloads([userText(body)], { contextWindow: 500_000 });

    expect(onOneMillion.withheld).toEqual([]);
    expect(onOneMillion.messages[0]!.content[0]!.text).toBe(body);
    expect(onTwoSeventyTwo.withheld).toEqual([{ name: "claude-api", tokens: 162_681 }]);
    // 500_000 is the largest window that still cannot afford it, so the split is not
    // "carries the [1m] marker" — it is the window the payload actually fits inside.
    expect(onFiveHundred.withheld).toEqual([{ name: "claude-api", tokens: 162_681 }]);
  });
});
