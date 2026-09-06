// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { OperationCatalogPlugin, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";

import { readQuickLaunchSelection, writeQuickLaunchMentionFocused, writeQuickLaunchModelEffort, writeQuickLaunchPinned, writeQuickLaunchSelection } from "../core/client/src/quick-launch-preferences.js";
import { buildPluginMentionCategories, buildQuickLaunchEffortDeck, buildQuickLaunchMentionGroups, findVariantLaunchKind, isMentionSelectable, mentionTargetName, isQuickLaunchAttachmentCandidate, isUltracodeDisarmCaret, nextUltracodeIgnored, QUICK_LAUNCH_ATTACHMENT_MAX_BYTES, QUICK_LAUNCH_DEFAULT_MODEL, QUICK_LAUNCH_MAX_ATTACHMENTS, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchAttachmentErrorMessageKey, quickLaunchErrorMessageKey, quickLaunchMentionErrorMessageKey, readCommandInput, readMentionToken, readUltracodeTokens, resolveFocusedMention, resolveMentionEntry, resolveSelection, shouldApplyFocusedMention, stripMentionToken } from "../core/client/src/quick-launch.js";
import { clearQuickLaunchRejection, consumeQuickLaunchDraft, getState, isQuickLaunchDocked, openQuickLaunch, openQuickLaunchForOperation, preserveQuickLaunchDraft, removeTheater, reopenQuickLaunchWithDraft, setQuickLaunchDockSuppressed, setQuickLaunchPinned, setState, toggleQuickLaunch } from "../core/client/src/store.js";
import type { OperationNode, TheaterInfo } from "../core/client/src/types.js";

function makeTheater(id: string): TheaterInfo {
  return { id, label: id, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
}

const GROUPS: readonly OperationLaunchVariantGroup[] = [
  {
    id: "builtin",
    label: "Claude",
    rows: [
      {
        id: "fable",
        label: "Fable",
        launch: { model: "fable[1m]" },
        chips: [
          { id: "fable-low", label: "LOW", launch: { model: "fable[1m]", effort: "low" } },
          { id: "fable-max", label: "MAX", launch: { model: "fable[1m]", effort: "max" } },
        ],
      },
      {
        id: "opus[1m]",
        label: "Opus",
        starred: true,
        launch: { model: "opus[1m]" },
        chips: [
          { id: "opus-high", label: "HIGH", launch: { model: "opus[1m]", effort: "high" } },
          { id: "opus-xhigh", label: "XHIGH", launch: { model: "opus[1m]", effort: "xhigh" } },
        ],
      },
    ],
  },
];

function catalog(kinds: OperationCatalogPlugin["kinds"]): readonly OperationCatalogPlugin[] {
  return [{ id: "terminal", title: "Terminal", kinds }];
}

describe("quick launch preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("treats a corrupt entry as no memory rather than throwing", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", "{not json");
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null, pinned: false, mentionFocused: false, view: "terminal" });
  });
});

describe("pending request lifecycle", () => {
  it("drops a pending Quick Launch when its Theater is removed", () => {
    // 소비 조건이 request.theaterId === activeTheaterId이므로, Theater가 사라지면 조건이 영영
    // 성립하지 않는다. 함께 버리지 않으면 프롬프트가 실행되지도 지워지지도 않은 채 남는다.
    setState({
      theaters: [makeTheater("t1"), makeTheater("t2")],
      activeTheaterId: "t1",
      pendingQuickLaunch: {
        theaterId: "t1",
        pluginId: "terminal",
        kind: { id: "claude", type: "agent", title: "Claude" },
        variant: { prompt: "do the thing" },
      },
    });

    removeTheater("t1");

    expect(getState().pendingQuickLaunch).toBeNull();
  });
});

function makeOperation(id: string, overrides: Partial<OperationNode> = {}): OperationNode {
  return {
    id,
    theaterId: "th-a",
    type: "agent",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
    ...overrides,
  };
}

const MESSAGEABLE = new Map<string, ReadonlySet<string>>([["terminal", new Set(["agent"])]]);

describe("resolveMentionEntry", () => {
  // 패널 회신 버튼이 건네는 명시 행선지의 해소. 포커스 옵트인과 같은 판정을 쓰되 Theater 가드만
  // 지지 않는다 — 그 패널의 버튼을 직접 누른 지시라 어느 Theater인지가 의도를 바꾸지 않는다.
  const state = {
    ...getState(),
    theaters: [makeTheater("th-a"), makeTheater("th-b")],
    operations: [
      makeOperation("op-live"),
      makeOperation("op-shell", { type: "shell" }),
      makeOperation("op-await", { id: "op-await" }),
      makeOperation("op-far", { theaterId: "th-b" }),
    ],
    operationRuntime: { "op-await": { lifecycle: "live", activity: "awaiting" } as const },
    activeTheaterId: "th-a",
  };

  it("refuses a type that takes no messages, an Operation waiting on its own prompt, and an unknown id", () => {
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-shell")).toBeNull();
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-await")).toBeNull();
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-missing")).toBeNull();
  });
});
