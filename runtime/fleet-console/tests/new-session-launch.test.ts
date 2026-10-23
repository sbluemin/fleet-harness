// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { readNewSessionSelection } from "../features/workspace/client/conversation/new-session-preferences.js";
import { resolveMentionEntry } from "../features/workspace/client/conversation/new-session-mention.js";
import { getState, removeTheater, setState } from "../core/client/src/integration/store.js";
import type { ObjectiveRecord, TheaterInfo } from "../core/client/src/integration/types.js";

function makeTheater(id: string): TheaterInfo {
  return { id, label: id, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
}

describe("new session preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("treats a corrupt entry as no memory rather than throwing", () => {
    window.localStorage.setItem("fleet-console.newSession.selection", "{not json");
    expect(readNewSessionSelection()).toEqual({ theaterId: null, model: null, effort: null });
  });
});

describe("pending request lifecycle", () => {
  it("drops a pending launch when its Theater is removed", () => {
    // 사라진 Theater를 가리키는 발사 요청은 실행하지 않고 함께 버린다.
    setState({
      theaters: [makeTheater("t1"), makeTheater("t2")],
      pendingLaunch: {
        theaterId: "t1",
        pluginId: "terminal",
        kind: { id: "claude", type: "agent", title: "Claude" },
        variant: { prompt: "do the thing" },
      },
    });

    removeTheater("t1");

    expect(getState().pendingLaunch).toBeNull();
  });
});

function makeObjective(id: string, overrides: Partial<ObjectiveRecord> = {}): ObjectiveRecord {
  return {
    id,
    theaterId: "th-a",
    title: id,
    ...({}),
    ts: { createdAt: 1, updatedAt: 1 },
    ...overrides,
  };
}

const MESSAGEABLE = new Map<string, ReadonlySet<string>>([["terminal", new Set(["agent"])]]);

describe("resolveMentionEntry", () => {
  // composer.open({ mentionObjectiveId })가 건네는 명시 행선지의 해소. 그 패널을 직접 가리킨 지시라
  // 어느 Theater인지는 가리지 않지만, 메시지를 받지 않는 타입·입력 대기 중인 대상은 거른다.
  const state = {
    ...getState(),
    theaters: [makeTheater("th-a"), makeTheater("th-b")],
    objectiveRecords: [
      makeObjective("op-live"),
      makeObjective("op-await", { id: "op-await" }),
      makeObjective("op-far", { theaterId: "th-b" }),
    ],
    objectiveRecordRuntime: { "op-await": { lifecycle: "live", activity: "awaiting" } as const },
  };

  it("refuses an objective waiting on its own prompt and an unknown id", () => {
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-await")).toBeNull();
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-missing")).toBeNull();
  });
});
