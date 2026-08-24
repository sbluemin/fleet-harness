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

describe("findVariantLaunchKind", () => {
  it("picks the first enabled kind that declares model/effort variants", () => {
    const target = findVariantLaunchKind(catalog([
      { id: "shell", type: "shell", title: "Shell" },
      { id: "claude", type: "agent", title: "Claude", variants: GROUPS },
    ]));

    expect(target).toEqual({ pluginId: "terminal", kind: expect.objectContaining({ id: "claude" }) });
  });

  it("skips a disabled kind so an unavailable CLI is never targeted", () => {
    const target = findVariantLaunchKind(catalog([
      { id: "claude", type: "agent", title: "Claude", disabled: true, variants: GROUPS },
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
    writeQuickLaunchSelection({ theaterId: "t1", model: "opus[1m]", effort: "xhigh", pinned: false, mentionFocused: false, view: "terminal" });
    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus[1m]", effort: "xhigh", pinned: false, mentionFocused: false, view: "terminal" });
  });

  it("updates model and effort without replacing the last launched Theater", () => {
    writeQuickLaunchSelection({ theaterId: "launched", model: "opus[1m]", effort: "high", pinned: true, mentionFocused: false, view: "terminal" });

    writeQuickLaunchModelEffort("codex--gpt-5.6-luna-fast", "max");

    expect(readQuickLaunchSelection()).toEqual({
      theaterId: "launched",
      model: "codex--gpt-5.6-luna-fast",
      effort: "max",
      pinned: true,
      mentionFocused: false,
      view: "terminal",
    });
  });

  it("rewrites a leftover bare opus selection when it is read", () => {
    window.localStorage.setItem(
      "fleet-console.quickLaunch.selection",
      JSON.stringify({ theaterId: "t1", model: "opus", effort: "high" }),
    );
    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus[1m]", effort: "high", pinned: false, mentionFocused: false, view: "terminal" });
    expect(JSON.parse(window.localStorage.getItem("fleet-console.quickLaunch.selection")!)).toEqual({
      theaterId: "t1",
      model: "opus[1m]",
      effort: "high",
      pinned: false,
      mentionFocused: false,
      view: "terminal",
    });
  });

  it("reads an empty selection when nothing was stored", () => {
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null, pinned: false, mentionFocused: false, view: "terminal" });
  });

  it("treats a corrupt entry as no memory rather than throwing", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", "{not json");
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null, pinned: false, mentionFocused: false, view: "terminal" });
  });

  it("drops non-string fields instead of trusting them", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", JSON.stringify({ theaterId: 7, model: "", effort: "high" }));
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: "high", pinned: false, mentionFocused: false, view: "terminal" });
  });

  it("treats any non-true pin value as unpinned rather than trusting it", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", JSON.stringify({ pinned: "yes" }));
    expect(readQuickLaunchSelection().pinned).toBe(false);
  });

  it("defaults mentionFocused off and only trusts a boolean true", () => {
    expect(readQuickLaunchSelection().mentionFocused).toBe(false);
    window.localStorage.setItem("fleet-console.quickLaunch.selection", JSON.stringify({ mentionFocused: "yes" }));
    expect(readQuickLaunchSelection().mentionFocused).toBe(false);
    writeQuickLaunchMentionFocused(true);
    expect(readQuickLaunchSelection()).toMatchObject({ mentionFocused: true, pinned: false });
  });

  it("remembers mentionFocused beside pin instead of replacing it", () => {
    writeQuickLaunchSelection({ theaterId: "t1", model: "opus[1m]", effort: "high", pinned: true, mentionFocused: false, view: "terminal" });
    writeQuickLaunchMentionFocused(true);
    expect(readQuickLaunchSelection()).toEqual({
      theaterId: "t1",
      model: "opus[1m]",
      effort: "high",
      pinned: true,
      mentionFocused: true,
      view: "terminal",
    });
  });
});

describe("quick launch pin", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setState({ quickLaunchOpen: false, quickLaunchPinned: false, quickLaunchFocusToggle: 0, quickLaunchExpandRequest: 0, quickLaunchDockSuppressed: false, quickLaunchError: null, quickLaunchErrorShortenBy: null, quickLaunchDraft: null });
  });

  it("remembers the pin beside the launch coordinates instead of replacing them", () => {
    writeQuickLaunchSelection({ theaterId: "t1", model: "opus[1m]", effort: "high", pinned: false, mentionFocused: false, view: "terminal" });

    writeQuickLaunchPinned(true);

    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus[1m]", effort: "high", pinned: true, mentionFocused: false, view: "terminal" });
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

  // 열림 플래그를 참으로 올려 두면 눈에 보이는 변화 없이 값만 남아, 도킹을 접어 둔 화면에서
  // 모달로 되살아나고 What's New가 억제된다 — 명시적인 열기도 그 함정을 밟으면 안 된다.
  it("routes an explicit open to the dock instead of raising the modal-open flag", () => {
    setQuickLaunchPinned(true);
    const before = getState().quickLaunchExpandRequest;

    openQuickLaunch();

    expect(getState().quickLaunchOpen).toBe(false);
    expect(getState().quickLaunchExpandRequest).toBe(before + 1);
  });

  it("still opens the modal composer when nothing is docked", () => {
    openQuickLaunch();

    expect(getState().quickLaunchOpen).toBe(true);
    expect(getState().quickLaunchExpandRequest).toBe(0);
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
    // 패키지를 import하지 않고 계약 테스트와 같이 소스를 읽어 고정한다.
    // jsdom 환경에서는 import.meta.url이 file: 스킴이 아니므로 vitest cwd(runtime/fleet-console) 기준으로 읽는다.
    const source = readFileSync(resolve(process.cwd(), "../../packages/fleet-admiral/src/agent-cli/types.ts"), "utf8");
    const declared = source.match(/MAX_LAUNCH_PROMPT_CHARS = (\d+)/)?.[1];
    expect(declared).toBeDefined();
    expect(QUICK_LAUNCH_PROMPT_MAX_CHARS).toBe(Number(declared));
  });
});

