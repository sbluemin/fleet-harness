// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Terminal, type ILink } from "@xterm/xterm";
import { createFileLinkProvider } from "../features/execution/client/terminal/shared/terminal-file-links.js";
import type { PaneDescriptor } from "@fleet-console/sdk/pane";
import { parseFileRef, isAbsolute } from "@fleet-console/markdown/file-ref";
import { createHostCapabilities, createHostPaneTargetPorts } from "../core/client/src/integration/plugin-capabilities.js";
import { landPaneTarget, type PaneTargetBinding } from "../core/client/src/chrome/pane/pane-target.js";
import { getPaneStoreSnapshot, __resetPaneStoreForTests } from "../core/client/src/chrome/pane/pane-store.js";
import { getRailStoreSnapshot } from "../core/client/src/chrome/rail/rail-store.js";
import { getState, setState } from "../core/client/src/integration/store.js";
import { bindConsoleNavigate } from "../core/client/src/integration/console-location.js";
import { searchRailPanels } from "../core/client/src/integration/operation-search.js";

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
    const queries: string[] = [];
    const results = await searchRailPanels([{ id: "files", title: "Files", fileReferences: true, search: async ({ query }) => {
      queries.push(query);
      return [
        { id: "fuzzy", title: "Other", activate: () => ({ paneId: pane.id }) },
        { id: "exact", title: "main.ts", exact: true, activate: () => ({ paneId: pane.id, theaterId: "b", params: { path: query } }) },
      ];
    } }], "src/main.ts:12:3", "b", new AbortController().signal);
    expect(queries).toEqual(["src/main.ts"]);
    expect(results[0]!.results[0]!.exact).toBe(true);
    const target = await results[0]!.results[0]!.activate();
    expect(target).toBeTruthy();
    landPaneTarget(target!, createHostPaneTargetPorts(bindings), "files");
    expect(getPaneStoreSnapshot().rail[0]!.params).toMatchObject({ theaterId: "b", path: "src/main.ts", line: "12", column: "3" });

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

// 경로 파서 검사만으로는 터미널의 공백 토큰화와 셀 범위가 실제 open 대상에 미치는 영향을 잡지 못한다.
// production provider에서 대표 입력·과포획 방어·수정키 gate를 한 경계로 확인한다.
it("opens complete absolute file references without absorbing prose or neighboring paths", async () => {
  const terminal = new Terminal({ cols: 400, rows: 16, allowProposedApi: true });
  // DOM selection manager는 open 뒤 생긴다. 여기서는 gate를 검사하고 실제 드래그는 앱에서 검증한다.
  const hasSelection = vi.spyOn(terminal, "hasSelection").mockReturnValue(false);
  const windows = String.raw`C:\Users\hbkang\Desktop\99. Cowork\PPW_플랫폼서비스_설정기능_사전점의_체크리스트_20261007.md`;
  const posix = "/workspace/other notes/check.md";
  const lines = [
    `${windows} 뒤에 이어지는 일반 문장 and/or`,
    `두 경로: ${windows} 그리고 ${posix} 이어서 설명`,
    `(C:\\a b\\c.md), "C:\\d e\\f.md", '/g h/i.md', 다음 문장`,
    "src/a.ts:10:9 ./b.ts(3,1) src/c.ts#L4 and/or",
    "Saved to /Users/a/notes and opened report.md",
    "/etc/hosts file then edit x.md",
    "A / B test.md and/or",
    "yes / no, see c.md",
    String.raw`C:\notes\자기계발 노트.md 뒤의 설명`,
  ];
  const expected = [
    [windows],
    [windows, posix],
    ["C:\\a b\\c.md", "C:\\d e\\f.md", "/g h/i.md"],
    ["src/a.ts:10:9", "./b.ts(3,1)", "src/c.ts#L4"],
    ["/Users/a/notes"],
    ["/etc/hosts"],
    [],
    [],
    [String.raw`C:\notes\자기계발 노트.md`],
  ];
  const open = vi.fn(async () => ({ ok: true as const }));
  const onOutcome = vi.fn();
  const provider = createFileLinkProvider(terminal, {
    source: () => ({ context: () => ({ theaterId: "a", cwdRelative: "src" }), open }),
    isMac: true, onHover: () => undefined, onOutcome,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(lines.join("\r\n"), resolve));
    const allLinks: ILink[][] = [];
    for (let index = 0; index < lines.length; index++) {
      const links = await new Promise<ILink[]>((resolve) => provider.provideLinks(index + 1, (result) => resolve(result ?? [])));
      allLinks.push(links);
      expect(links.map((link) => link.text)).toEqual(expected[index]);
      const line = terminal.buffer.active.getLine(index)!;
      for (const link of links) {
        expect(line.translateToString(false, link.range.start.x - 1, link.range.end.x)).toBe(link.text);
        const start = lines[index]!.indexOf(link.text);
        expect(line.translateToString(false, 0, link.range.start.x - 1)).toBe(lines[index]!.slice(0, start));
        expect(line.translateToString(true, link.range.end.x)).toBe(lines[index]!.slice(start + link.text.length));
      }
    }
    const link = allLinks[0]![0]!;
    const plain = new MouseEvent("mouseup", { detail: 1, cancelable: true });
    link.activate(plain, link.text);
    expect(plain.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenLastCalledWith({ ok: false, reason: "activation_required" });
    onOutcome.mockClear();
    hasSelection.mockReturnValue(true);
    link.activate(new MouseEvent("mouseup", { detail: 1 }), link.text);
    expect(onOutcome).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    hasSelection.mockReturnValue(false);
    const modified = new MouseEvent("mouseup", { detail: 1, metaKey: true, cancelable: true });
    link.activate(modified, link.text);
    expect(modified.defaultPrevented).toBe(true);
    expect(open).toHaveBeenLastCalledWith({ theaterId: "a", path: windows.replaceAll("\\", "/"), pathKind: "absolute" });
    const relative = allLinks[3]![0]!;
    relative.activate(modified, relative.text);
    expect(open).toHaveBeenLastCalledWith({ theaterId: "a", path: "src/src/a.ts", pathKind: "theater-relative", line: 10, column: 9 });
    await Promise.resolve();
    expect(onOutcome).toHaveBeenLastCalledWith({ ok: true });
  } finally { terminal.dispose(); }
});
