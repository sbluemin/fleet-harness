// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { OperationCatalogPlugin, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";

import { readQuickLaunchSelection, writeQuickLaunchModelEffort, writeQuickLaunchPinned, writeQuickLaunchSelection } from "../core/client/src/quick-launch-preferences.js";
import { buildQuickLaunchMentionGroups, findVariantLaunchKind, isMentionSelectable, QUICK_LAUNCH_DEFAULT_MODEL, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchErrorMessageKey, quickLaunchMentionErrorMessageKey, readMentionToken, resolveSelection, stripMentionToken } from "../core/client/src/quick-launch.js";
import { clearQuickLaunchRejection, getState, isQuickLaunchDocked, openQuickLaunch, removeTheater, reopenQuickLaunchWithDraft, setQuickLaunchDockSuppressed, setQuickLaunchPinned, setState, toggleQuickLaunch } from "../core/client/src/store.js";
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

describe("findVariantLaunchKind", () => {
  it("picks the first enabled kind that declares model/effort variants", () => {
    const target = findVariantLaunchKind(catalog([
      { id: "shell", type: "shell", title: "Shell" },
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)", variants: GROUPS },
    ]));

    expect(target).toEqual({ pluginId: "terminal", kind: expect.objectContaining({ id: "claude-gateway" }) });
  });

  it("skips a disabled kind so an unavailable CLI is never targeted", () => {
    const target = findVariantLaunchKind(catalog([
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)", disabled: true, variants: GROUPS },
    ]));

    expect(target).toBeNull();
  });

  it("returns null when no kind offers variants", () => {
    expect(findVariantLaunchKind(catalog([{ id: "shell", type: "shell", title: "Shell" }]))).toBeNull();
  });
});

describe("resolveSelection", () => {
  it("restores a remembered model and effort", () => {
    expect(resolveSelection(GROUPS, { model: "fable", effort: "max" })).toEqual({
      model: "fable[1m]",
      effort: "max",
      modelLabel: "Fable",
      effortLabel: "MAX",
    });
  });

  it("falls back to native Opus when the remembered model is no longer enabled", () => {
    // 설정에서 모델을 끄면 기억은 낡은 값이 된다 — 그대로 보내면 서버가 409 gateway_model_not_enabled로 거절한다.
    expect(resolveSelection(GROUPS, { model: "retired-model", effort: "high" })).toEqual({
      model: QUICK_LAUNCH_DEFAULT_MODEL,
      effort: null,
      modelLabel: "Opus",
      effortLabel: null,
    });
  });

  it("prefers native Opus over a starred Gateway default when nothing is remembered", () => {
    const groups = [
      {
        id: "gateway",
        label: "Gateway",
        rows: [{ id: "kimi", label: "Kimi", starred: true, launch: { model: "kimi" } }],
      },
      ...GROUPS,
    ];
    expect(resolveSelection(groups, { model: null, effort: null })).toMatchObject({
      model: QUICK_LAUNCH_DEFAULT_MODEL,
      modelLabel: "Opus",
    });
  });

  it("uses the starred row only when native Opus is absent", () => {
    const groups = [{ id: "gateway", label: "Gateway", rows: [{ id: "kimi", label: "Kimi", starred: true, launch: { model: "kimi" } }] }];
    expect(resolveSelection(groups, { model: null, effort: null })).toMatchObject({ model: "kimi", modelLabel: "Kimi" });
  });

  it("drops a remembered effort the model's ladder no longer exposes", () => {
    expect(resolveSelection(GROUPS, { model: "opus[1m]", effort: "low" })).toEqual({
      model: "opus[1m]",
      effort: null,
      modelLabel: "Opus",
      effortLabel: null,
    });
  });

  it("rewrites saved bare native selections onto 1M coordinates", () => {
    expect(resolveSelection(GROUPS, { model: "fable", effort: "max" })).toEqual({
      model: "fable[1m]",
      effort: "max",
      modelLabel: "Fable",
      effortLabel: "MAX",
    });
    expect(resolveSelection(GROUPS, { model: "opus", effort: "high" })).toEqual({
      model: "opus[1m]",
      effort: "high",
      modelLabel: "Opus",
      effortLabel: "HIGH",
    });
  });

  it("uses native Opus when nothing is remembered", () => {
    expect(resolveSelection(GROUPS, { model: null, effort: null })).toMatchObject({ model: QUICK_LAUNCH_DEFAULT_MODEL, effort: null });
  });

  it("returns an empty selection when the catalog has no rows", () => {
    expect(resolveSelection([], { model: "opus", effort: "high" })).toEqual({
      model: null,
      effort: null,
      modelLabel: null,
      effortLabel: null,
    });
  });
});

