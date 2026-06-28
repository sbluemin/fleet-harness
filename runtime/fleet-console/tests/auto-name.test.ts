import { describe, expect, it } from "vitest";

import { deriveOperationLabel } from "../../fleet-plugins/terminal/server/agent-api/auto-name.js";

describe("deriveOperationLabel", () => {
  it("uses the first meaningful line of the prompt", () => {
    expect(deriveOperationLabel("Fix the login redirect bug\nmore context below")).toBe("Fix the login redirect bug");
  });

  it("strips heading, list, and blockquote markers", () => {
    expect(deriveOperationLabel("# Add dark mode toggle")).toBe("Add dark mode toggle");
    expect(deriveOperationLabel("- Implement the search index")).toBe("Implement the search index");
    expect(deriveOperationLabel("> Investigate the flaky test")).toBe("Investigate the flaky test");
  });

  it("strips surrounding markdown emphasis wrappers", () => {
    expect(deriveOperationLabel("**Refactor the parser module**")).toBe("Refactor the parser module");
  });

  it("skips slash commands and falls through to the next meaningful line", () => {
    expect(deriveOperationLabel("/clear\nRefactor the parser module")).toBe("Refactor the parser module");
  });

  it("skips code fences and reads the first prose line after them", () => {
    expect(deriveOperationLabel("```ts\nconst x = 1;\n```\nDescribe the public API")).toBe("Describe the public API");
  });

  it("skips URLs and absolute paths as low-signal, security-sensitive lines", () => {
    expect(deriveOperationLabel("https://example.com/very/long\nReview the PR feedback")).toBe("Review the PR feedback");
    expect(deriveOperationLabel("/Users/secret/project/file.ts\nUpdate the config loader")).toBe("Update the config loader");
  });

  it("skips token-like secret strings with no whitespace", () => {
    expect(deriveOperationLabel("ghp_0123456789abcdef0123456789abcdef0123")).toBeNull();
  });

  it("rejects sensitive values appearing mid-sentence, not only at the line start", () => {
    expect(deriveOperationLabel("Review /Users/me/.ssh/id_rsa usage")).toBeNull();
    expect(deriveOperationLabel("Use token ghp_0123456789abcdef0123456789abcdef now")).toBeNull();
    expect(deriveOperationLabel("See https://example.com/secret for the details")).toBeNull();
    expect(deriveOperationLabel("Investigate deadbeef0123456789abcdef0123456789abcdef commit")).toBeNull();
  });

  it("rejects forbidden patterns hidden behind wrappers or control characters", () => {
    expect(deriveOperationLabel("**/clear**")).toBeNull();
    expect(deriveOperationLabel(`${String.fromCharCode(7)}https://example.com/secret`)).toBeNull();
  });

  it("keeps legitimate slashes that are not paths, URLs, or commands", () => {
    expect(deriveOperationLabel("Fix the I/O timeout handler")).toBe("Fix the I/O timeout handler");
    expect(deriveOperationLabel("Support HTTP/2 in the proxy layer")).toBe("Support HTTP/2 in the proxy layer");
  });

  it("returns null for low-signal follow-up prompts", () => {
    expect(deriveOperationLabel("continue")).toBeNull();
    expect(deriveOperationLabel("ok")).toBeNull();
    expect(deriveOperationLabel("계속")).toBeNull();
  });

  it("returns null for too-short, empty, or non-string prompts", () => {
    expect(deriveOperationLabel("hi")).toBeNull();
    expect(deriveOperationLabel("   \n\n  ")).toBeNull();
    expect(deriveOperationLabel("")).toBeNull();
    expect(deriveOperationLabel(undefined)).toBeNull();
    expect(deriveOperationLabel(42)).toBeNull();
  });

  it("clamps long labels to the maximum length", () => {
    const long = "Implement the new authentication flow across the entire console backend layer";
    const label = deriveOperationLabel(long);
    expect(label).not.toBeNull();
    expect(label!.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(label!)).toBe(true);
  });

  it("neutralizes control characters into spaces", () => {
    const withControl = `Fix the${String.fromCharCode(7)}toast timing`;
    expect(deriveOperationLabel(withControl)).toBe("Fix the toast timing");
  });
});
