import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWikiWorkspaceResolver,
  createWikiWorkspaceResolverForTest,
} from "../../server/wiki/workspace-resolver.js";

const OWNER = "6f1d0c2e-2b4a-4c1e-9a7d-0e5b3c2a1f00";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type Hooks = Parameters<typeof createWikiWorkspaceResolverForTest>[1];

async function fixture() {
  const root = await mkdtemp(process.platform === "darwin" ? "/tmp/fwr-" : path.join(os.tmpdir(), "fleet-wiki-resolver-"));
  roots.push(root);
  const owner = path.join(root, "console", "commodore", OWNER);
  const workspace = path.join(root, "console", "workspaces", "theater");
  await mkdir(owner, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const destination = path.join(owner, "knowledge");
  const source = path.join(workspace, "knowledge");
  const warn = vi.fn<(message: string) => void>();
  const knowledge = {
    root: (id: string) => (id === OWNER ? destination : null),
    ids: () => [OWNER],
    legacyKnowledgeSources: () => [{ path: source, label: "theater" }],
  };
  const resolver = (hooks?: Hooks) => hooks
    ? createWikiWorkspaceResolverForTest({ knowledge, warn }, hooks)
    : createWikiWorkspaceResolver({ knowledge, warn });
  return { owner, workspace, destination, source, warn, resolver };
}

/** 옛 위키 하나 — 항목·원문·스키마·기록·폐지된 대기열·감사 로그와 트리 안 파일 링크까지. */
async function seedLegacyWiki(source: string): Promise<void> {
  await mkdir(path.join(source, "wiki"), { recursive: true });
  await mkdir(path.join(source, "raw"), { recursive: true });
  await mkdir(path.join(source, "schema"), { recursive: true });
  await mkdir(path.join(source, "history", "entry", "20261001T000000Z"), { recursive: true });
  await mkdir(path.join(source, "queue"), { recursive: true });
  await writeFile(path.join(source, "wiki", "entry.md"), '---\nid: "entry"\ntitle: "Entry"\ntags: []\ncreated: "2026-10-01"\nupdated: "2026-10-01"\nversion: 2\n---\nBody');
  await symlink("entry.md", path.join(source, "wiki", "alias.md"));
  await writeFile(path.join(source, "raw", "src.txt"), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(source, "schema", "wiki-schema.md"), "# user-edited schema\n");
  await writeFile(path.join(source, "history", "entry", "20261001T000000Z", "entry.md"), "previous version\n");
  await writeFile(path.join(source, "queue", "legacy.json"), "{}\n");
  await writeFile(path.join(source, "log.md"), "## 2026-10-01 — entry created\n");
}

function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(target)}`;
      else if (entry.isDirectory()) { result[relative] = "dir"; visit(target); }
      else if (entry.isFile()) result[relative] = `file:${fs.readFileSync(target).toString("base64")}`;
      else result[relative] = "special";
    }
  };
  visit(root);
  return result;
}

const exdevOnce = (source: string): Hooks["rename"] => (from, to) => {
  if (from === source && !to.includes("knowledge.retired-")) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
  fs.renameSync(from, to);
};

describe("createWikiWorkspaceResolver", () => {
  it("moves the old workspace wiki into the commodore knowledge root once, ignores old lock residue, and converges after every interruption", async () => {
    const state = await fixture();
    await seedLegacyWiki(state.source);
    // 옛 버전이 SIGKILL로 남긴 신선한 lock — 새 이주는 lock을 쓰지 않으므로 기다리지도 실패하지도 않는다.
    await mkdir(path.join(state.workspace, "knowledge.migration.lock"));
    await writeFile(path.join(state.workspace, "knowledge.migration.lock", "owner.json"), JSON.stringify({ pid: 999_999, hostname: os.hostname(), startedAt: Date.now() }));
    const original = tree(state.source);

    state.resolver().migrateAll();
    expect(tree(state.destination)).toEqual(original);
    expect(fs.existsSync(state.source)).toBe(false);
    expect(fs.readdirSync(state.owner)).toEqual(["knowledge"]);
    expect(state.warn).not.toHaveBeenCalled();
    // 다시 기동해도 아무것도 바뀌지 않는다.
    const settled = tree(state.owner);
    state.resolver().migrateAll();
    expect(tree(state.owner)).toEqual(settled);
    expect(state.resolver().resolve(OWNER).root).toBe(state.destination);
    expect(() => state.resolver().resolve("00000000-0000-4000-8000-000000000000")).toThrow(/knowledge owner unavailable/);

    // 저널을 쓴 뒤·커밋 뒤·원본을 치우기 직전 중단, 같은 기기와 다른 기기(EXDEV 복사) 모두에서 다음 실행이 같은 트리로 수렴한다.
    const cases: Array<{ readonly point: "afterJournal" | "afterCommit" | "beforeRetire"; readonly exdev: boolean }> = [
      { point: "afterJournal", exdev: false }, { point: "afterCommit", exdev: false },
      { point: "afterCommit", exdev: true }, { point: "beforeRetire", exdev: true },
    ];
    for (const { point, exdev } of cases) {
      const interrupted = await fixture();
      await seedLegacyWiki(interrupted.source);
      const hooks: Hooks = { [point]: () => { throw new Error(`crash at ${point}`); }, ...(exdev ? { rename: exdevOnce(interrupted.source) } : {}) };
      expect(() => interrupted.resolver(hooks).resolve(OWNER)).toThrow(`crash at ${point}`);
      expect(fs.existsSync(path.join(interrupted.owner, "knowledge.migration.json"))).toBe(true);
      interrupted.resolver(exdev ? { rename: exdevOnce(interrupted.source) } : undefined).migrateAll();
      expect(tree(interrupted.destination), `${point}/${exdev}`).toEqual(original);
      expect(fs.readdirSync(interrupted.owner), `${point}/${exdev}`).toEqual(["knowledge"]);
      expect(fs.readdirSync(interrupted.workspace), `${point}/${exdev}`).toEqual([]);
    }
  });

  it("fails closed on unsafe trees and keeps both trees byte-for-byte when the new root already has content", async () => {
    const conflict = await fixture();
    await seedLegacyWiki(conflict.source);
    await mkdir(path.join(conflict.destination, "wiki"), { recursive: true });
    await writeFile(path.join(conflict.destination, "wiki", "newer.md"), "already in use\n");
    const [before, after] = [tree(conflict.source), tree(conflict.destination)];
    conflict.resolver().migrateAll();
    expect(tree(conflict.source)).toEqual(before);
    expect(tree(conflict.destination)).toEqual(after);
    expect(conflict.warn).toHaveBeenCalledWith(`[codex] knowledge owner ${OWNER}: legacy_source_preserved theater; data preserved`);

    const unsafeSources: Array<(source: string) => Promise<void>> = [
      async (source) => symlink(path.join(source, "wiki", "entry.md"), path.join(source, "absolute.md")),
      async (source) => { await writeFile(path.join(source, "..", "outside.md"), "outside"); await symlink("../outside.md", path.join(source, "escaping.md")); },
      async (source) => symlink("missing.md", path.join(source, "dangling.md")),
      async (source) => symlink("wiki", path.join(source, "wiki-link")),
      ...(process.platform === "win32" ? [] : [async (source: string) => { execFileSync("mkfifo", [path.join(source, "pipe")]); }]),
    ];
    for (const plant of unsafeSources) {
      const unsafe = await fixture();
      await seedLegacyWiki(unsafe.source);
      await plant(unsafe.source);
      const planted = tree(unsafe.source);
      expect(() => unsafe.resolver().resolve(OWNER)).toThrow(/unsafe_source/);
      expect(tree(unsafe.source)).toEqual(planted);
      expect(fs.readdirSync(unsafe.owner)).toEqual([]);
    }

    const escapingDestination = await fixture();
    await seedLegacyWiki(escapingDestination.source);
    await mkdir(escapingDestination.destination);
    await symlink("../../outside.md", path.join(escapingDestination.destination, "escape.md"));
    const kept = tree(escapingDestination.source);
    expect(() => escapingDestination.resolver().resolve(OWNER)).toThrow(/unsafe_destination/);
    expect(tree(escapingDestination.source)).toEqual(kept);
  });
});