describe("quick launch preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips the last selection", () => {
    writeQuickLaunchSelection({ theaterId: "t1", model: "opus[1m]", effort: "xhigh", pinned: false });
    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus[1m]", effort: "xhigh", pinned: false });
  });

  it("updates model and effort without replacing the last launched Theater", () => {
    writeQuickLaunchSelection({ theaterId: "launched", model: "opus[1m]", effort: "high", pinned: true });

    writeQuickLaunchModelEffort("codex--gpt-5.6-luna-fast", "max");

    expect(readQuickLaunchSelection()).toEqual({
      theaterId: "launched",
      model: "codex--gpt-5.6-luna-fast",
      effort: "max",
      pinned: true,
    });
  });

  it("rewrites a leftover bare opus selection when it is read", () => {
    window.localStorage.setItem(
      "fleet-console.quickLaunch.selection",
      JSON.stringify({ theaterId: "t1", model: "opus", effort: "high" }),
    );
    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus[1m]", effort: "high", pinned: false });
    expect(JSON.parse(window.localStorage.getItem("fleet-console.quickLaunch.selection")!)).toEqual({
      theaterId: "t1",
      model: "opus[1m]",
      effort: "high",
      pinned: false,
    });
  });

  it("reads an empty selection when nothing was stored", () => {
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null, pinned: false });
  });

  it("treats a corrupt entry as no memory rather than throwing", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", "{not json");
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null, pinned: false });
  });

  it("drops non-string fields instead of trusting them", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", JSON.stringify({ theaterId: 7, model: "", effort: "high" }));
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: "high", pinned: false });
  });

  it("treats any non-true pin value as unpinned rather than trusting it", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", JSON.stringify({ pinned: "yes" }));
    expect(readQuickLaunchSelection().pinned).toBe(false);
  });
});