describe("attachment contract", () => {
  it("mirrors the plugin-server attachment limits", () => {
    // 프롬프트 상한과 같은 계약 — 브라우저 사본이 서버와 갈라지면 확실히 400으로 거절될
    // 업로드·발사가 왕복한다. 패키지 import 대신 소스를 읽어 고정한다(prompt limit과 같은 방식).
    const source = readFileSync(resolve(process.cwd(), "../fleet-plugins/terminal/server/agent-api/launch-attachments.ts"), "utf8");
    const declaredBytes = source.match(/MAX_LAUNCH_ATTACHMENT_BYTES = ([^;]+);/)?.[1]?.trim();
    const declaredCount = source.match(/MAX_LAUNCH_ATTACHMENTS_PER_LAUNCH = (\d+)/)?.[1];
    expect(declaredBytes).toBeDefined();
    expect(declaredCount).toBeDefined();
    expect(QUICK_LAUNCH_ATTACHMENT_MAX_BYTES).toBe(Number(new Function(`return ${declaredBytes}`)()));
    expect(QUICK_LAUNCH_MAX_ATTACHMENTS).toBe(Number(declaredCount));
  });

  it("accepts only files the browser labels as images", () => {
    expect(isQuickLaunchAttachmentCandidate({ type: "image/png" })).toBe(true);
    expect(isQuickLaunchAttachmentCandidate({ type: "image/webp" })).toBe(true);
    expect(isQuickLaunchAttachmentCandidate({ type: "text/plain" })).toBe(false);
    expect(isQuickLaunchAttachmentCandidate({ type: "" })).toBe(false);
  });

  it("names what to fix for each upload rejection", () => {
    expect(quickLaunchAttachmentErrorMessageKey("attachment_too_large")).toBe("chrome.quickLaunch.errorAttachmentTooLarge");
    expect(quickLaunchAttachmentErrorMessageKey("attachment_unsupported")).toBe("chrome.quickLaunch.errorAttachmentUnsupported");
    expect(quickLaunchAttachmentErrorMessageKey("attachment_limit")).toBe("chrome.quickLaunch.errorAttachmentLimit");
    expect(quickLaunchAttachmentErrorMessageKey("attachment_storage_exhausted")).toBe("chrome.quickLaunch.errorAttachmentStorageExhausted");
    // 모르는 코드·네트워크 실패는 일반 업로드 실패 문구로 떨어진다 — 아무 말도 못 하는 상태를 만들지 않는다.
    expect(quickLaunchAttachmentErrorMessageKey("something_new")).toBe("chrome.quickLaunch.errorAttachmentUploadFailed");
    expect(quickLaunchAttachmentErrorMessageKey(null)).toBe("chrome.quickLaunch.errorAttachmentUploadFailed");
  });

  it("maps launch rejections that involve attachments", () => {
    expect(quickLaunchErrorMessageKey("attachment_not_found")).toBe("chrome.quickLaunch.errorAttachmentGone");
    expect(quickLaunchErrorMessageKey("attachment_limit")).toBe("chrome.quickLaunch.errorAttachmentLimit");
  });

  it("maps mention-delivery rejections that involve attachments", () => {
    // 멘션 채널도 같은 첨부 코드를 돌려준다 — 문구는 런치 거절과 공유한다.
    expect(quickLaunchMentionErrorMessageKey("attachment_not_found")).toBe("chrome.quickLaunch.errorAttachmentGone");
    expect(quickLaunchMentionErrorMessageKey("attachment_limit")).toBe("chrome.quickLaunch.errorAttachmentLimit");
  });

  it("declares every attachment key in both locales", () => {
    const chrome = readFileSync(resolve(process.cwd(), "core/client/src/i18n/messages/chrome.ts"), "utf8");
    const keys = [
      "chrome.quickLaunch.attachments",
      "chrome.quickLaunch.attachmentAdd",
      "chrome.quickLaunch.attachmentZoom",
      "chrome.quickLaunch.attachmentRemove",
      "chrome.quickLaunch.attachmentUploading",
      "chrome.quickLaunch.errorAttachmentTooLarge",
      "chrome.quickLaunch.errorAttachmentUnsupported",
      "chrome.quickLaunch.errorAttachmentLimit",
      "chrome.quickLaunch.errorAttachmentUploadFailed",
      "chrome.quickLaunch.errorAttachmentStorageExhausted",
      "chrome.quickLaunch.errorAttachmentGone",
    ];
    for (const key of keys) {
      expect(chrome.split(`"${key}":`).length - 1, key).toBe(2);
    }
  });

  it("keeps attachment traces in the draft slot until consumed", () => {
    // 초안 텍스트만 보존하면 거절·닫힘이 방금 붙여넣은 이미지를 조용히 버린다.
    const attachments = [{ id: "att-1", name: "shot.png", previewUrl: "blob:preview-1" }];
    reopenQuickLaunchWithDraft("fix the layout", "attachment_not_found", null, attachments);
    expect(getState().quickLaunchDraft).toBe("fix the layout");
    expect(getState().quickLaunchDraftAttachments).toEqual(attachments);
    consumeQuickLaunchDraft();
    expect(getState().quickLaunchDraft).toBeNull();
    expect(getState().quickLaunchDraftAttachments).toBeNull();
  });

  it("preserves attachment traces alongside an unsent draft", () => {
    const attachments = [{ id: "att-2", name: "mock.png", previewUrl: "blob:preview-2" }];
    preserveQuickLaunchDraft("compare against the mock", attachments);
    expect(getState().quickLaunchDraftAttachments).toEqual(attachments);
    // 첨부 없이 보존하면 슬롯의 옛 첨부도 함께 내려간다 — 텍스트와 첨부는 한 초안의 두 축이다.
    preserveQuickLaunchDraft("text only");
    expect(getState().quickLaunchDraftAttachments).toBeNull();
    consumeQuickLaunchDraft();
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

  it("keeps a pending Quick Launch aimed at a surviving Theater", () => {
    setState({
      theaters: [makeTheater("t1"), makeTheater("t2")],
      activeTheaterId: "t1",
      pendingQuickLaunch: {
        theaterId: "t2",
        pluginId: "terminal",
        kind: { id: "claude", type: "agent", title: "Claude" },
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

describe("readCommandInput", () => {
  it("opens only when / is the first character of the prompt", () => {
    expect(readCommandInput("/", 1)).toEqual({ kind: "commands", query: "" });
    expect(readCommandInput("/mo", 3)).toEqual({ kind: "commands", query: "mo" });
    expect(readCommandInput("run /model", 10)).toBeNull();
    expect(readCommandInput("", 0)).toBeNull();
  });

  it("stays closed when the caret sits before the slash", () => {
    expect(readCommandInput("/model", 0)).toBeNull();
  });

  it("lies down as a literal on a second slash — file paths never wake the deck", () => {
    expect(readCommandInput("/Users/sbluemin", 15)).toBeNull();
    expect(readCommandInput("/etc/hosts 확인", 13)).toBeNull();
  });

  it("enters the value level when the first word is a value command followed by whitespace", () => {
    expect(readCommandInput("/theater ", 9)).toEqual({ kind: "values", command: "theater", query: "" });
    expect(readCommandInput("/model sol", 10)).toEqual({ kind: "values", command: "model", query: "sol" });
    expect(readCommandInput("/effort xh", 10)).toEqual({ kind: "values", command: "effort", query: "xh" });
  });

  it("keeps value queries alive across spaces — model labels carry spaces", () => {
    expect(readCommandInput("/model gpt-5.6 sol", 18)).toEqual({ kind: "values", command: "model", query: "gpt-5.6 sol" });
  });

  it("treats an unknown first word with trailing text as prose", () => {
    expect(readCommandInput("/foo bar", 8)).toBeNull();
    // '/pin'은 값 레벨이 없는 액션 — 공백이 뒤따르면 명령이 아니라 프로즈다.
    expect(readCommandInput("/pin now", 8)).toBeNull();
  });

  it("stays at the value level when the caret returns into a committed command word", () => {
    expect(readCommandInput("/model sol", 3)).toEqual({ kind: "values", command: "model", query: "sol" });
  });

  it("anchors queries to the text, not the caret — Enter must match what the deck shows", () => {
    expect(readCommandInput("/model solx", 10)).toEqual({ kind: "values", command: "model", query: "solx" });
    // 기존 텍스트 앞에 '/'만 끼워 넣은 입력은 전체 단어가 쿼리다 — 매치가 없으면 프로즈로 흘러
    // 선택이 뒤 텍스트를 파괴하지 않는다.
    expect(readCommandInput("/hello", 1)).toEqual({ kind: "commands", query: "hello" });
  });
});

describe("buildQuickLaunchEffortDeck", () => {
  const row = {
    id: "fable",
    label: "Fable",
    launch: { model: "fable[1m]" },
    effortAxis: ["low", "medium", "high", "xhigh", "max", "ultra"],
    gatedEfforts: ["max", "ultra"],
    chips: [
      { id: "low", label: "LOW", launch: { model: "fable[1m]", effort: "low" } },
      { id: "high", label: "HIGH", launch: { model: "fable[1m]", effort: "high" } },
      { id: "max", label: "MAX", launch: { model: "fable[1m]", effort: "max" } },
      // production sentinel은 ultra다 — 칩 id가 곧 launch payload의 effort로 실린다.
      { id: "ultra", label: "ULTRACODE", launch: { model: "fable[1m]", effort: "ultra" } },
    ],
  } as const;

  /** 게이트 단을 하나도 내놓지 않는 모델 — 트랙에 ✦이 서지 않는 그 상태. */
  const plainRow = {
    id: "grok",
    label: "Grok",
    launch: { model: "cursor--grok-4.6-fast" },
    effortAxis: ["low", "medium", "high", "xhigh"],
    chips: [
      { id: "low", label: "LOW", launch: { model: "cursor--grok-4.6-fast", effort: "low" } },
      { id: "xhigh", label: "XHIGH", launch: { model: "cursor--grok-4.6-fast", effort: "xhigh" } },
    ],
  } as const;

  const ids = (deck: ReturnType<typeof buildQuickLaunchEffortDeck>) => deck.options.map((option) => option.id);

  it("hides gated apex tiers from the default list — the track's gate is mirrored", () => {
    expect(ids(buildQuickLaunchEffortDeck(row, null, "AUTO", "", false))).toEqual([null, "low", "high"]);
  });

  it("reveals a gated tier only when its name is typed from the start", () => {
    expect(ids(buildQuickLaunchEffortDeck(row, null, "AUTO", "ma", false))).toEqual(["max"]);
    expect(ids(buildQuickLaunchEffortDeck(row, null, "AUTO", "ultra", false))).toEqual(["ultra"]);
    // 우연한 부분 일치("l" ⊂ ULTRACODE)는 게이트를 열지 않는다.
    expect(ids(buildQuickLaunchEffortDeck(row, null, "AUTO", "l", false))).toEqual(["low"]);
  });

  it("keeps the gate open while the current effort is a gated tier", () => {
    const deck = buildQuickLaunchEffortDeck(row, "max", "AUTO", "", false);
    expect(ids(deck)).toEqual([null, "low", "high", "max", "ultra"]);
    expect(deck.options.find((option) => option.id === "max")?.checked).toBe(true);
    // 고른 값이 게이트를 붙들고 있으면 문 행은 서지 않는다 — 접어도 접히지 않을 컨트롤이다.
    expect(deck.gateHeldByValue).toBe(true);
  });

  it("opens every gated tier when the gate row is opened", () => {
    const deck = buildQuickLaunchEffortDeck(row, null, "AUTO", "", true);
    expect(ids(deck)).toEqual([null, "low", "high", "max", "ultra"]);
    expect(deck.gateOpen).toBe(true);
    expect(deck.gateHeldByValue).toBe(false);
  });

  it("drops the gate row while a query is typed — an unmatched query must stay submittable prose", () => {
    // 문 행이 남으면 매치 0인 질의에서도 덱이 비지 않아, Enter가 제출 대신 게이트를 여닫는다.
    expect(buildQuickLaunchEffortDeck(row, null, "AUTO", "", false).showGateRow).toBe(true);
    expect(buildQuickLaunchEffortDeck(row, null, "AUTO", "zebra", false).showGateRow).toBe(false);
    expect(ids(buildQuickLaunchEffortDeck(row, null, "AUTO", "zebra", false))).toEqual([]);
    // 공백만 친 질의는 아직 질의가 아니다.
    expect(buildQuickLaunchEffortDeck(row, null, "AUTO", "  ", false).showGateRow).toBe(true);
    // 게이트가 열려 있어도 질의 중에는 서지 않는다 — 좁힌 목록 위의 "펼치기"는 필터와 모순된다.
    expect(buildQuickLaunchEffortDeck(row, null, "AUTO", "ma", true).showGateRow).toBe(false);
  });

  it("hides the gate row while the selected value holds the gate open", () => {
    expect(buildQuickLaunchEffortDeck(row, "max", "AUTO", "", false).showGateRow).toBe(false);
  });

  it("marks gated tiers as apex so the deck can split MAX's ember from a plain max", () => {
    const deck = buildQuickLaunchEffortDeck(row, null, "AUTO", "", true);
    expect(deck.options.filter((option) => option.apex).map((option) => option.id)).toEqual(["max", "ultra"]);
  });

  it("reports no gate when the model offers no gated tier — 'absent' must not look like 'collapsed'", () => {
    const deck = buildQuickLaunchEffortDeck(plainRow, null, "AUTO", "", false);
    expect(deck.hasGate).toBe(false);
    expect(deck.gateOpen).toBe(false);
    expect(ids(deck)).toEqual([null, "low", "xhigh"]);
    // 열어 달라고 해도 열 문이 없다.
    expect(buildQuickLaunchEffortDeck(plainRow, null, "AUTO", "", true).hasGate).toBe(false);
  });

  it("counts only offered gated tiers — an axis-only rung raises no door", () => {
    const axisOnly = { ...plainRow, gatedEfforts: ["max", "ultra"] } as const;
    expect(buildQuickLaunchEffortDeck(axisOnly, null, "AUTO", "", false).hasGate).toBe(false);
  });

  it("names the gate from what this deck opens, never from the track's ladder", () => {
    // 이 덱은 chips에 실린 단만 행으로 낸다. 축에만 오른 게이트 단까지 이름에 실으면
    // "XHIGH·MAX 펼치기"라 해 놓고 열었을 때 MAX만 서는, 문구가 거짓이 되는 상태가 된다.
    expect(buildQuickLaunchEffortDeck(row, null, "AUTO", "", false).gatedNames).toBe("MAX·ULTRACODE");
    const axisOnlyRung = {
      ...plainRow,
      effortAxis: ["low", "medium", "high", "xhigh", "max"],
      gatedEfforts: ["xhigh", "max"],
      chips: [
        { id: "low", label: "LOW", launch: { model: "cursor--grok-4.6-fast", effort: "low" } },
        { id: "max", label: "MAX", launch: { model: "cursor--grok-4.6-fast", effort: "max" } },
      ],
    } as const;
    const deck = buildQuickLaunchEffortDeck(axisOnlyRung, null, "AUTO", "", true);
    expect(deck.gatedNames).toBe("MAX");
    expect(ids(deck)).toEqual([null, "low", "max"]);
    // 게이트가 없는 행은 이름도 비어 있다 — 문 행 자체가 서지 않으므로 쓰이지 않는다.
    expect(buildQuickLaunchEffortDeck(plainRow, null, "AUTO", "", false).gatedNames).toBe("");
  });

  it("gates ultra alone on a MAX-less row and stands a gate on an ultra-only row", () => {
    // MAX를 건너뛴 gateway 행 — 게이트는 ULTRACODE 하나만 연다.
    const maxLessRow = {
      ...plainRow,
      effortAxis: ["low", "medium", "high", "xhigh", "ultra"],
      gatedEfforts: ["ultra"],
      chips: [
        ...plainRow.chips,
        { id: "ultra", label: "ULTRACODE", launch: { model: "cursor--grok-4.6-fast", effort: "ultra" } },
      ],
    } as const;
    const maxLess = buildQuickLaunchEffortDeck(maxLessRow, null, "AUTO", "", false);
    expect(maxLess.hasGate).toBe(true);
    expect(maxLess.gatedNames).toBe("ULTRACODE");
    expect(ids(maxLess)).toEqual([null, "low", "xhigh"]);
    expect(ids(buildQuickLaunchEffortDeck(maxLessRow, null, "AUTO", "", true))).toEqual([null, "low", "xhigh", "ultra"]);

    // 강도 미지원 모델의 ULTRACODE 단독 행 — 자동 외에 고를 값은 게이트 뒤의 ultra뿐이다.
    const ultraOnlyRow = {
      id: "auto",
      label: "Auto",
      launch: { model: "cursor--auto" },
      effortAxis: ["ultra"],
      gatedEfforts: ["ultra"],
      chips: [{ id: "ultra", label: "ULTRACODE", launch: { model: "cursor--auto", effort: "ultra" } }],
    } as const;
    const ultraOnly = buildQuickLaunchEffortDeck(ultraOnlyRow, null, "AUTO", "", false);
    expect(ultraOnly.hasGate).toBe(true);
    expect(ids(ultraOnly)).toEqual([null]);
    const opened = buildQuickLaunchEffortDeck(ultraOnlyRow, "ultra", "AUTO", "", false);
    // 고른 값이 게이트 단이면 게이트를 붙들고 전부 보인다 — 문 행은 서지 않는다.
    expect(opened.gateHeldByValue).toBe(true);
    expect(ids(opened)).toEqual([null, "ultra"]);
    expect(opened.options.find((option) => option.id === "ultra")?.checked).toBe(true);
  });

  it("maps the ultra deck option onto the production launch payload", () => {
    // 덱 option의 id는 행 칩의 id다 — 픽하면 그 칩이 실은 launch가 실행 페이로드가 되므로,
    // 열린 ultra option은 production sentinel 계약 { model, effort: "ultra" }에 붙어 있어야 한다.
    const deck = buildQuickLaunchEffortDeck(row, null, "AUTO", "", true);
    const ultra = deck.options.find((option) => option.id === "ultra");
    expect(ultra).toBeDefined();
    expect(row.chips.find((chip) => chip.id === ultra!.id)?.launch)
      .toEqual({ model: "fable[1m]", effort: "ultra" });
  });

  it("marks the checked option and survives a missing row", () => {
    const deck = buildQuickLaunchEffortDeck(row, "high", "AUTO", "", false);
    expect(deck.options.find((option) => option.id === "high")?.checked).toBe(true);
    expect(buildQuickLaunchEffortDeck(null, null, "AUTO", "", false)).toEqual({
      options: [{ id: null, label: "AUTO", checked: true, apex: false }],
      hasGate: false,
      gateOpen: false,
      gateHeldByValue: false,
      showGateRow: false,
      gatedNames: "",
    });
  });
});

describe("isMentionSelectable", () => {
  it("blocks awaiting only — ended resumes on delivery", () => {
    expect(isMentionSelectable("awaiting")).toBe(false);
    for (const activity of ["idle", "running", "ended", "background"] as const) {
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
      operationRuntime: { "op-live": { lifecycle: "live", activity: "running" } as const },
    };
    const groups = buildQuickLaunchMentionGroups(state, MESSAGEABLE, "");
    expect(groups.map((group) => group.theaterId)).toEqual(["th-a", "th-b"]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.operationId))).toEqual(["op-live", "op-dormant"]);
    expect(groups[0]?.entries[0]?.activity).toBe("running");
    expect(groups[1]?.entries[0]?.activity).toBe("ended");
  });

  it("filters by query across name and theater label", () => {
    const state = {
      ...getState(),
      theaters: [makeTheater("th-a")],
      operations: [makeOperation("gateway sweep", { title: "gateway sweep" }), makeOperation("docs run", { title: "docs run" })],
      operationRuntime: {},
    };
    const groups = buildQuickLaunchMentionGroups(state, MESSAGEABLE, "gate");
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.operationName))).toEqual(["gateway sweep"]);
  });
});

describe("resolveFocusedMention", () => {
  it("returns the active mentionable Operation and skips the rest", () => {
    const state = {
      ...getState(),
      theaters: [makeTheater("th-a")],
      operations: [
        makeOperation("op-live"),
        makeOperation("op-shell", { type: "shell" }),
        makeOperation("op-await", { id: "op-await" }),
      ],
      operationRuntime: { "op-await": { lifecycle: "live", activity: "awaiting" } as const },
      operationsViewActive: true,
      activeTheaterId: "th-a",
      activeOperationId: "op-live",
    };
    expect(resolveFocusedMention(state, MESSAGEABLE)?.operationId).toBe("op-live");

    expect(resolveFocusedMention({ ...state, activeOperationId: null }, MESSAGEABLE)).toBeNull();
    expect(resolveFocusedMention({ ...state, activeOperationId: "op-shell" }, MESSAGEABLE)).toBeNull();
    expect(resolveFocusedMention({ ...state, activeOperationId: "op-await" }, MESSAGEABLE)).toBeNull();
    expect(resolveFocusedMention({ ...state, activeOperationId: "op-missing" }, MESSAGEABLE)).toBeNull();
  });

  it("skips a leftover active id when Operations is not in view or Theater has moved", () => {
    const state = {
      ...getState(),
      theaters: [makeTheater("th-a"), makeTheater("th-b")],
      operations: [makeOperation("op-live"), makeOperation("op-other", { theaterId: "th-b" })],
      operationsViewActive: true,
      activeTheaterId: "th-a",
      activeOperationId: "op-live",
    };
    expect(resolveFocusedMention({ ...state, operationsViewActive: false }, MESSAGEABLE)).toBeNull();
    expect(resolveFocusedMention({ ...state, activeTheaterId: "th-b" }, MESSAGEABLE)).toBeNull();
    expect(resolveFocusedMention({ ...state, activeTheaterId: "th-b" }, MESSAGEABLE, "op-other")).toBeNull();
  });

  it("allows a foreign-Theater id when it is the live War Room stage", () => {
    const state = {
      ...getState(),
      theaters: [makeTheater("th-a"), makeTheater("th-b")],
      operations: [makeOperation("op-home"), makeOperation("op-stage", { theaterId: "th-b" })],
      operationsViewActive: true,
      activeTheaterId: "th-a",
      activeOperationId: "op-stage",
    };
    expect(resolveFocusedMention(state, MESSAGEABLE)).toBeNull();
    expect(resolveFocusedMention(state, MESSAGEABLE, "op-home")).toBeNull();
    expect(resolveFocusedMention(state, MESSAGEABLE, "op-stage")?.operationId).toBe("op-stage");
  });
});

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

  it("resolves a messageable Operation by id", () => {
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-live")?.operationId).toBe("op-live");
  });

  it("refuses a type that takes no messages, an Operation waiting on its own prompt, and an unknown id", () => {
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-shell")).toBeNull();
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-await")).toBeNull();
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-missing")).toBeNull();
  });

  it("keeps addressing an Operation outside the active Theater", () => {
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-far")?.operationId).toBe("op-far");
    // 같은 대상을 포커스 경로로 읽으면 Theater 가드에 걸린다 — 두 경로의 유일한 차이다.
    expect(resolveFocusedMention(
      { ...state, operationsViewActive: true, activeOperationId: "op-far" },
      MESSAGEABLE,
    )).toBeNull();
  });
});

describe("shouldApplyFocusedMention", () => {
  const on = { prefOn: true, leftoverDraft: false, mentionAlreadySet: false, promptOccupied: false };

  it("applies only when the opt-in is on and the composer is empty", () => {
    expect(shouldApplyFocusedMention(on)).toBe(true);
    expect(shouldApplyFocusedMention({ ...on, prefOn: false })).toBe(false);
    expect(shouldApplyFocusedMention({ ...on, leftoverDraft: true })).toBe(false);
    expect(shouldApplyFocusedMention({ ...on, mentionAlreadySet: true })).toBe(false);
    expect(shouldApplyFocusedMention({ ...on, promptOccupied: true })).toBe(false);
  });
});

describe("openQuickLaunchForOperation", () => {
  beforeEach(() => {
    setState({
      quickLaunchOpen: false,
      quickLaunchPinned: false,
      quickLaunchFocusToggle: 0,
      quickLaunchExpandRequest: 0,
      quickLaunchDockSuppressed: false,
      quickLaunchError: null,
      quickLaunchErrorShortenBy: null,
      quickLaunchDraft: "leftover from last close",
      quickLaunchDraftAttachments: null,
      quickLaunchMentionSeed: null,
    });
  });

  it("opens the modal with the mention seed in one transition", () => {
    openQuickLaunchForOperation("op-chat");

    expect(getState().quickLaunchOpen).toBe(true);
    expect(getState().quickLaunchMentionSeed).toBe("op-chat");
    expect(getState().quickLaunchExpandRequest).toBe(0);
  });

  it("routes a seeded open to the dock instead of raising the modal-open flag", () => {
    setQuickLaunchPinned(true);
    const before = getState().quickLaunchExpandRequest;

    openQuickLaunchForOperation("op-chat");

    expect(getState().quickLaunchOpen).toBe(false);
    expect(getState().quickLaunchMentionSeed).toBe("op-chat");
    expect(getState().quickLaunchExpandRequest).toBe(before + 1);
  });
});

describe("mention rejection messages", () => {
  it("maps delivery codes onto message keys with a generic fallback", () => {
    expect(quickLaunchMentionErrorMessageKey("resume_unavailable")).toBe("chrome.quickLaunch.mentionErrorResumeUnavailable");
    expect(quickLaunchMentionErrorMessageKey("session_awaiting_input")).toBe("chrome.quickLaunch.mentionErrorAwaiting");
    expect(quickLaunchMentionErrorMessageKey("session_not_found")).toBe("chrome.quickLaunch.mentionErrorGone");
    expect(quickLaunchMentionErrorMessageKey("prompt_too_long")).toBe("chrome.quickLaunch.errorTooLong");
    expect(quickLaunchMentionErrorMessageKey("gateway_model_not_enabled")).toBe("chrome.quickLaunch.errorModelOff");
    // 답하는 중인 행선지의 거절은 일반 전달 실패로 뭉개면 안 된다 — 기다리면 되는 상황이다.
    expect(quickLaunchMentionErrorMessageKey("destination_busy")).toBe("chrome.quickLaunch.mentionErrorBusy");
    expect(quickLaunchMentionErrorMessageKey("terminal_unavailable")).toBe("chrome.quickLaunch.mentionErrorDeliveryFailed");
    expect(quickLaunchMentionErrorMessageKey(null)).toBe("chrome.quickLaunch.mentionErrorDeliveryFailed");
  });

  it("declares every mention key in both locales", () => {
    // 새 키가 한쪽 로케일에만 들어가면 다른 언어에서 키 문자열이 그대로 화면에 뜬다.
    const chrome = readFileSync(resolve(process.cwd(), "core/client/src/i18n/messages/chrome.ts"), "utf8");
    const keys = [
      "chrome.quickLaunch.mentionDeck",
      "chrome.quickLaunch.mentionCategoryOperations",
      "chrome.quickLaunch.mentionNoMatch",
      "chrome.quickLaunch.mentionPlaceholder",
      "chrome.quickLaunch.mentionTarget",
      "chrome.quickLaunch.mentionPlaceholderOther",
      "chrome.quickLaunch.mentionTargetOther",
      "chrome.quickLaunch.errorMentionAttachments",
      "chrome.quickLaunch.mentionErrorBusy",
      "chrome.quickLaunch.mentionErrorResumeUnavailable",
      "chrome.quickLaunch.mentionErrorAwaiting",
      "chrome.quickLaunch.mentionErrorGone",
      "chrome.quickLaunch.mentionErrorDeliveryFailed",
      "chrome.quickLaunch.mentionFocusOn",
      "chrome.quickLaunch.mentionFocusOff",
    ];
    for (const key of keys) {
      expect(chrome.split(`"${key}":`).length - 1, key).toBe(2);
    }
  });
});

describe("quick launch ultracode recognition", () => {
  it("matches the word regardless of case", () => {
    expect(readUltracodeTokens("ultracode")).toEqual([{ start: 0, end: 9 }]);
    expect(readUltracodeTokens("ULTRACODE")).toEqual([{ start: 0, end: 9 }]);
    expect(readUltracodeTokens("UltraCode")).toEqual([{ start: 0, end: 9 }]);
  });

  it("only matches on word boundaries", () => {
    // 식별자 문자로 이어 붙은 것은 다른 단어다 — 프롬프트에 경로 하나 실었다고 무장하면 안 된다.
    expect(readUltracodeTokens("ultracoder")).toEqual([]);
    expect(readUltracodeTokens("myultracode")).toEqual([]);
    expect(readUltracodeTokens("ultracode_notes")).toEqual([]);
    // 하이픈·마침표·괄호는 경계다.
    expect(readUltracodeTokens("run-ultracode.")).toEqual([{ start: 4, end: 13 }]);
  });

  it("finds every occurrence in the draft", () => {
    expect(readUltracodeTokens("ultracode then ULTRACODE")).toEqual([
      { start: 0, end: 9 },
      { start: 15, end: 24 },
    ]);
  });

  it("disarms only when the caret sits right after a recognized token", () => {
    const draft = "do it ultracode now";
    expect(isUltracodeDisarmCaret(draft, 15, 15)).toBe(true);
    // 토큰 안, 토큰 앞, 문장 끝은 평범한 삭제다.
    expect(isUltracodeDisarmCaret(draft, 14, 14)).toBe(false);
    expect(isUltracodeDisarmCaret(draft, 6, 6)).toBe(false);
    expect(isUltracodeDisarmCaret(draft, draft.length, draft.length)).toBe(false);
    // 선택 구간이 있는 Backspace는 선택을 지우는 조작이지 해제가 아니다.
    expect(isUltracodeDisarmCaret(draft, 6, 15)).toBe(false);
  });

  it("keeps the ignore flag until the word leaves the draft entirely", () => {
    // 껐다는 사실이 편집마다 뒤집히면 그 스위치는 못 믿는다.
    expect(nextUltracodeIgnored("do it ultracode", true)).toBe(true);
    expect(nextUltracodeIgnored("do it ultracode now, please", true)).toBe(true);
    // 단어가 전부 사라지면 해제도 만료한다 — 다시 친 단어는 새 의사표시다.
    expect(nextUltracodeIgnored("do it", true)).toBe(false);
    expect(nextUltracodeIgnored("do it ultracode", false)).toBe(false);
  });

  it("declares every ultracode key in both locales", () => {
    const chrome = readFileSync(resolve(process.cwd(), "core/client/src/i18n/messages/chrome.ts"), "utf8");
    const keys = [
      "chrome.quickLaunch.ultracodeNotice",
      "chrome.quickLaunch.ultracodeNoticeHint",
    ];
    for (const key of keys) {
      expect(chrome.split(`"${key}":`).length - 1, key).toBe(2);
    }
    // 칩을 바에서 빼면 칩용 dismiss 문구도 같이 사라진다 — 고지 줄이 상태를 말한다.
    expect(chrome).not.toContain("chrome.quickLaunch.ultracodeDismiss");
  });
});

describe("plugin mention targets", () => {
  const aides = {
    id: "scuttlebutt",
    mentionTargets: () => [
      { id: "tori", label: "토리 부관", categoryLabel: "부관", capabilityLabel: "웹 전용", description: "웹 전용" },
      { id: "bori", label: "보리 부관", categoryLabel: "부관", capabilityLabel: "웹 전용" },
    ],
    messageMentionTarget: async () => {},
  };

  it("groups a plugin's targets under its own category and namespaces the option id", () => {
    const [category] = buildPluginMentionCategories([aides], "");
    expect(category?.label).toBe("부관");
    expect(category?.capabilityLabel).toBe("웹 전용");
    expect(category?.rows.map((row) => row.optionId)).toEqual(["scuttlebutt:tori", "scuttlebutt:bori"]);
    expect(category?.rows[0]?.targetId).toBe("tori");
  });

  it("filters by the same tokens the Operation rows use", () => {
    expect(buildPluginMentionCategories([aides], "보리")[0]?.rows).toHaveLength(1);
    expect(buildPluginMentionCategories([aides], "없는이름")).toEqual([]);
  });

  // 목록에만 서고 받지 못하는 행선지는 고르는 순간 막다른 길이 된다 — Operation 쪽 짝 조건과 같다.
  it("ignores a plugin that declares only one half of the contract", () => {
    expect(buildPluginMentionCategories([{ id: "half", mentionTargets: aides.mentionTargets }], "")).toEqual([]);
    expect(buildPluginMentionCategories([{ id: "half", messageMentionTarget: async () => {} }], "")).toEqual([]);
  });

  // 로스터를 읽다 던지는 플러그인 하나가 덱 전체를 무너뜨리면 Operation 멘션까지 함께 죽는다.
  it("drops a plugin whose roster read throws and keeps the rest", () => {
    const broken = {
      id: "broken",
      mentionTargets: () => { throw new Error("boom"); },
      messageMentionTarget: async () => {},
    };
    const categories = buildPluginMentionCategories([broken, aides], "");
    expect(categories.map((category) => category.label)).toEqual(["부관"]);
  });

  it("keeps two plugins apart even when they choose the same category text", () => {
    const twin = { ...aides, id: "twin" };
    const categories = buildPluginMentionCategories([aides, twin], "");
    expect(categories).toHaveLength(2);
    expect(categories.map((category) => category.rows[0]?.pluginId)).toEqual(["scuttlebutt", "twin"]);
  });

  it("names either destination kind through one helper", () => {
    const [category] = buildPluginMentionCategories([aides], "");
    expect(mentionTargetName({ kind: "plugin", row: category!.rows[0]! })).toBe("토리 부관");
    expect(mentionTargetName({
      kind: "operation",
      entry: {
        operationId: "op1",
        theaterId: "t1",
        theaterLabel: "t1",
        type: "terminal",
        operationName: "refactor deck",
        pluginId: "terminal",
        activity: "idle",
        launchProvider: null,
      },
    })).toBe("refactor deck");
  });
});
