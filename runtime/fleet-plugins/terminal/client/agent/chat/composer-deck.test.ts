import { describe, expect, it } from "vitest";

import type { AgentChatCatalog } from "./chat-events.js";
import {
  applyDeckPick,
  buildDeckSections,
  flattenDeckRows,
  readAgentToken,
  readDeckToken,
  readSlashToken,
} from "./composer-deck.js";

const CATALOG: AgentChatCatalog = {
  commands: [
    { name: "clear", description: "Clear the conversation", argumentHint: "" },
    { name: "compact", description: "Summarize to reclaim context", argumentHint: "[instructions]" },
  ],
  skills: [
    { name: "console-e2e", description: "Drive a headless real-browser test", argumentHint: "" },
    { name: "pr-workflow", description: "End-to-end PR lifecycle", argumentHint: "" },
  ],
  agents: [
    { name: "Explore", description: "Read-only search agent", argumentHint: "" },
  ],
};

describe("readSlashToken", () => {
  it("wakes only at the first character", () => {
    expect(readSlashToken("/com", 4)).toEqual({ kind: "slash", at: 0, query: "com" });
    expect(readSlashToken("hi /com", 7)).toBeNull();
  });

  it("lies down once the first word ends", () => {
    // 공백이 오면 리터럴이다 — 인자를 치는 동안 덱이 다시 서면 Enter의 뜻이 바뀐다.
    expect(readSlashToken("/compact now", 12)).toBeNull();
  });

  it("never wakes on a filesystem path", () => {
    // 이 규칙이 없으면 `/Users/…`를 치는 내내 덱이 명멸한다.
    expect(readSlashToken("/Users/sbluemin", 15)).toBeNull();
  });

  it("stays closed when the caret sits before the slash", () => {
    expect(readSlashToken("/clear", 0)).toBeNull();
  });
});

describe("readAgentToken", () => {
  it("wakes at the start and after whitespace", () => {
    expect(readAgentToken("@Exp", 4)).toEqual({ kind: "agent", at: 0, query: "Exp" });
    expect(readAgentToken("ask @Exp", 8)).toEqual({ kind: "agent", at: 4, query: "Exp" });
  });

  it("ignores a literal @ inside a word", () => {
    // 이메일이 덱을 깨우지 않는 유일한 근거다.
    expect(readAgentToken("mail me@example.com", 19)).toBeNull();
  });

  it("lies down once whitespace follows", () => {
    expect(readAgentToken("@Explore the repo", 17)).toBeNull();
  });
});

describe("readDeckToken", () => {
  it("lets the slash win over a later @", () => {
    // 첫 글자가 `/`면 뒤의 `@`는 명령의 인자이지 멘션이 아니다.
    expect(readDeckToken("/send", 5)?.kind).toBe("slash");
  });

  it("returns the agent token when the line is not a command", () => {
    expect(readDeckToken("ask @Exp", 8)?.kind).toBe("agent");
  });
});

describe("buildDeckSections", () => {
  it("splits slash results into commands and skills", () => {
    const token = readSlashToken("/", 1)!;
    const sections = buildDeckSections(CATALOG, token);
    expect(sections.map((section) => section.id)).toEqual(["commands", "skills"]);
    expect(flattenDeckRows(sections)).toHaveLength(4);
  });

  it("shows only agents for the @ deck", () => {
    const token = readAgentToken("@", 1)!;
    expect(buildDeckSections(CATALOG, token).map((section) => section.id)).toEqual(["agents"]);
  });

  it("matches on description as well as name", () => {
    // 스킬 이름은 자명하지 않아 설명이 유일한 실마리일 때가 많다.
    const token = readSlashToken("/browser", 8)!;
    expect(flattenDeckRows(buildDeckSections(CATALOG, token)).map((entry) => entry.name))
      .toEqual(["console-e2e"]);
  });

  it("drops a section that has no hits instead of leaving an empty header", () => {
    const token = readSlashToken("/clear", 6)!;
    expect(buildDeckSections(CATALOG, token).map((section) => section.id)).toEqual(["commands"]);
  });

  it("returns nothing while the catalog is unknown", () => {
    expect(buildDeckSections(null, readSlashToken("/", 1)!)).toEqual([]);
  });
});

describe("applyDeckPick", () => {
  it("sends immediately when the command takes no arguments", () => {
    const token = readSlashToken("/cl", 3)!;
    expect(applyDeckPick("/cl", token, CATALOG.commands[0]!)).toEqual({ draft: "/clear", submit: true });
  });

  it("only inserts when an argument hint exists", () => {
    // 인자를 받는 항목을 바로 보내면 빈손으로 나간다.
    const token = readSlashToken("/com", 4)!;
    expect(applyDeckPick("/com", token, CATALOG.commands[1]!)).toEqual({ draft: "/compact ", submit: false });
  });

  it("never submits an agent mention", () => {
    // 행위자 지목만으로는 할 일이 정해지지 않는다.
    const token = readAgentToken("@Exp", 4)!;
    expect(applyDeckPick("@Exp", token, CATALOG.agents[0]!)).toEqual({ draft: "@Explore ", submit: false });
  });

  it("keeps text written after the mention", () => {
    const value = "@Exp the repo";
    const token = readAgentToken(value, 4)!;
    expect(applyDeckPick(value, token, CATALOG.agents[0]!).draft).toBe("@Explore the repo");
  });

  it("replaces the whole line for a slash pick even mid-word", () => {
    const token = readSlashToken("/pr-", 4)!;
    expect(applyDeckPick("/pr-", token, CATALOG.skills[1]!).draft).toBe("/pr-workflow");
  });
});