describe("quick launch pin", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setState({ quickLaunchOpen: false, quickLaunchPinned: false, quickLaunchFocusToggle: 0, quickLaunchDockSuppressed: false, quickLaunchError: null, quickLaunchErrorShortenBy: null, quickLaunchDraft: null });
  });

  it("remembers the pin beside the launch coordinates instead of replacing them", () => {
    writeQuickLaunchSelection({ theaterId: "t1", model: "opus[1m]", effort: "high", pinned: false });

    writeQuickLaunchPinned(true);

    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus[1m]", effort: "high", pinned: true });
  });

  // 고정 중에는 여닫을 것이 없다 — 같은 키가 포커스를 왕복시킨다.
  it("turns Mod+J into a focus toggle while pinned instead of closing the composer", () => {
    setQuickLaunchPinned(true);

    toggleQuickLaunch();

    // 고정 중에는 열림 플래그가 아니라 도킹이 이 표면의 존재를 결정한다.
    expect(isQuickLaunchDocked()).toBe(true);
    expect(getState().quickLaunchFocusToggle).toBe(1);
  });

  it("still opens and closes the composer when it is not pinned", () => {
    toggleQuickLaunch();
    expect(getState().quickLaunchOpen).toBe(true);
    expect(getState().quickLaunchFocusToggle).toBe(0);

    toggleQuickLaunch();
    expect(getState().quickLaunchOpen).toBe(false);
  });

  // 되돌리기가 취소가 되면 안 된다 — 고정을 풀면 쓰던 컴포저가 모달로 돌아올 뿐이다.
  it("keeps the composer open when the pin is released", () => {
    setQuickLaunchPinned(true);

    setQuickLaunchPinned(false);

    expect(getState().quickLaunchPinned).toBe(false);
    expect(getState().quickLaunchOpen).toBe(true);
  });

  it("persists the pin so a reload restores the docked bar", () => {
    setQuickLaunchPinned(true);

    expect(readQuickLaunchSelection().pinned).toBe(true);
  });

  // 고정된 컴포저는 배치가 존재를 결정한다 — 모달 열림이 남으면 도킹을 접어 둔 화면에서 컴포저가
  // 모달로 되살아나고, 열림을 보고 자기를 억제하는 What's New가 영영 뜨지 않는다.
  it("lowers the modal-open flag when the pin goes on, and raises it again when it comes off", () => {
    openQuickLaunch();
    expect(getState().quickLaunchOpen).toBe(true);

    setQuickLaunchPinned(true);
    expect(getState().quickLaunchOpen).toBe(false);

    setQuickLaunchPinned(false);
    expect(getState().quickLaunchOpen).toBe(true);
  });

  it("keeps the composer off screens that fold the dock away, even right after pinning", () => {
    openQuickLaunch();
    setQuickLaunchPinned(true);
    setQuickLaunchDockSuppressed(true);

    // 화면이 그리는 조건과 같은 식: state.quickLaunchOpen || (pinned && !dockSuppressed)
    expect(getState().quickLaunchOpen || isQuickLaunchDocked()).toBe(false);
  });

  // 모달은 닫히며 사유를 버리지만 고정된 바는 닫히지 않는다 — 성공한 재시도 위에 옛 실패가 남으면
  // 발사된 지시가 실패한 것처럼 읽히고, 사유가 붙어 있는 동안 바가 접히지도 않는다.
  it("clears a stale rejection without closing the composer", () => {
    reopenQuickLaunchWithDraft("draft", "errorGeneric", 12);
    setQuickLaunchPinned(true);

    clearQuickLaunchRejection();

    expect(getState().quickLaunchError).toBeNull();
    expect(getState().quickLaunchErrorShortenBy).toBeNull();
    expect(getState().quickLaunchPinned).toBe(true);
  });
});

describe("prompt limit", () => {
  it("mirrors the server-enforced launch prompt limit", () => {
    // 브라우저 사본이 서버 계약과 갈라지면 컴포저가 반드시 400으로 거절될 요청을 보내고 초안을 잃는다.
    // 패키지를 import하면 jsdom이 node:sqlite까지 끌어오므로, 계약 테스트와 같이 소스를 읽어 고정한다.
    // jsdom 환경에서는 import.meta.url이 file: 스킴이 아니므로 vitest cwd(runtime/fleet-console) 기준으로 읽는다.
    const source = readFileSync(resolve(process.cwd(), "../../packages/fleet-admiral/src/agent-cli/types.ts"), "utf8");
    const declared = source.match(/MAX_LAUNCH_PROMPT_CHARS = (\d+)/)?.[1];
    expect(declared).toBeDefined();
    expect(QUICK_LAUNCH_PROMPT_MAX_CHARS).toBe(Number(declared));
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
        kind: { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
        variant: { prompt: "do the thing" },
      },
    });

    removeTheater("t1");

    expect(getState().pendingQuickLaunch).toBeNull();
  });

  it("keeps a pending Quick Launch aimed at a surviving Theater", () => {
    setState({
      theaters: [makeTheater("t1"), makeTheater("t2")],
      activeTheaterId: "t1",
      pendingQuickLaunch: {
        theaterId: "t2",
        pluginId: "terminal",
        kind: { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
        variant: { prompt: "do the thing" },
      },
    });

    removeTheater("t1");

    expect(getState().pendingQuickLaunch).toMatchObject({ theaterId: "t2" });
  });
});

