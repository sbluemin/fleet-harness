// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { OperationCatalogPlugin, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";

import { readQuickLaunchSelection, writeQuickLaunchSelection } from "../core/client/src/quick-launch-preferences.js";
import { findVariantLaunchKind, QUICK_LAUNCH_PROMPT_MAX_CHARS, quickLaunchErrorMessageKey, resolveSelection } from "../core/client/src/quick-launch.js";
import { getState, removeTheater, setState } from "../core/client/src/store.js";
import type { TheaterInfo } from "../core/client/src/types.js";

function makeTheater(id: string): TheaterInfo {
  return { id, label: id, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
}

const GROUPS: readonly OperationLaunchVariantGroup[] = [
  {
    id: "builtin",
    label: "Claude 내장",
    rows: [
      {
        id: "fable",
        label: "Fable",
        launch: { model: "fable" },
        chips: [
          { id: "fable-low", label: "LOW", launch: { model: "fable", effort: "low" } },
          { id: "fable-max", label: "MAX", launch: { model: "fable", effort: "max" } },
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
      { id: "claude-native", type: "agent", title: "Claude (Native)" },
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
      model: "fable",
      effort: "max",
      modelLabel: "Fable",
      effortLabel: "MAX",
    });
  });

  it("falls back to the starred row when the remembered model is no longer enabled", () => {
    // 설정에서 모델을 끄면 기억은 낡은 값이 된다 — 그대로 보내면 서버가 409 gateway_model_not_enabled로 거절한다.
    expect(resolveSelection(GROUPS, { model: "retired-model", effort: "high" })).toEqual({
      model: "opus[1m]",
      effort: null,
      modelLabel: "Opus",
      effortLabel: null,
    });
  });

  it("drops a remembered effort the model's ladder no longer exposes", () => {
    expect(resolveSelection(GROUPS, { model: "opus[1m]", effort: "low" })).toEqual({
      model: "opus[1m]",
      effort: null,
      modelLabel: "Opus",
      effortLabel: null,
    });
  });

  it("rewrites a saved bare opus selection onto the 1M coordinate", () => {
    expect(resolveSelection(GROUPS, { model: "opus", effort: "high" })).toEqual({
      model: "opus[1m]",
      effort: "high",
      modelLabel: "Opus",
      effortLabel: "HIGH",
    });
  });

  it("uses the starred row when nothing is remembered", () => {
    expect(resolveSelection(GROUPS, { model: null, effort: null })).toMatchObject({ model: "opus[1m]", effort: null });
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
    writeQuickLaunchSelection({ theaterId: "t1", model: "opus", effort: "xhigh" });
    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus", effort: "xhigh" });
  });

  it("reads an empty selection when nothing was stored", () => {
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null });
  });

  it("treats a corrupt entry as no memory rather than throwing", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", "{not json");
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null });
  });

  it("drops non-string fields instead of trusting them", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", JSON.stringify({ theaterId: 7, model: "", effort: "high" }));
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: "high" });
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
