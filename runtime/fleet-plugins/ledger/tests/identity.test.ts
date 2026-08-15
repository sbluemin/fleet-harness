import { describe, expect, it } from "vitest";

import {
  humanizeBareModel,
  markKeyFromIdentity,
  normalizeModelKey,
  parseModelIdentity,
  readLaunchProvider,
} from "../server/identity.js";

describe("parseModelIdentity", () => {
  it("reads a Gateway supplier and humanizes the bare model", () => {
    expect(parseModelIdentity("claude-gateway--cursor--grok-4.6-fast")).toEqual({
      modelId: "claude-gateway--cursor--grok-4.6-fast",
      supplier: "cursor",
      bare: "grok-4.6-fast",
      label: "Grok 4.6 Fast",
    });
  });

  it("names an unprefixed Claude id as Claude", () => {
    expect(parseModelIdentity("claude-opus-5")).toMatchObject({
      supplier: "claude",
      bare: "claude-opus-5",
      label: "Claude Opus 5",
    });
  });

  it("names unprefixed report ids by supplier instead of collapsing them onto Claude", () => {
    expect(parseModelIdentity("gpt-5")).toMatchObject({
      supplier: "codex",
      bare: "gpt-5",
      label: "GPT 5",
    });
    expect(parseModelIdentity("opencode/big-pickle")).toMatchObject({
      supplier: "opencode",
      bare: "big-pickle",
      label: "Big Pickle",
    });
    expect(parseModelIdentity("mystery-model")).toMatchObject({
      supplier: "native",
      bare: "mystery-model",
      label: "Mystery Model",
    });
  });

  it("collapses models-command GPT hyphenation in the label", () => {
    expect(parseModelIdentity("claude-gateway--codex--gpt-5-6-sol-fast").label).toBe("GPT 5.6 Sol Fast");
  });
});

describe("normalizeModelKey", () => {
  it("joins a report id and a models-command id to the same key", () => {
    expect(normalizeModelKey("claude-gateway--codex--gpt-5.6-sol-fast"))
      .toBe(normalizeModelKey("claude-gateway--codex--gpt-5-6-sol-fast"));
  });

  it("joins hyphenated and dotted 1M ids without merging the standard-window twin", () => {
    expect(normalizeModelKey("claude-gateway--opencode--gpt-5-6-luna[1m]"))
      .toBe(normalizeModelKey("claude-gateway--opencode--gpt-5.6-luna[1m]"));
    expect(normalizeModelKey("claude-gateway--opencode--gpt-5.6-luna[1m]"))
      .not.toBe(normalizeModelKey("claude-gateway--opencode--gpt-5.6-luna"));
  });
});

describe("readLaunchProvider", () => {
  it("accepts the chrome allowlist and rejects unknown values", () => {
    expect(readLaunchProvider({ launchProvider: "xai" })).toBe("xai");
    expect(readLaunchProvider({ launchProvider: "claude-gateway" })).toBeNull();
    expect(readLaunchProvider({})).toBeNull();
  });
});

describe("markKeyFromIdentity", () => {
  it("prefers launchProvider and folds claude-gateway onto claude", () => {
    expect(markKeyFromIdentity("cursor", "claude-gateway")).toBe("cursor");
    expect(markKeyFromIdentity(null, "claude-gateway")).toBe("claude");
    expect(markKeyFromIdentity(null, "codex")).toBe("codex");
    expect(markKeyFromIdentity(null, "native")).toBe("native");
  });
});

describe("humanizeBareModel", () => {
  it("keeps a 1M marker as a suffix", () => {
    expect(humanizeBareModel("claude-fable-5[1m]")).toBe("Claude Fable 5 (1M)");
  });

  it("does not repeat the 1M window when the catalog alias already carries -1m", () => {
    expect(humanizeBareModel("claude-opus-5-1m[1m]")).toBe("Claude Opus 5 (1M)");
    expect(parseModelIdentity("claude-gateway--cursor--claude-opus-5-1m[1m]").label).toBe("Claude Opus 5 (1M)");
    expect(humanizeBareModel("claude-opus-5-1m")).toBe("Claude Opus 5 (1M)");
  });
});
