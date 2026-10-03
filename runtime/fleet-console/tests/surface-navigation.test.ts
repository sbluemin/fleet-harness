// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { PaneDescriptor } from "@fleet-console/sdk/pane";
import { parseFileRef, isAbsolute } from "@fleet-console/markdown/file-ref";
import { createHostCapabilities, createHostPaneTargetPorts } from "../core/client/src/integration/plugin-capabilities.js";
import { landPaneTarget, type PaneTargetBinding } from "../core/client/src/chrome/pane/pane-target.js";
import { getPaneStoreSnapshot, __resetPaneStoreForTests } from "../core/client/src/chrome/pane/pane-store.js";
import { getRailStoreSnapshot } from "../core/client/src/chrome/rail/rail-store.js";
import { getState, setState } from "../core/client/src/integration/store.js";
import { bindConsoleNavigate } from "../core/client/src/integration/console-location.js";

// 기존 팔레트·컴포저 검사는 외부 처리기의 Theater 착지와 재요청을 실행하지 않는다.
// 이 대표 경로는 SDK 요청과 팔레트가 같은 저장소 경계에서 주소를 보존하는지 확인한다.
afterEach(() => { __resetPaneStoreForTests(); });

it("lands SDK and palette targets in the requested Theater with a fresh request id", async () => {
  const unbind = bindConsoleNavigate(() => undefined);
  setState({ theaters: ["a", "b"].map((id) => ({ id, label: id, createdAt: "now", lastOpenedAt: "now", hasWiki: false, activeAdmiralCount: 0 })), activeTheaterId: "a" });
  const pane: PaneDescriptor = { id: "file-doc", role: "detail", mounts: ["rail"], title: () => "File", render: () => null };
  const bindings: PaneTargetBinding[] = [{ entry: { id: "files", title: "Files", icon: null, panes: [pane.id], handles: { openFile: () => ({ paneId: pane.id }) } }, panes: [pane] }];
  const host = createHostCapabilities(undefined, { railBindings: bindings });
  try {
    const request = { theaterId: "b", path: "src/main.ts", pathKind: "theater-relative" as const, line: 12, column: 3, source: "agent-chat" as const };
    expect(await host.navigate.openFile(request)).toEqual({ ok: true });
    const first = getPaneStoreSnapshot().rail[0]!;
    expect(getState().activeTheaterId).toBe("b");
    expect(getRailStoreSnapshot().activePanelId).toBe("files");
    expect(first.params).toMatchObject({ theaterId: "b", path: "src/main.ts", pathKind: "theater-relative", line: "12", column: "3" });
    expect(await host.navigate.openFile(request)).toEqual({ ok: true });
    expect(getPaneStoreSnapshot().rail[0]!.params.requestId).not.toBe(first.params.requestId);
    expect(landPaneTarget({ paneId: pane.id, theaterId: "a", params: { path: "README.md" } }, createHostPaneTargetPorts(bindings), "files")).toEqual({ ok: true });
    expect(getState().activeTheaterId).toBe("a");
    expect(getPaneStoreSnapshot().rail[0]!.params).toMatchObject({ theaterId: "a", path: "README.md" });

    const settings = { ...pane, id: "settings", role: "primary" as const };
    const settingsHost = createHostCapabilities(undefined, { railBindings: [{ entry: { id: "settings", title: "Settings", icon: null, panes: ["settings"] }, panes: [settings] }] });
    settingsHost.rail.open("settings", { section: "experiments" });
    expect(getPaneStoreSnapshot().rail.find((item) => item.paneId === "settings")?.params.section).toBe("experiments");
    expect(await createHostCapabilities().navigate.openFile(request)).toEqual({ ok: false, reason: "no_handler" });
    expect(await createHostCapabilities().navigate.openWikiEntry({ theaterId: "a", entryId: "entry" })).toEqual({ ok: false, reason: "no_handler" });
  } finally { unbind(); }
});

it("keeps file coordinates separate from schemes and absolute-path classification", () => {
  expect(parseFileRef('("src/main.ts:12:3"),')).toEqual({ path: "src/main.ts", line: 12, column: 3 });
  const absolute = parseFileRef("C:\\work\\main.ts(12,3)");
  expect(absolute).toEqual({ path: "C:/work/main.ts", line: 12, column: 3 });
  expect(isAbsolute(absolute!)).toBe(true);
  expect(parseFileRef("src/main.ts#L12C3")).toEqual({ path: "src/main.ts", line: 12, column: 3 });
  expect(parseFileRef("https://example.com/main.ts:12")).toBeNull();
  expect(parseFileRef("main.ts:0")).toBeNull();
});
