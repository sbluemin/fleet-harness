import { describe, expect, it } from "vitest";

import type { AgentChatCatalog } from "./chat-events.js";
import {
  applyDeckPick,
  buildDeckSections,
  flattenDeckRows,
  readAgentToken,
  readConsoleCommand,
  readDeckToken,
  readResolvedTokenRanges,
  readSlashToken,
} from "./composer-deck.js";

const CATALOG: AgentChatCatalog = {
  commands: [
    { name: "clear", description: "Clear the conversation", argumentHint: "", console: "clear" },
    { name: "compact", description: "Summarize to reclaim context", argumentHint: "[instructions]" },
  ],
  skills: [
    { name: "console-e2e", description: "Drive a headless real-browser test", argumentHint: "" },
    { name: "pr-workflow", description: "End-to-end PR lifecycle", argumentHint: "" },
  ],
  agents: [
    { name: "Explore", description: "Read-only search agent", argumentHint: "" },
  ],
  unclassified: [],
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
  /**
   * 고르는 것은 언제나 **완성**이지 전송이 아니다. 인자 없는 명령만 즉시 보내던 초기 계약은,
   * 같은 Enter가 행마다 다른 일을 하게 만들어 사용자가 고르기 전에 결과를 예측할 수 없었다.
   */
  it("completes without sending, even for a command that takes no arguments", () => {
    const token = readSlashToken("/cl", 3)!;
    expect(applyDeckPick("/cl", token, CATALOG.commands[0]!)).toEqual({ draft: "/clear ", caret: 7 });
  });

  it("leaves the caret after the inserted token so arguments can follow", () => {
    const token = readSlashToken("/com", 4)!;
    expect(applyDeckPick("/com", token, CATALOG.commands[1]!)).toEqual({ draft: "/compact ", caret: 9 });
  });

  it("completes an agent mention the same way", () => {
    const token = readAgentToken("@Exp", 4)!;
    expect(applyDeckPick("@Exp", token, CATALOG.agents[0]!)).toEqual({ draft: "@Explore ", caret: 9 });
  });

  it("keeps text written after the mention", () => {
    const value = "@Exp the repo";
    const token = readAgentToken(value, 4)!;
    expect(applyDeckPick(value, token, CATALOG.agents[0]!).draft).toBe("@Explore the repo");
  });

  it("replaces the whole line for a slash pick even mid-word", () => {
    const token = readSlashToken("/pr-", 4)!;
    expect(applyDeckPick("/pr-", token, CATALOG.skills[1]!).draft).toBe("/pr-workflow ");
  });
});

describe("readResolvedTokenRanges", () => {
  /** 색은 "이건 실제로 부를 수 있다"는 뜻이어야 한다 — 모양만 맞는 오타를 칠하면 그 뜻이 죽는다. */
  it("marks a command that exists and ignores one that does not", () => {
    expect(readResolvedTokenRanges("/clear ", CATALOG)).toEqual([{ start: 0, end: 6 }]);
    expect(readResolvedTokenRanges("/celar ", CATALOG)).toEqual([]);
  });

  it("marks an agent mention anywhere in the sentence", () => {
    expect(readResolvedTokenRanges("ask @Explore to look", CATALOG)).toEqual([{ start: 4, end: 12 }]);
  });

  it("leaves an email alone", () => {
    expect(readResolvedTokenRanges("mail me@Explore.com", CATALOG)).toEqual([]);
  });

  it("marks nothing while the catalog is unknown", () => {
    expect(readResolvedTokenRanges("/clear", null)).toEqual([]);
  });
});

describe("readConsoleCommand", () => {
  // 인자를 받는 Console 항목. 공유 픽스처의 행 수는 다른 검사의 기대치라 여기서만 늘린다.
  const WITH_RENAME: AgentChatCatalog = {
    ...CATALOG,
    commands: [
      ...CATALOG.commands,
      { name: "rename", description: "Rename the current conversation", argumentHint: "[name]", console: "rename" },
    ],
  };

  it("routes a Console-owned command with its argument", () => {
    expect(readConsoleCommand("/rename ledger audit", WITH_RENAME)).toEqual({
      target: "rename",
      argument: "ledger audit",
      name: "rename",
    });
  });

  it("routes one with no argument", () => {
    expect(readConsoleCommand("/clear", CATALOG)).toEqual({ target: "clear", argument: "", name: "clear" });
  });

  it("leaves a passthrough command to the child", () => {
    expect(readConsoleCommand("/compact tighten it", CATALOG)).toBeNull();
  });

  it("leaves a skill to the child even when its name looks built-in", () => {
    // 정책은 내장 명령에만 걸린다. 스킬 칸의 같은 이름이 Console로 새면 남의 물건이 실행되지 않는다.
    expect(readConsoleCommand("/pr-workflow", CATALOG)).toBeNull();
  });

  it("says nothing before the catalog arrives", () => {
    // 카탈로그를 모르는 동안 지시를 가로채면, 아직 분류를 모르는 명령이 자식에게 닿지 못한 채
    // 조용히 삼켜진다. 모를 때는 평소대로 자식에게 보낸다.
    expect(readConsoleCommand("/rename x", null)).toBeNull();
  });

  it("ignores prose and paths", () => {
    expect(readConsoleCommand("rename the operation", WITH_RENAME)).toBeNull();
    expect(readConsoleCommand("/Users/sbluemin/notes.md", WITH_RENAME)).toBeNull();
  });
});

describe("deck ranking", () => {
  const RANKED: AgentChatCatalog = {
    commands: [
      // 카탈로그 순서상 `clear`가 먼저다 — 설명에 "context"가 들어 있다.
      { name: "clear", description: "Start a new session with empty context", argumentHint: "", console: "clear" },
      { name: "compact", description: "Free up context by summarizing", argumentHint: "" },
      { name: "context", description: "Show current context usage", argumentHint: "", console: "context" },
    ],
    skills: [],
    agents: [],
    unclassified: [],
  };

  it("puts the exact name first even when other descriptions match", () => {
    // 이름을 끝까지 친 사람이 다른 행을 받으면, 그 Enter가 문맥을 지우는 명령을 완성한다.
    const rows = flattenDeckRows(buildDeckSections(RANKED, { kind: "slash", at: 0, query: "context" }));
    expect(rows.map((row) => row.name)).toEqual(["context", "clear", "compact"]);
  });

  it("prefers a name prefix over a description hit", () => {
    const rows = flattenDeckRows(buildDeckSections(RANKED, { kind: "slash", at: 0, query: "c" }));
    expect(rows.map((row) => row.name)).toEqual(["clear", "compact", "context"]);
  });

  it("keeps catalog order inside one closeness tier", () => {
    // 이름순으로 다시 세우면 자식이 준 관용적 배열이 사라지고 목록이 판본마다 흔들린다.
    const rows = flattenDeckRows(buildDeckSections(RANKED, { kind: "slash", at: 0, query: "" }));
    expect(rows.map((row) => row.name)).toEqual(["clear", "compact", "context"]);
  });

  it("still finds a skill by its description alone", () => {
    const rows = flattenDeckRows(buildDeckSections(CATALOG, { kind: "slash", at: 0, query: "headless" }));
    expect(rows.map((row) => row.name)).toEqual(["console-e2e"]);
  });
});
