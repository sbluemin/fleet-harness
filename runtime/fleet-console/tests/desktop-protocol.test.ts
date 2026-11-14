import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { formatDesktopResourceRootMarker, isDesktopResourceRootMarkerValid } from "@fleet-console/protocol/desktop";
import {
  CONSOLE_OBJECTIVE_PEEK_MAX_BYTES,
  isConsoleObjectivePeek,
  isConsoleObjectivePeekReply,
  isConsoleRosterSummary,
  parseConsoleSectionCommand,
} from "../protocol/desktop/console-section.js";

import {
  DESKTOP_DEVELOPMENT_ENV,
  DESKTOP_OWNER_ID_ENV,
  DESKTOP_OWNER_KIND_ENV,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION_ENV,
  DESKTOP_RESOURCE_ROOT_ENV,
  DESKTOP_RESOURCE_ROOT_MARKER,
  isCompatibleDesktopOwner,
  readDesktopProtocolEnvironment,
  resolveCanonicalLocalConsolePaths,
  resolveCanonicalStableConsolePaths,
} from "../core/host/shell/desktop-protocol.js";

const TEMP_DIRS: string[] = [];
const CONSOLE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("desktop protocol", () => {
  it("shares the version-1 resource-root marker formatter and trim-tolerant validator", () => {
    expect(formatDesktopResourceRootMarker()).toBe("1\n");
    expect(isDesktopResourceRootMarkerValid("1\n")).toBe(true);
    expect(isDesktopResourceRootMarkerValid(" \t1\r\n")).toBe(true);
    expect(isDesktopResourceRootMarkerValid("2\n")).toBe(false);
  });

  it("keeps the shared contract free of host and filesystem ownership", () => {
    const source = fs.readFileSync(path.join(CONSOLE_PACKAGE_ROOT, "protocol", "desktop", "index.ts"), "utf8");

    expect(source).not.toMatch(/node:(?:fs|child_process)/);
    expect(source).not.toMatch(/(?:@dotobokuri\/|fleet-desktop|fleet-plugins)/);
    expect(source).not.toMatch(/\b(?:process|electron)\b/);
    expect(source).not.toContain("desktopThemeSnapshot");
  });

  it("validates the objective peek snapshot, reply, command and roster flag", () => {
    const snapshot = {
      v: 1, id: "obj-1", title: "원격 목표", note: "첫째\n둘째", phase: "active",
      criteria: [{ text: "된다", met: true }, { text: "판정 전", met: false }],
      missions: [{ title: "한다", text: "한다\n자세히", done: false, assignee: "일꾼", premises: [1], records: ["끝", "남은 일"] }],
      members: [{ role: "일꾼", brief: "맡는다", model: "모델", run: "working" }],
      results: [
        { kind: "pr", label: "고침", url: "https://github.com/o/r/pull/1" },
        { kind: "evidence", name: "shot.png", mediaType: "image/png", bytes: 10 },
        { kind: "artifact", url: "https://claude.ai/artifact/abc-def_ghi0123456789" },
      ],
    };
    expect(isConsoleObjectivePeek(snapshot)).toBe(true);
    expect(isConsoleObjectivePeek({ ...snapshot, truncated: true })).toBe(true);
    expect(isConsoleObjectivePeekReply({ nonce: "n", console: "c", objective: "obj-1", status: "ok", snapshot })).toBe(true);
    expect(isConsoleObjectivePeekReply({ nonce: "n", console: "c", objective: "obj-1", status: "ok" })).toBe(false);
    expect(isConsoleObjectivePeekReply({ nonce: "n", console: "c", objective: "obj-1", status: "not_found" })).toBe(true);
    expect(isConsoleObjectivePeekReply({ nonce: "n", console: "c", objective: "obj-1", status: "not_found", snapshot })).toBe(false);
    // 여러 문단은 \n만 — DEL·탭은 거부한다.
    expect(isConsoleObjectivePeek({ ...snapshot, note: "a\u007fb" })).toBe(false);
    expect(isConsoleObjectivePeek({ ...snapshot, note: "a\tb" })).toBe(false);
    expect(isConsoleObjectivePeek({ ...snapshot, note: "a\r\nb" })).toBe(false);
    expect(isConsoleObjectivePeek({ ...snapshot, criteria: [{ text: "o\tk", met: true }] })).toBe(false);
    // 결과물 주소는 절대 https만.
    const pr = (url: string) => ({ ...snapshot, results: [{ kind: "pr", url }] });
    expect(isConsoleObjectivePeek(pr("javascript:alert(1)"))).toBe(false);
    expect(isConsoleObjectivePeek(pr("/o/r/pull/1"))).toBe(false);
    expect(isConsoleObjectivePeek(pr("http://github.com/o/r/pull/1"))).toBe(false);
    expect(isConsoleObjectivePeek(pr("https://github.com/o/r/pull/1"))).toBe(true);
    expect(isConsoleObjectivePeek({ ...snapshot, phase: "running" })).toBe(false);
    expect(isConsoleObjectivePeek({ ...snapshot, results: [] })).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(CONSOLE_OBJECTIVE_PEEK_MAX_BYTES);
    // 명령은 키 하나로 딱 맞게.
    expect(parseConsoleSectionCommand(JSON.stringify({ peek: { console: "c", objective: "obj-1", nonce: "n" } }))).toEqual({
      peek: { console: "c", objective: "obj-1", nonce: "n" },
    });
    expect(parseConsoleSectionCommand(JSON.stringify({ peek: { console: "c", objective: "obj-1" } }))).toBeNull();
    // 모르는 낱말이 섞여도 아는 명령만 돌려준다(다른 명령과 같은 규칙). 아는 명령이 둘이면 거부한다.
    expect(parseConsoleSectionCommand(JSON.stringify({ peek: { console: "c", objective: "obj-1", nonce: "n" }, extra: true }))).toEqual({
      peek: { console: "c", objective: "obj-1", nonce: "n" },
    });
    expect(parseConsoleSectionCommand(JSON.stringify({ peek: { console: "c", objective: "obj-1", nonce: "n" }, request: "state" }))).toBeNull();
    // 명부 요약·항목의 additive 깃발.
    expect(isConsoleRosterSummary({ v: 1, commodores: [], more: 0, objectivePeek: true })).toBe(true);
    expect(isConsoleRosterSummary({ v: 1, commodores: [], more: 0, objectivePeek: false })).toBe(false);
  });

  it("validates the marked resource root and exact owner protocol", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-resource-"));
    TEMP_DIRS.push(root);
    fs.writeFileSync(path.join(root, DESKTOP_RESOURCE_ROOT_MARKER), `${DESKTOP_PROTOCOL_VERSION}\n`);
    const env = {
      [DESKTOP_RESOURCE_ROOT_ENV]: root,
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_OWNER_ID_ENV]: "desktop-owner-1",
      [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION),
    } as NodeJS.ProcessEnv;

    const desktop = readDesktopProtocolEnvironment(env, { expectedPackageRoot: root });

    expect(desktop).toEqual({ owner: { kind: "desktop", id: "desktop-owner-1", protocolVersion: 1 }, resourceRoot: fs.realpathSync(root) });
    expect(isCompatibleDesktopOwner(desktop?.owner, "1.2.3", { id: "desktop-owner-1", version: "1.2.3" })).toBe(true);
    expect(isCompatibleDesktopOwner(desktop?.owner, "1.2.4", { id: "desktop-owner-1", version: "1.2.3" })).toBe(false);
  });
});