describe("rejection messages", () => {
  it("names what to fix for each rejection the server can send", () => {
    // 초안만 되살리고 사유를 숨기면 결정적 실패는 같은 Run을 반복하게 만든다.
    expect(quickLaunchErrorMessageKey("prompt_unsafe_for_shim")).toBe("chrome.quickLaunch.errorUnsafePrompt");
    expect(quickLaunchErrorMessageKey("prompt_unsupported_launch")).toBe("chrome.quickLaunch.errorPromptUnsupported");
    expect(quickLaunchErrorMessageKey("prompt_too_long")).toBe("chrome.quickLaunch.errorTooLong");
    expect(quickLaunchErrorMessageKey("prompt_command_line_too_long")).toBe("chrome.quickLaunch.errorCommandLineTooLong");
    // 서버가 줄여야 할 글자 수를 실어 보내면, 그 수를 담는 문구로 올라선다. 브라우저는 이 실행의
    // 명령줄 상한을 알 수 없어 스스로 계산할 수 없으므로 서버가 준 값이 유일한 출처다.
    expect(quickLaunchErrorMessageKey("prompt_command_line_too_long", 2145)).toBe("chrome.quickLaunch.errorCommandLineTooLongBy");
    // 다른 코드에는 그 수가 붙어도 문구가 바뀌지 않는다.
    expect(quickLaunchErrorMessageKey("prompt_too_long", 2145)).toBe("chrome.quickLaunch.errorTooLong");
    expect(quickLaunchErrorMessageKey("launch_command_line_too_long")).toBe("chrome.quickLaunch.errorLaunchCommandLineTooLong");
    expect(quickLaunchErrorMessageKey("gateway_model_not_enabled")).toBe("chrome.quickLaunch.errorModelOff");
    expect(quickLaunchErrorMessageKey("invalid_effort")).toBe("chrome.quickLaunch.errorEffortOff");
    expect(quickLaunchErrorMessageKey("agent_cli_unavailable")).toBe("chrome.quickLaunch.errorCliUnavailable");
  });

  it("falls back to a generic reason rather than saying nothing", () => {
    expect(quickLaunchErrorMessageKey("something_new_from_the_server")).toBe("chrome.quickLaunch.errorGeneric");
  });

  it("shows nothing when there was no rejection", () => {
    expect(quickLaunchErrorMessageKey(null)).toBeNull();
  });

  it("declares every mapped key in both locales", () => {
    const chrome = readFileSync(resolve(process.cwd(), "core/client/src/i18n/messages/chrome.ts"), "utf8");
    const keys = [
      "chrome.quickLaunch.errorUnsafePrompt",
      "chrome.quickLaunch.errorPromptUnsupported",
      "chrome.quickLaunch.errorTooLong",
      "chrome.quickLaunch.errorCommandLineTooLong",
      "chrome.quickLaunch.errorCommandLineTooLongBy",
      "chrome.quickLaunch.errorLaunchCommandLineTooLong",
      "chrome.quickLaunch.errorModelOff",
      "chrome.quickLaunch.errorEffortOff",
      "chrome.quickLaunch.errorCliUnavailable",
      "chrome.quickLaunch.errorGeneric",
    ];
    for (const key of keys) {
      expect(chrome.split(`"${key}":`).length - 1, key).toBe(2);
    }
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

describe("readMentionToken", () => {
  it("opens at the start of the input", () => {
    expect(readMentionToken("@", 1)).toEqual({ at: 0, query: "" });
    expect(readMentionToken("@gate", 5)).toEqual({ at: 0, query: "gate" });
  });

  it("opens after whitespace only — mid-word @ stays literal", () => {
    expect(readMentionToken("see @op", 7)).toEqual({ at: 4, query: "op" });
    expect(readMentionToken("mail a@b", 8)).toBeNull();
  });

  it("closes once the token carries whitespace or a second @", () => {
    expect(readMentionToken("@a b", 4)).toBeNull();
    expect(readMentionToken("@@x", 3)).toBeNull();
  });

  it("reads relative to the caret, not the end of the value", () => {
    expect(readMentionToken("@ab rest", 3)).toEqual({ at: 0, query: "ab" });
    expect(readMentionToken("@ab rest", 0)).toBeNull();
  });
});

describe("stripMentionToken", () => {
  it("removes exactly the @token span", () => {
    expect(stripMentionToken("@gate", { at: 0, query: "gate" })).toBe("");
    expect(stripMentionToken("see @op now", { at: 4, query: "op" })).toBe("see  now");
  });
});

describe("isMentionSelectable", () => {
  it("blocks awaiting only — dormant resumes on delivery", () => {
    expect(isMentionSelectable("awaiting")).toBe(false);
    for (const activity of ["idle", "running", "dormant", "background"] as const) {
      expect(isMentionSelectable(activity), activity).toBe(true);
    }
  });
});

describe("buildQuickLaunchMentionGroups", () => {
  it("lists only declared plugin/type pairs, grouped by theater, with raw activity", () => {
    const state = {
      ...getState(),
      theaters: [makeTheater("th-a"), makeTheater("th-b")],
      operations: [
        makeOperation("op-live"),
        makeOperation("op-dormant", { theaterId: "th-b", payload: { resumeAvailable: true } }),
        makeOperation("op-shell", { type: "shell" }),
        makeOperation("op-foreign", { pluginId: "analyst" }),
      ],
      operationStatus: { "op-live": "running" as const },
    };
    const groups = buildQuickLaunchMentionGroups(state, MESSAGEABLE, "");
    expect(groups.map((group) => group.theaterId)).toEqual(["th-a", "th-b"]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.operationId))).toEqual(["op-live", "op-dormant"]);
    expect(groups[0]?.entries[0]?.activity).toBe("running");
    expect(groups[1]?.entries[0]?.activity).toBe("dormant");
  });

  it("filters by query across name and theater label", () => {
    const state = {
      ...getState(),
      theaters: [makeTheater("th-a")],
      operations: [makeOperation("gateway sweep", { title: "gateway sweep" }), makeOperation("docs run", { title: "docs run" })],
      operationStatus: {},
    };
    const groups = buildQuickLaunchMentionGroups(state, MESSAGEABLE, "gate");
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.operationName))).toEqual(["gateway sweep"]);
  });
});

