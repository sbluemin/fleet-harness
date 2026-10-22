import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createCommodoreFeature, type CommodoreFeatureDeps } from "../features/commodore/host/index.js";
import { migrateCommodoreData } from "../features/commodore/host/migrate.js";
import { workspaceHash } from "../features/workspace/host/theaters/theater-domain.js";
import { EMPTY_COMMODORE_STATE } from "../features/commodore/host/types.js";

/** 데이터 이동과 조건부 삭제는 한 기동 경계에서 검증한다. 이름 변형별 단위 테스트로 쪼개지 않는다. */
it("migrates legacy workspaces before eager issuance, resumes interrupted commits and preserves unresolved data before destructive cleanup", async () => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-commodore-migration-")));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let feature: ReturnType<typeof createCommodoreFeature> | undefined;
  try {
    const data = path.join(temp, "console");
    const entities = path.join(data, "commodore");
    const write = (file: string, value: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    const theater = (name: string) => { const dir = path.join(temp, "theaters", name); fs.mkdirSync(dir, { recursive: true }); return fs.realpathSync.native(dir); };
    const marker = (id: string, root: string) => JSON.stringify({ commodoreId: id, path: root, startedAt: 1 });
    const state = (text: string) => JSON.stringify({ ...EMPTY_COMMODORE_STATE, directive: { text, rev: 1, updatedAt: 1 }, autonomy: true });
    const seed = (name: string, root: string, text = name) => {
      const workspace = path.join(data, "workspaces", name);
      const dir = path.join(workspace, "objectives", "commodore");
      write(path.join(workspace, "cwd.json"), JSON.stringify({ cwd: root }));
      write(path.join(dir, "state.json"), state(text));
      write(path.join(dir, "transcript.jsonl"), `${JSON.stringify({ kind: "result", seq: 1, at: 1, outcome: "ok" })}\n`);
      write(path.join(dir, "memory", "MEMORY.md"), "keep memory\n");
      write(path.join(dir, "images", "message", "image.png"), "keep image bytes");
      write(path.join(workspace, "objectives", "board.json"), "keep board and evidence");
      return { workspace, dir, root, text };
    };
    const a = seed("-old-readable-name", theater("registered"));
    const b = seed("digest-name--" + "b".repeat(64), theater("forgotten"));
    const failedCopy = seed("cross-device-copy-verification", theater("failed-copy"));
    const stopped = seed("stopped-before-commit", theater("before"));
    const stoppedId = randomUUID();
    write(path.join(stopped.dir, ".migration.json"), marker(stoppedId, stopped.root));
    const after = seed("stopped-after-commit", theater("after"));
    const afterId = randomUUID();
    write(path.join(after.dir, ".migration.json"), marker(afterId, after.root));
    fs.mkdirSync(entities, { recursive: true });
    fs.renameSync(after.dir, path.join(entities, afterId));
    const afterState = seed("stopped-after-state-write", theater("after-state"));
    const afterStateId = randomUUID();
    write(path.join(afterState.dir, ".migration.json"), marker(afterStateId, afterState.root));
    fs.renameSync(afterState.dir, path.join(entities, afterStateId));
    write(path.join(entities, afterStateId, "state.json"), JSON.stringify({ ...JSON.parse(state(afterState.text)), theaters: [{ path: afterState.root }] }));
    const both = seed("copy-committed-source-remains", theater("both"));
    const bothId = randomUUID();
    write(path.join(both.dir, ".migration.json"), marker(bothId, both.root));
    fs.cpSync(both.dir, path.join(entities, bothId), { recursive: true });
    const conflict = seed("downgraded-conflict", theater("conflict"));
    const conflictId = randomUUID();
    write(path.join(entities, conflictId, "state.json"), JSON.stringify({ ...EMPTY_COMMODORE_STATE, theaters: [{ path: conflict.root }] }));
    const unknown = seed("unknown-identity", theater("unknown"));
    fs.unlinkSync(path.join(unknown.workspace, "cwd.json"));
    const broken = seed("broken-state", theater("broken"));
    write(path.join(broken.dir, "state.json"), "{broken legacy state");
    const linked = path.join(data, "workspaces", "linked-source", "objectives", "commodore");
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    const outside = path.join(temp, "not-console-data");
    write(path.join(outside, "secret"), "outside unchanged");
    fs.symlinkSync(outside, linked);
    const unreadable = seed("not-a-state-file", theater("unreadable"));
    fs.unlinkSync(path.join(unreadable.dir, "state.json"));
    fs.mkdirSync(path.join(unreadable.dir, "state.json"));
    const cli = path.join(data, "plugins", "objectives", "agent-sessions");
    write(path.join(cli, "hash", "claude", "projects", "history.jsonl"), "old CLI only");
    write(path.join(cli, "peer-sessions", "peer.json"), "old peer registry");
    const otherPlugin = path.join(data, "plugins", "other", "agent-sessions", "keep");
    write(otherPlugin, "other plugin unchanged");
    const pluginSettings = path.join(data, "plugins", "objectives", "settings.json");
    write(pluginSettings, "preserve plugin settings");
    write(path.join(entities, `.copy-${stoppedId}`, "partial"), "incomplete copy");
    write(path.join(entities, `.new-${randomUUID()}`, "state.json"), "uncommitted entity");

    // 커밋 전 rename 실패. 표식만 원본에 쓰이고 strict 옛 state는 그대로다.
    const nativeRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === stopped.dir) throw Object.assign(new Error("retry next boot"), { code: "EIO" });
      if (String(from) === a.dir || String(from) === failedCopy.dir) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
      nativeRename(from, to);
    });
    const nativeCopy = fs.cpSync.bind(fs);
    const copy = vi.spyOn(fs, "cpSync").mockImplementation((from, to, options) => {
      nativeCopy(from, to, options);
      if (String(from) === failedCopy.dir) fs.appendFileSync(path.join(String(to), "transcript.jsonl"), "truncated copy\n");
    });
    let first: ReturnType<typeof migrateCommodoreData>;
    try { first = migrateCommodoreData(data); } finally { rename.mockRestore(); copy.mockRestore(); }
    expect(first!.unresolved).toBeGreaterThan(0);
    expect(first!.cleanedSessions).toBe(false);
    expect(first!.blockedPaths.has(stopped.root)).toBe(true);
    expect(first!.blockedPaths.has(failedCopy.root)).toBe(true);
    expect(fs.readFileSync(path.join(failedCopy.dir, "state.json"), "utf8")).toBe(state(failedCopy.text));
    const failedCopyId = JSON.parse(fs.readFileSync(path.join(failedCopy.dir, ".migration.json"), "utf8")).commodoreId;
    expect(fs.existsSync(path.join(entities, failedCopyId))).toBe(false);
    expect(fs.existsSync(cli)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(stopped.dir, "state.json"), "utf8"))).not.toHaveProperty("theaters");
    expect(JSON.parse(fs.readFileSync(path.join(stopped.dir, ".migration.json"), "utf8")).commodoreId).toBe(stoppedId);
    expect(fs.existsSync(after.dir)).toBe(false);
    expect(fs.existsSync(both.dir)).toBe(false);
    expect(fs.existsSync(path.join(entities, bothId, ".migration.json"))).toBe(false);
    expect(fs.readFileSync(path.join(conflict.dir, "state.json"), "utf8")).toBe(state(conflict.text));
    expect(fs.existsSync(path.join(entities, conflictId))).toBe(true);
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe("outside unchanged");
    expect(fs.readdirSync(entities).some((name) => name.startsWith(".copy-") || name.startsWith(".new-"))).toBe(false);

    // 오류를 고치고 다음 기동: 실제 feature가 이동 완료 → 색인 → 선제 발급을 수행한다.
    fs.unlinkSync(linked); // 테스트가 만든 심볼릭 링크만 제거한다. 대상은 건드리지 않는다.
    const unreadableId = fs.readdirSync(entities).find((id) => {
      const file = path.join(entities, id, ".migration.json");
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).path === unreadable.root;
    })!;
    fs.rmdirSync(path.join(entities, unreadableId, "state.json"));
    write(path.join(entities, unreadableId, "state.json"), state(unreadable.text));
    // 충돌은 제품이 병합하지 않았다. 이 테스트의 다운그레이드 시드를 안전한 위치로 치워 해결한다.
    fs.renameSync(conflict.dir, path.join(temp, "preserved-conflict"));
    const fresh = theater("newly-registered");
    const roots = new Map([[workspaceHash(a.root), a.root], [workspaceHash(stopped.root), stopped.root], [workspaceHash(fresh), fresh]]);
    let request: unknown;
    let response: { status: number; value: unknown } | undefined;
    const deps = {
      paths: { consoleDataDir: data, workspaceHash, listTheaterIds: () => [...roots.keys()], resolveTheaterPath: (id: string) => roots.get(id) ?? null },
      events: { registerSseChannel: () => () => undefined, publish: () => undefined },
      http: { readJsonBody: async () => request, writeJson: (_res: unknown, status: number, value: unknown) => { response = { status, value }; } },
      security: { isTerminalAuthorized: () => true },
      agent: { baseUrl: () => null, consoleUse: { connect: () => { throw new Error("No board must execute"); } }, resolveExecutablePath: async () => { throw new Error("No CLI must execute"); } },
      knowledgeTools: () => [],
    } as unknown as CommodoreFeatureDeps;
    feature = createCommodoreFeature(deps);
    const call = async (name: string, body: unknown) => {
      request = body;
      await feature!.routes.find((route) => route.name === name)!.handler({ req: { method: "POST" } as never, res: {} as never, pathname: name });
      expect(response!.status).toBe(200);
      return response!.value as Record<string, unknown>;
    };
    const resolved = await call("commodore/resolve", { theaterId: workspaceHash(a.root) });
    const view = await call("commodore/state", { commodoreId: resolved.commodoreId });
    expect(view).toMatchObject({ commodoreId: resolved.commodoreId, active: false, state: { directive: { text: a.text, rev: 1 } }, run: { phase: "off" } });
    expect(JSON.stringify(view)).not.toContain(a.root);
    expect((await call("commodore/resolve", { theaterId: workspaceHash(stopped.root) })).commodoreId).toBe(stoppedId);
    expect(await call("commodore/state", { commodoreId: stoppedId })).toMatchObject({ state: { directive: { text: stopped.text, rev: 1 } } });
    expect((await call("commodore/resolve", { theaterId: workspaceHash(fresh) })).commodoreId).toEqual(expect.any(String));
    // cwd 미상 원본은 보존·경고·CLI 정리 보류만 한다. 관계없는 새 Theater 발급을 막지 않는다.
    expect(fs.existsSync(unknown.dir)).toBe(true);
    expect(fs.existsSync(cli)).toBe(true);
    write(path.join(unknown.workspace, "cwd.json"), JSON.stringify({ cwd: unknown.root }));
    await feature.dispose();
    feature = createCommodoreFeature(deps);

    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(false); // 등록하지 않은 digest 원본도 이동했다.
    expect(fs.existsSync(path.join(entities, stoppedId, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(entities, afterId, ".migration.json"))).toBe(false);
    expect(fs.existsSync(path.join(entities, afterStateId, ".migration.json"))).toBe(false);
    const finalStates = fs.readdirSync(entities).map((id) => ({ id, value: JSON.parse(fs.readFileSync(path.join(entities, id, "state.json"), "utf8")) }));
    expect(finalStates.filter((entry) => entry.value.theaters[0].path === a.root)).toHaveLength(1);
    const bId = finalStates.find((entry) => entry.value.theaters[0].path === b.root)!.id;
    expect(fs.readFileSync(path.join(entities, bId, "memory", "MEMORY.md"), "utf8")).toBe("keep memory\n");
    const brokenId = finalStates.find((entry) => entry.value.theaters[0].path === broken.root)!.id;
    const backup = fs.readdirSync(path.join(entities, brokenId)).find((name) => name.startsWith("state.json.broken-"))!;
    expect(fs.readFileSync(path.join(entities, brokenId, backup), "utf8")).toBe("{broken legacy state");
    expect(fs.existsSync(cli)).toBe(false);
    expect(fs.readFileSync(pluginSettings, "utf8")).toBe("preserve plugin settings");
    expect(fs.existsSync(path.dirname(cli))).toBe(true); // 비지 않은 objectives 플러그인 자리는 보존한다.
    fs.unlinkSync(pluginSettings); // 테스트 소유 설정을 거둔 뒤에만 빈 디렉터리 정리를 확인한다.
    expect(migrateCommodoreData(data)).toMatchObject({ unresolved: 0, cleanedSessions: true });
    expect(fs.existsSync(path.dirname(cli))).toBe(false);
    expect(fs.readFileSync(path.join(a.workspace, "objectives", "board.json"), "utf8")).toBe("keep board and evidence");
    expect(fs.readFileSync(otherPlugin, "utf8")).toBe("other plugin unchanged");
    expect(fs.readFileSync(path.join(temp, "preserved-conflict", "state.json"), "utf8")).toBe(state(conflict.text));
    await feature.dispose(); feature = undefined;
    const filesBefore = fs.readdirSync(entities).sort();
    expect(migrateCommodoreData(data)).toMatchObject({ moved: 0, resumed: 0, unresolved: 0, cleanedSessions: true });
    feature = createCommodoreFeature(deps);
    expect(fs.readdirSync(entities).sort()).toEqual(filesBefore);
    expect((await call("commodore/resolve", { theaterId: workspaceHash(a.root) })).commodoreId).toBe(resolved.commodoreId);
    expect(warn).toHaveBeenCalled();
  } finally {
    await feature?.dispose();
    vi.restoreAllMocks();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
