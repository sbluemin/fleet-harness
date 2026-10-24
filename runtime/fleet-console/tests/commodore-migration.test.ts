import { createObjectiveStorage } from "../features/objectives/host/storage.js";
import { createDurableJsonStore } from "@fleet-console/infra";
import { sanitizeDurableConsoleState, type DurableConsoleState } from "../features/workspace/host/durable-state.js";
import { createCommodoreOwnership, migrateCommodoreAliases } from "../features/commodore/host/index.js";
import { createCommodoreEntities } from "../features/commodore/host/entities.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";
import { createCommodoreFeature, type CommodoreFeatureDeps } from "../features/commodore/host/index.js";
import { migrateCommodoreData } from "../features/commodore/host/migrate.js";
import { workspaceHash } from "../features/workspace/host/theaters/theater-domain.js";
import { EMPTY_COMMODORE_STATE } from "../features/commodore/shared/contracts/types.js";

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
    write(path.join(b.dir, "state.json"), JSON.stringify({ ...JSON.parse(state(b.text)), autonomy: false, patrolMinutes: 120 }));
    const failedCopy = seed("cross-device-copy-verification", theater("failed-copy"));
    const stopped = seed("stopped-before-commit", theater("before"));
    write(path.join(stopped.dir, "state.json"), JSON.stringify({ ...JSON.parse(state(stopped.text)), patrolMinutes: 120 }));
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
    const unknownRoot = theater("unknown");
    const unknown = seed(workspaceDirectoryNames(unknownRoot)[0], unknownRoot, "Keep the unreadable-identity directive");
    write(path.join(unknown.workspace, "cwd.json"), "{corrupt cwd");
    const lateRoot = theater("late-unknown");
    const lateUnknown = seed(workspaceDirectoryNames(lateRoot)[1]!, lateRoot, "Keep the late-registered legacy directive");
    write(path.join(lateUnknown.workspace, "cwd.json"), "{corrupt legacy cwd");
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
    expect(first!.blockedPaths.has(stopped.root)).toBe(true);
    expect(first!.blockedPaths.has(unknown.root)).toBe(false);
    expect(first!.blockedWorkspaceNames.has(path.basename(unknown.workspace))).toBe(true);
    expect(first!.blockedWorkspaceNames.has(path.basename(lateUnknown.workspace))).toBe(true);
    expect(first!.blockedPaths.has(failedCopy.root)).toBe(true);
    expect(fs.readFileSync(path.join(failedCopy.dir, "state.json"), "utf8")).toBe(state(failedCopy.text));
    const failedCopyId = JSON.parse(fs.readFileSync(path.join(failedCopy.dir, ".migration.json"), "utf8")).commodoreId;
    expect(fs.existsSync(path.join(entities, failedCopyId))).toBe(false);
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
    const roots = new Map([[workspaceHash(a.root), a.root], [workspaceHash(stopped.root), stopped.root], [workspaceHash(unknown.root), unknown.root], [workspaceHash(fresh), fresh]]);
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
    const call = async (name: string, body: unknown, status = 200) => {
      request = body;
      await feature!.routes.find((route) => route.name === name)!.handler({ req: { method: "POST" } as never, res: {} as never, pathname: name });
      expect(response!.status).toBe(status);
      return response!.value as Record<string, unknown>;
    };
    const resolved = await call("commodore/resolve", { theaterId: workspaceHash(a.root) });
    const view = await call("commodore/state", { commodoreId: resolved.commodoreId });
    expect(view).toMatchObject({ commodoreId: resolved.commodoreId, active: false, state: { patrolMinutes: 60, directive: { text: a.text, rev: 1 } }, run: { phase: "off" } });
    expect(JSON.stringify(view)).not.toContain(a.root);
    expect(view.state).not.toHaveProperty("autonomy");
    expect((await call("commodore/resolve", { theaterId: workspaceHash(stopped.root) })).commodoreId).toBe(stoppedId);
    expect(await call("commodore/state", { commodoreId: stoppedId })).toMatchObject({ state: { patrolMinutes: 120, directive: { text: stopped.text, rev: 1 } } });
    expect((await call("commodore/resolve", { theaterId: workspaceHash(fresh) })).commodoreId).toEqual(expect.any(String));
    // cwd를 못 읽어도 후보 이름이 겹치는 Theater만 보류한다. 관계없는 새 Theater는 위에서 정상 발급됐다.
    expect(await call("commodore/resolve", { theaterId: workspaceHash(unknown.root) })).toEqual({ commodoreId: null });
    expect(await call("commodore/create", { theaterId: workspaceHash(unknown.root) }, 409)).toEqual({ error: "commodore_migration_pending" });
    // 실행 중 등록도 같은 방어를 쓴다. 이 원본은 옛 손실 변환 이름이므로 digest 쪽만 검사하면 놓친다.
    roots.set(workspaceHash(lateUnknown.root), lateUnknown.root);
    feature.sync();
    expect(await call("commodore/resolve", { theaterId: workspaceHash(lateUnknown.root) })).toEqual({ commodoreId: null });
    expect(await call("commodore/create", { theaterId: workspaceHash(lateUnknown.root) }, 409)).toEqual({ error: "commodore_migration_pending" });
    expect(fs.readFileSync(path.join(unknown.dir, "state.json"), "utf8")).toBe(state(unknown.text));
    expect(fs.readFileSync(path.join(lateUnknown.dir, "state.json"), "utf8")).toBe(state(lateUnknown.text));
    write(path.join(unknown.workspace, "cwd.json"), JSON.stringify({ cwd: unknown.root }));
    write(path.join(lateUnknown.workspace, "cwd.json"), JSON.stringify({ cwd: lateUnknown.root }));
    await feature.dispose();
    feature = createCommodoreFeature(deps);
    const recovered = await call("commodore/resolve", { theaterId: workspaceHash(unknown.root) });
    expect(recovered.commodoreId).toEqual(expect.any(String));
    expect(await call("commodore/state", { commodoreId: recovered.commodoreId })).toMatchObject({ state: { directive: { text: unknown.text, rev: 1 } } });
    expect(await call("commodore/transcript", { commodoreId: recovered.commodoreId })).toMatchObject({ entries: [{ kind: "result", seq: 1, outcome: "ok" }] });
    const recoveredLate = await call("commodore/resolve", { theaterId: workspaceHash(lateUnknown.root) });
    expect(recoveredLate.commodoreId).toEqual(expect.any(String));
    expect(await call("commodore/state", { commodoreId: recoveredLate.commodoreId })).toMatchObject({ state: { directive: { text: lateUnknown.text, rev: 1 } } });
    expect(fs.existsSync(unknown.dir)).toBe(false);
    expect(fs.existsSync(lateUnknown.dir)).toBe(false);

    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(false); // 등록하지 않은 digest 원본도 이동했다.
    expect(fs.existsSync(path.join(entities, stoppedId, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(entities, afterId, ".migration.json"))).toBe(false);
    expect(fs.existsSync(path.join(entities, afterStateId, ".migration.json"))).toBe(false);
    const finalStates = fs.readdirSync(entities).map((id) => ({ id, value: JSON.parse(fs.readFileSync(path.join(entities, id, "state.json"), "utf8")) }));
    expect(finalStates.filter((entry) => entry.value.theaters[0].path === a.root)).toHaveLength(1);
    const bState = finalStates.find((entry) => entry.value.theaters[0].path === b.root)!;
    expect(bState.value).toMatchObject({ patrolMinutes: "off", directive: { text: b.text } });
    expect(bState.value).not.toHaveProperty("autonomy");
    const bId = bState.id;
    expect(fs.readFileSync(path.join(entities, bId, "memory", "MEMORY.md"), "utf8")).toBe("keep memory\n");
    const brokenId = finalStates.find((entry) => entry.value.theaters[0].path === broken.root)!.id;
    const backup = fs.readdirSync(path.join(entities, brokenId)).find((name) => name.startsWith("state.json.broken-"))!;
    expect(fs.readFileSync(path.join(entities, brokenId, backup), "utf8")).toBe("{broken legacy state");
    expect(migrateCommodoreData(data)).toMatchObject({ unresolved: 0 });
    expect(fs.readFileSync(path.join(a.workspace, "objectives", "board.json"), "utf8")).toBe("keep board and evidence");
    expect(fs.readFileSync(path.join(temp, "preserved-conflict", "state.json"), "utf8")).toBe(state(conflict.text));
    await feature.dispose(); feature = undefined;
    const filesBefore = fs.readdirSync(entities).sort();
    expect(migrateCommodoreData(data)).toMatchObject({ moved: 0, resumed: 0, unresolved: 0 });
    feature = createCommodoreFeature(deps);
    expect(fs.readdirSync(entities).sort()).toEqual(filesBefore);
    expect((await call("commodore/resolve", { theaterId: workspaceHash(a.root) })).commodoreId).toBe(resolved.commodoreId);

    // 사령관 이주가 보류된 경로라도 옮길 옛 위키가 있으면 기동 때 사령관을 발급한다. 지식은 그 사령관 디렉터리에 놓이고,
    // 이주 원본은 그 경로가 직접 소유한 workspace 하나다. 옛 사령관 기록은 지워지지 않지만 자동 이주 길은 닫힌다.
    await feature.dispose();
    const pendingRoot = theater("pending-with-wiki");
    const pending = seed(workspaceDirectoryNames(pendingRoot)[0], pendingRoot, "Keep the pending directive");
    fs.symlinkSync("state.json", path.join(pending.dir, "linked-state"));
    write(path.join(pending.workspace, "knowledge", "wiki", "kept.md"), "kept wiki\n");
    roots.set(workspaceHash(pendingRoot), pendingRoot);
    expect(migrateCommodoreData(data).blockedPaths.has(pendingRoot)).toBe(true);
    feature = createCommodoreFeature(deps);
    const pendingOwner = (await call("commodore/resolve", { theaterId: workspaceHash(pendingRoot) })).commodoreId as string;
    expect(pendingOwner).toEqual(expect.any(String));
    expect(feature.knowledge.forContext(workspaceHash(pendingRoot))).toEqual({ ok: true, commodoreId: pendingOwner });
    expect(feature.knowledge.forContext("unregistered")).toEqual({ ok: false, reason: "unknown_context" });
    expect(feature.knowledge.root(pendingOwner)).toBe(path.join(entities, pendingOwner, "knowledge"));
    expect(feature.knowledge.legacySources(pendingOwner)).toEqual([{ path: path.join(pending.workspace, "knowledge"), label: path.basename(pending.workspace) }]);
    expect(migrateCommodoreData(data).blockedPaths.has(pendingRoot)).toBe(true);
    expect(fs.readFileSync(path.join(pending.dir, "state.json"), "utf8")).toBe(state(pending.text));
    // 별칭의 명시적 발급은 기록 이주 보류를 푸는 것이 아니다. 원본은 보존하고 실행은 시작하지 않는다.
    const aliasRoot = theater("pending-with-alias");
    const aliasPending = seed(workspaceDirectoryNames(aliasRoot)[0], aliasRoot, "Keep the alias-pending directive");
    fs.symlinkSync("state.json", path.join(aliasPending.dir, "linked-state"));
    roots.set(workspaceHash(aliasRoot), aliasRoot);
    await feature.dispose(); feature = createCommodoreFeature(deps);
    expect(await call("commodore/resolve", { theaterId: workspaceHash(aliasRoot) })).toEqual({ commodoreId: null });
    expect(await call("commodore/create", { theaterId: workspaceHash(aliasRoot) }, 409)).toEqual({ error: "commodore_migration_pending" });
    const aliasOwner = (await call("commodore/create", { theaterId: workspaceHash(aliasRoot), forAlias: true })).commodoreId as string;
    expect(await call("commodore/alias", { commodoreId: aliasOwner, alias: "Assigned" })).toMatchObject({ active: false, state: { alias: "Assigned" }, run: { phase: "off" } });
    expect(feature.identity(workspaceHash(aliasRoot))).toEqual({ id: aliasOwner, alias: "Assigned" });
    expect(fs.readFileSync(path.join(aliasPending.dir, "state.json"), "utf8")).toBe(state(aliasPending.text));
    expect(warn).toHaveBeenCalled();
  } finally {
    await feature?.dispose();
    vi.restoreAllMocks();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// 별칭은 명부에서 사령관으로 옮겨지는 데이터다. 중단 지점과 구 저널 복구를 같은 저장소 경계에서 검증한다.
it("moves recovered registration aliases to their UUID owners and resumes cleanup without replaying stale journals", () => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-alias-migration-")));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const directory = path.join(temp, "console");
    const project = path.join(temp, "project"); fs.mkdirSync(project);
    const gone = path.join(temp, "forgotten"); fs.mkdirSync(gone);
    const roots = new Map([[workspaceHash(project), project]]);
    const paths = { consoleDataDir: directory, workspaceHash, listTheaterIds: () => [...roots.keys()], resolveTheaterPath: (id: string) => roots.get(id) ?? null } as unknown as CommodoreFeatureDeps["paths"];
    const entities = createCommodoreEntities(path.join(directory, "commodore"), workspaceHash);
    const forgottenId = entities.create(gone);
    const registration = (root: string) => ({ id: workspaceHash(root), path: root, realpath: root, label: path.basename(root), registeredAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-02T00:00:00.000Z", order: 3 });
    const live = { ...registration(project), alias: "  Flagship  " };
    const tombstone = (root: string, alias: string, deletionId: string) => ({ kind: "theater", deletionId, targetId: workspaceHash(root), deletedAt: 1, expiresAt: 10, theater: { ...registration(root), alias } });
    const source = { version: 6, theaters: [live], deletionTombstones: [tombstone(gone, "Retired", "forgotten"), tombstone(path.join(temp, "orphan"), "No owner", "orphan"), tombstone(path.join(temp, "invalid"), "abc\u202Egnp.exe", "invalid")] };
    const stateFile = path.join(directory, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify(source));
    const stateStore = createDurableJsonStore<DurableConsoleState>({ filePath: stateFile, lockDir: null, sensitivity: "sensitive", sanitize: sanitizeDurableConsoleState });
    let ownership: ReturnType<typeof createCommodoreOwnership>;
    let includeObjectives = false;
    const open = () => createObjectiveStorage({ directory, stateStore,
      initializeOwners: () => { ownership = createCommodoreOwnership(paths); },
      owners: () => includeObjectives ? ownership.objectives() : [],
      migrateRegistrationAliases: (entries) => migrateCommodoreAliases(entries, ownership),
    });
    // 대상 커밋 실패는 원본 별칭을 그대로 두고 기동을 중단한다.
    const nativeRename = fs.renameSync.bind(fs);
    const failTarget = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).startsWith(path.join(directory, "commodore")) && String(to).endsWith("state.json")) throw new Error("alias_target_write_failed");
      nativeRename(from, to);
    });
    try { expect(() => open().load()).toThrow("alias_target_write_failed"); } finally { failTarget.mockRestore(); }
    expect(fs.readFileSync(stateFile, "utf8")).toBe(JSON.stringify(source));
    const ownerId = ownership!.entities.resolve(workspaceHash(project))!;
    expect(ownerId).toEqual(expect.any(String));
    const ownerFile = path.join(directory, "commodore", ownerId, "state.json");
    const before = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    // 대상은 성공하고 명부 정리만 실패한 재시작. 사용자 데이터와 연결은 바뀌지 않는다.
    const save = stateStore.save.bind(stateStore);
    const failSource = vi.spyOn(stateStore, "save").mockImplementation(() => { throw new Error("alias_source_cleanup_failed"); });
    try { expect(() => open().load()).toThrow("alias_source_cleanup_failed"); } finally { failSource.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(ownerFile, "utf8"))).toEqual({ ...before, alias: "Flagship" });
    expect(fs.readFileSync(stateFile, "utf8")).toBe(JSON.stringify(source));
    // 대상 우선: 정리 전에 남은 명부 값으로 기존 별칭을 덮어쓰지 않는다.
    fs.writeFileSync(ownerFile, JSON.stringify({ ...before, alias: "Current" }));
    const loaded = open().load();
    expect(JSON.parse(fs.readFileSync(ownerFile, "utf8"))).toEqual({ ...before, alias: "Current" });
    expect(JSON.parse(fs.readFileSync(path.join(directory, "commodore", forgottenId, "state.json"), "utf8")).alias).toBe("Retired");
    expect(ownership!.entities.ids()).toHaveLength(2); // 등록된 Theater만 발급, 고아 tombstone은 발급하지 않는다.
    const cleaned = { ...source, theaters: source.theaters.map(({ alias: _alias, ...row }) => row), deletionTombstones: source.deletionTombstones.map(({ theater: { alias: _alias, ...theater }, ...row }) => ({ ...row, theater })) };
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual(cleaned);
    expect(loaded.theaters).toEqual(cleaned.theaters);
    expect(warn.mock.calls.some(([message]) => String(message).includes("orphan_tombstone"))).toBe(true);
    expect(warn.mock.calls.some(([message]) => String(message).includes("invalid_alias"))).toBe(true);
    // 해제한 UUID 이름은 재기동 때 명부에서 되살아나지 않는다.
    fs.writeFileSync(ownerFile, JSON.stringify(before));
    open().load();
    expect(JSON.parse(fs.readFileSync(ownerFile, "utf8"))).not.toHaveProperty("alias");

    // 지원하는 직전 owner 저널을 먼저 복구한다. 본문 색인 전환과 명부의 별칭 이주는 독립이다.
    const journalSource = { version: 6, theaters: [live] };
    fs.writeFileSync(stateFile, JSON.stringify(journalSource));
    const ownerArchiveFile = path.join(directory, "commodore", ownerId, "objectives", "archive.json");
    const archive = { revision: 0, entries: [], deletions: [], events: [] };
    fs.mkdirSync(path.dirname(ownerArchiveFile), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(ownerArchiveFile), "groups.json"), JSON.stringify({ groups: [] }));
    fs.writeFileSync(ownerArchiveFile, JSON.stringify({ ...archive, transaction: { documents: [], groups: [], state: journalSource, archive } }));
    includeObjectives = true;
    // owner 저널 커밋 후 별칭 정리 전에 끊겨도 다음 기동에서 복구한다.
    const failCleanup = vi.spyOn(stateStore, "save").mockImplementation((value) => {
      if (!JSON.stringify(value).includes('"alias"')) throw new Error("alias_cleanup_interrupted");
      save(value);
    });
    try { expect(() => open().load()).toThrow("alias_cleanup_interrupted"); } finally { failCleanup.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(ownerArchiveFile, "utf8"))).not.toHaveProperty("transaction");
    const restarted = open(); const snapshot = restarted.load();
    expect(snapshot.theaters).toEqual(cleaned.theaters);
    expect(JSON.parse(fs.readFileSync(ownerFile, "utf8")).alias).toBe("Flagship");
    restarted.save(snapshot);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(stateFile, "utf8")))).not.toContain('"alias"');
    expect(JSON.stringify(open().load())).not.toContain('"alias"');

    // 구 별칭 저장이 archive 준비 뒤 명부 쓰기 전에 끊겼다. 저널의 새 이름/해제가 권위다.
    const ownerArchive = JSON.parse(fs.readFileSync(ownerArchiveFile, "utf8"));
    for (const alias of ["Recovered name", undefined]) {
      fs.writeFileSync(ownerFile, JSON.stringify(before));
      fs.writeFileSync(stateFile, JSON.stringify(journalSource));
      const recoveredTheater = { ...registration(project), ...(alias === undefined ? {} : { alias }) };
      fs.writeFileSync(ownerArchiveFile, JSON.stringify({ ...ownerArchive, transaction: {
        documents: [], groups: [], archive: ownerArchive, state: { version: 6, theaters: [recoveredTheater] },
      } }));
      if (alias !== undefined) {
        // 복구 후 대상 이관이 실패해도 기동은 중단되고 새 이름이 명부에 남아 다음 기동이 재시도한다.
        const failRecoveredTarget = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (String(to) === ownerFile) throw new Error("recovered_alias_write_failed");
          nativeRename(from, to);
        });
        try { expect(() => open().load()).toThrow("recovered_alias_write_failed"); } finally { failRecoveredTarget.mockRestore(); }
        expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).theaters[0].alias).toBe(alias);
        expect(JSON.parse(fs.readFileSync(ownerFile, "utf8"))).not.toHaveProperty("alias");
      }
      open().load();
      expect(JSON.parse(fs.readFileSync(ownerFile, "utf8")).alias).toBe(alias);
      expect(JSON.parse(fs.readFileSync(ownerArchiveFile, "utf8"))).not.toHaveProperty("transaction");
      expect(JSON.stringify(open().load())).not.toContain('"alias"');
    }
    // 분리한 owner 저널에서도 raw와 다른 이름을 복구한다. alias는 본문이 아니라 등록 상태다.
    fs.writeFileSync(ownerFile, JSON.stringify(before));
    fs.writeFileSync(stateFile, JSON.stringify(journalSource));
    const transactionId = randomUUID();
    const journalFile = path.join(path.dirname(ownerArchiveFile), ".transactions", `${transactionId}.json`);
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(journalFile, JSON.stringify({ documents: [], groups: [], purgeIds: [], archive: ownerArchive,
      state: { version: 6, theaters: [{ ...registration(project), alias: "Recovered external name" }] },
    }));
    fs.writeFileSync(ownerArchiveFile, JSON.stringify({ ...ownerArchive, transaction: transactionId }));
    open().load();
    expect(JSON.parse(fs.readFileSync(ownerFile, "utf8")).alias).toBe("Recovered external name");
    expect(fs.existsSync(journalFile)).toBe(false);
    expect(JSON.stringify(open().load())).not.toContain('"alias"');
  } finally { warn.mockRestore(); fs.rmSync(temp, { recursive: true, force: true }); }
});