describe("mention rejection messages", () => {
  it("maps delivery codes onto message keys with a generic fallback", () => {
    expect(quickLaunchMentionErrorMessageKey("resume_unavailable")).toBe("chrome.quickLaunch.mentionErrorResumeUnavailable");
    expect(quickLaunchMentionErrorMessageKey("session_awaiting_input")).toBe("chrome.quickLaunch.mentionErrorAwaiting");
    expect(quickLaunchMentionErrorMessageKey("session_not_found")).toBe("chrome.quickLaunch.mentionErrorGone");
    expect(quickLaunchMentionErrorMessageKey("prompt_too_long")).toBe("chrome.quickLaunch.errorTooLong");
    expect(quickLaunchMentionErrorMessageKey("gateway_model_not_enabled")).toBe("chrome.quickLaunch.errorModelOff");
    expect(quickLaunchMentionErrorMessageKey("terminal_unavailable")).toBe("chrome.quickLaunch.mentionErrorDeliveryFailed");
    expect(quickLaunchMentionErrorMessageKey(null)).toBe("chrome.quickLaunch.mentionErrorDeliveryFailed");
  });

  it("declares every mention key in both locales", () => {
    const chrome = readFileSync(resolve(process.cwd(), "core/client/src/i18n/messages/chrome.ts"), "utf8");
    const keys = [
      "chrome.quickLaunch.mentionDeck",
      "chrome.quickLaunch.mentionCategoryOperations",
      "chrome.quickLaunch.mentionNoMatch",
      "chrome.quickLaunch.mentionPlaceholder",
      "chrome.quickLaunch.mentionTarget",
      "chrome.quickLaunch.mentionErrorResumeUnavailable",
      "chrome.quickLaunch.mentionErrorAwaiting",
      "chrome.quickLaunch.mentionErrorGone",
      "chrome.quickLaunch.mentionErrorDeliveryFailed",
    ];
    for (const key of keys) {
      expect(chrome.split(`"${key}":`).length - 1, key).toBe(2);
    }
  });
});
