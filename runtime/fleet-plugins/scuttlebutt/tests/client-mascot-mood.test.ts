import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { mascotMood } from "../client/mascot-mood.js";

const mascot = readFileSync(new URL("../client/mascot.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../client/chat-card.tsx", import.meta.url), "utf8");

describe("Admiral Sam mood", () => {
  it("thinks while a turn is in flight", () => {
    expect(mascotMood("starting", false)).toBe("thinking");
    expect(mascotMood("thinking", false)).toBe("thinking");
  });

  it("returns to idle once the cheer is over, whatever the chat ended as", () => {
    expect(mascotMood("ready", true)).toBe("cheering");
    expect(mascotMood("ready", false)).toBe("idle");
    expect(mascotMood("error", false)).toBe("idle");
    expect(mascotMood("idle", false)).toBe("idle");
  });

  it("lets the cheer outrank every phase, including an in-flight one", () => {
    expect(mascotMood("thinking", true)).toBe("cheering");
    expect(mascotMood("idle", true)).toBe("cheering");
  });
});

describe("Admiral Sam mood wiring", () => {
  it("times the cheer to the stylesheet and hands the class straight to the figure", () => {
    expect(mascot).toContain("const CHEER_DURATION_MS = 1_250;");
    expect(mascot).toContain("`is-${mood}`");
    expect(mascot).toContain('mood === "thinking"');
    expect(mascot).not.toContain('phase === "ready" ? "is-');
  });

  it("keeps the chat session outside the card so closing it cannot cut the stream", () => {
    expect(mascot).toContain("createChatSession");
    expect(mascot).toContain("useStoreSnapshot(session.subscribe, session.snapshot)");
    expect(card).not.toContain("connectChatStream");
    expect(card).not.toContain("createChatSession");
    expect(card).not.toMatch(/streamRef|chat\/start/);
  });
});
