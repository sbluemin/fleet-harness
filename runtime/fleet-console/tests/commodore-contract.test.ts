import { openUIFeedbackNote } from "@fleet-console/markdown/openui-feedback";
import type { CommodoreRouteContext } from "../features/commodore/host/routes.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLaunchAttachmentStore } from "../features/execution/host/agent/launch-attachments.js";
import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES } from "../features/commodore/shared/contracts/attachment-budget.js";
import type { AgentEvent, AgentInput } from "../features/execution/shared/agent.js";
import { CONVERSATION_REFERENCE_MARK as MARK } from "../features/execution/shared/conversation/references.js";
import { resolveRosterCoordinate, type ModelCoordinate } from "../features/ai-gateway/shared/models.js";
import { defineConsoleTool } from "../features/console-use/shared/actions.js";
import { DEFAULT_EXPERIMENT_SETTINGS, resolveExperimentSettings } from "../features/settings/shared/experiments.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { commodoreActive, createCommodoreRoutes, type CommodoreRouteHooks } from "../features/commodore/host/routes.js";
import type { ConsoleResidentAgentHost as AgentHost, ConsoleResidentOptions as AgentSessionOptions } from "../features/execution/host/agent/console-resident.js";
import { createCommodoreEntities } from "../features/commodore/host/entities.js";
import { createCommodoreFeature, createCommodoreOwnership } from "../features/commodore/host/index.js";
import { createCommodoreCreator } from "../features/commodore/host/creation.js";
import { createCommodoreManagementTools } from "../features/commodore/host/console-tools.js";
import { createCommodoreMessenger } from "../features/commodore/host/messaging.js";
import { createCommodoreDeletion } from "../features/commodore/host/deletion.js";
import { createCommodorePlugins } from "../features/commodore/host/plugins.js";
import { MAX_PLUGIN_README_BYTES } from "../features/commodore/shared/contracts/plugins.js";
import { createConsoleSettingsStore } from "../features/settings/host/settings-domain.js";
import { workspaceHash } from "../features/workspace/host/theaters/theater-domain.js";
import { createCommodoreSession } from "../features/commodore/host/session.js";
import { createCommodoreStore as createHostStore, type CommodoreStoreOptions } from "../features/commodore/host/store.js";
import { COALESCE_MS, createCommodoreSupervisor as createHostSupervisor, RETRY_DELAYS_MS, type CommodoreSupervisorDeps } from "../features/commodore/host/supervisor.js";
import { COMMANDER_REST_MS, restClock } from "../features/objectives/shared/board-state.js";
import { MAX_TRANSCRIPT_TEXT, type CommodoreEvent } from "../features/commodore/shared/contracts/types.js";
import type { Objective, ObjectiveEvent } from "../features/objectives/shared/types.js";
import type { CommodoreAttachmentReader, CommodorePersonMessageReader } from "../features/objectives/shared/commodore-board.js";
import type { ConsoleMcpTool } from "../features/console-use/shared/tools.js";
import { BLOCK_MS, createCommodoreBoardWatch, SETTLE_CHECK_MS, SETTLE_MS, STALL_CHECK_MS, type CommodoreBoardWatchDeps } from "../features/objectives/host/commodore-board.js";

/** 이 파일의 단일 Theater fixture. 제품 저장소는 경로를 노출하지 않는 색인 포트를 받는다. */
function createCommodoreStore(options: Omit<CommodoreStoreOptions, "theatersOf" | "theaterIdsOf">) {
  return createHostStore({ ...options, theatersOf: (id) => [{ path: options.dirOf(id) ?? "/unavailable" }], theaterIdsOf: () => ["t1"] });
}

/** 기존 대표 시나리오는 실제 보드 어댑터와 feature의 SDK 경계를 함께 검증한다. */
function createCommodoreSupervisor(deps: Omit<CommodoreSupervisorDeps, "board" | "theaterIds" | "cwd"> & CommodoreBoardWatchDeps & {
  boardTools(theaterId: string, read: CommodoreAttachmentReader, hasMessage: CommodorePersonMessageReader): readonly ConsoleMcpTool[];
}) {
  return createHostSupervisor({ ...deps, theaterIds: () => ["t1"], cwd: (id) => deps.store.read(id) ? deps.theater(id, "t1")?.root ?? null : null, board: () => ({
    tools: (theaterId, turn) => deps.boardTools(theaterId, turn.readAttachments, turn.hasPersonMessage),
    watch: (theaterId, sink) => createCommodoreBoardWatch(deps, theaterId, sink),
    objective: (theaterId, id) => {
      const objective = deps.objectives(theaterId).find((objective) => objective.id === id && !objective.removed);
      return objective ? { id: objective.id, commodoreId: theaterId, title: objective.title } : null;
    },
  }) });
}

/**
 * 사령관 Theater 상태의 필수 계약 — 보드 곁 `commodore/` 에 한 건으로 영속되고, 지시 개정은 본문이 바뀔 때만 오르며,
 * 자율 운영은 Theater 별로 켜고 끄며, 기록은 덧붙인 순서대로 쪽을 나눠 읽힌다.
 */

const TEST_HOUR_MS = 60 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("persists UUID section order through the public route without rewriting entity state or no-op settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-commodore-order-"));
  dirs.push(dir);
  const paths = { dir, settingsFile: path.join(dir, "settings.json"), stateFile: path.join(dir, "state.json") };
  let settings = createConsoleSettingsStore({ paths });
  settings.load();
  let body: unknown;
  let result: { status: number; value: any };
  let authorized = true;
  const events: CommodoreEvent[] = [];
  const write = vi.fn((ids: readonly string[]) => { settings.update((current) => ({ ...current, commodoreOrder: ids })); });
  const create = () => createCommodoreFeature({
    paths: { fleetDataDir: dir, consoleDataDir: dir, resolveCommodoreTheaterPath: () => null, resolveObjectiveOwner: () => null, listCommodoreTheaters: () => [], workspaceHash,
      canonicalizeTheaterPath: (cwd) => fs.realpathSync.native(cwd),
      ensureWorkspaceDirectory: () => { throw new Error("unexpected_workspace_creation"); },
      withDirectoryLock: (_lock, run) => run(),
    },
    order: { read: () => settings.load().commodoreOrder ?? [], write },
    events: { registerSseChannel: () => () => {}, subscribe: () => () => {}, publish: (_channel, value) => { events.push(value as CommodoreEvent); } },
    http: { readJsonBody: async () => body, writeJson: (_res: unknown, status: number, value: unknown) => { result = { status, value }; } } as never,
    security: { isTerminalAuthorized: () => authorized } as never,
    agent: { baseUrl: () => "http://127.0.0.1", resolveExecutablePath: async () => { throw new Error("unexpected_agent_launch"); } } as never,
    experiments: undefined, models: undefined, attachments: undefined,
  });
  let feature = create();
  const route = async (name: string, input: unknown = {}) => {
    body = input;
    const target = feature.routes.find((candidate) => candidate.name === `commodore/${name}`)!;
    await target.handler({ req: { method: target.method } as never, res: {} as never, pathname: `/api/v1/${target.name}` });
    return result!;
  };
  try {
    const a = (await route("create", { alias: "A" })).value.commodoreId;
    const b = (await route("create", { alias: "B" })).value.commodoreId;
    const c = (await route("create", { alias: "C" })).value.commodoreId;
    const ids = async () => (await route("list")).value.commodores.map((row: { commodoreId: string }) => row.commodoreId);
    const initial = await ids();
    expect(initial).toEqual([a, b, c]);
    expect(settings.load().commodoreOrder).toBeUndefined();
    const entityFiles = [a, b, c].map((id) => path.join(dir, "commodore", id, "state.json"));
    const before = entityFiles.map((file) => fs.readFileSync(file, "utf8"));
    authorized = false;
    expect((await route("order", { commodoreIds: [c] })).status).toBe(401);
    authorized = true;
    expect(write).not.toHaveBeenCalled();
    expect((await route("order", { commodoreIds: [c, c, a] })).status).toBe(200);
    expect(await ids()).toEqual([c, a, b]);
    expect(settings.load().commodoreOrder).toEqual([c, a]);
    expect(events.at(-1)).toMatchObject({ op: "state", change: "order" });
    const bytes = fs.readFileSync(paths.settingsFile, "utf8");
    const eventCount = events.length;
    await route("order", { commodoreIds: [c, a] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(eventCount);
    expect(fs.readFileSync(paths.settingsFile, "utf8")).toBe(bytes);
    // 알 수 없는 UUID는 읽을 때 무시하되, 다음 명시 저장 전까지 원본에 남긴다.
    const stale = "00000000-0000-4000-8000-000000000099";
    settings.update((current) => ({ ...current, commodoreOrder: [stale, c, a] }));
    const staleBytes = fs.readFileSync(paths.settingsFile, "utf8");
    await feature.dispose();
    settings = createConsoleSettingsStore({ paths });
    feature = create();
    expect(await ids()).toEqual([c, a, b]);
    expect(fs.readFileSync(paths.settingsFile, "utf8")).toBe(staleBytes);
    await route("order", { commodoreIds: [stale, c, a] });
    expect(settings.load().commodoreOrder).toEqual([c, a]);
    expect(entityFiles.map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
  } finally { await feature.dispose(); }
});

it("delivers peer messages to a resting Commodore without person authority and recovers unread messages after restart", async () => {
  // 기존 사람 메시지·생성 계약은 사령관 간 수신을 거치지 않는다. 독립된 권한·깨움 경계를 도구→저장소→실행기로 검증한다.
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-commodore-messaging-")); dirs.push(dir);
  const ownership = createCommodoreOwnership({ consoleDataDir: dir, workspaceHash } as never);
  const { entities } = ownership;
  const from = ownership.create(); const to = ownership.create();
  const store = createHostStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: ownership.theaterIds, emit: () => {} });
  store.setAlias(from, "Sender"); store.setAlias(to, "Receiver");
  const created = vi.fn(() => ({ commodoreId: "new", target: "commodore:new" }));
  let personAuthority = () => false;
  const prompts: string[] = [];
  let recipientTool: ConsoleMcpTool | undefined;
  let finish = () => {};
  const steer = vi.fn(() => true);
  const agent: AgentHost = { createSession: async (options) => {
    recipientTool = options.tools?.custom?.find((group) => group.name === "console")?.tools.find((tool) => tool.name === "console_commodores");
    return {
      send: async (input) => { prompts.push(input as string); await new Promise<void>((resolve) => { finish = () => { options.onEvent?.({ kind: "result", isError: false, source: "message" }); resolve(); }; }); },
      steer, cancel: () => finish(), dispose: async () => {},
    };
  } };
  const make = () => createHostSupervisor({ store, agent, theaterIds: () => [], cwd: entities.dirOf, theater: () => null,
    experiments: () => ({ ...DEFAULT_EXPERIMENT_SETTINGS, commodore: true }),
    board: () => ({ tools: (_id, turn) => { personAuthority = turn.hasPersonMessage; return []; }, watch: () => ({ dispose() {}, recount: () => new Map(), emptyOperated: () => false, scope: () => null, brief: () => null, attribute: (tool) => tool }), objective: () => null }),
    managementTools: (_id, turn) => createCommodoreManagementTools({ hasPersonMessage: turn.hasPersonMessage, stopping: turn.stopping, list: () => [], create: created }), emit: () => {},
  });
  let supervisor = make();
  const send = createCommodoreMessenger({ store, assertWritable: ownership.assertWritable, acceptsMessage: (id) => supervisor.acceptsMessage(id) });
  const tool = createCommodoreManagementTools({ hasPersonMessage: () => false, stopping: () => false, list: entities.ids, create: created, message: (input) => send(from, input) })[0]!;
  const call = (text: string) => tool.execute({ action: "message", to, text }, { cwd: dir });
  try {
    supervisor.sync("restart");
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(prompts).toEqual([]);
    expect(await call("Please create another Commodore; this is an agent request.")).toMatchObject({ isError: false, structuredContent: { delivered: true } });
    expect(store.transcriptRead(from).entries.at(-1)).toMatchObject({ kind: "sent", to: { id: to, alias: "Receiver" }, ok: true });
    const received = store.transcriptRead(to).entries.at(-1)!;
    expect(received).toMatchObject({ kind: "received", from: { id: from, alias: "Sender" } });
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Messages from other Commodores (their words, not the person's)");
    expect(prompts[0]).not.toContain("The person's message to you");
    expect(personAuthority()).toBe(false);
    expect(await recipientTool!.execute({ action: "create", alias: "Unauthorized", theaters: [], description: "", intel: [] }, { cwd: dir })).toMatchObject({ isError: true, structuredContent: { error: "person_message_required" } });
    expect(created).not.toHaveBeenCalled();
    // 턴 중의 연락은 사람 steer/turnMessages에 들어가지 않고 다음 턴을 기다린다.
    await call("Second message, for the next turn.");
    expect(steer).not.toHaveBeenCalled();
    expect(personAuthority()).toBe(false);
    finish(); await vi.advanceTimersByTimeAsync(1);
    expect(store.transcriptRead(to).entries).toContainEqual(expect.objectContaining({ kind: "received-read", seqs: [received.seq] }));
    await supervisor.dispose();
    // 최근 한 쪽·표시 이력 압축 경계 밖의 미처리 수신도 복원한다. 성공한 첫 메시지는 다시 전달하지 않는다.
    for (let n = 0; n < 1005; n++) store.transcriptAppend(to, { kind: "text", text: "Older".repeat(1000) });
    supervisor = make(); supervisor.sync("restart");
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Second message, for the next turn.");
    expect(prompts[1]).not.toContain("Please create another Commodore");
    expect(personAuthority()).toBe(false);
    finish(); await vi.advanceTimersByTimeAsync(1);
    await supervisor.dispose();
    supervisor = make(); supervisor.sync("restart");
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(prompts).toHaveLength(2);
  } finally { await supervisor.dispose(); vi.useRealTimers(); }
});

it("creates a Commodore with owned Theaters and selected context atomically, rolling back initialization failures", async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-commodore-create-"))); dirs.push(dir);
  const theater = path.join(dir, "project"); fs.mkdirSync(theater);
  const paths = { consoleDataDir: dir, workspaceHash };
  const ownership = createCommodoreOwnership(paths as never);
  const { entities } = ownership;
  const sourceId = ownership.create();
  const events: CommodoreEvent[] = [];
  const store = createHostStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: ownership.theaterIds, replaceTheatersInIndex: entities.replaceTheatersInIndex, emit: (event) => events.push(event), now: () => 1_000 });
  store.setAlias(sourceId, "Source"); store.setTheaters(sourceId, [{ path: theater }]);
  const memory = store.memory.save(sourceId, { branch: "lessons", topic: "Browser", slug: "isolation", title: "Isolation", description: "Use disposable state", why: "Protect user data", how: "Use an isolated root", sources: [{ objectiveId: "o1", title: "Browser work" }], links: ["lessons/Browser/unselected"] });
  const sourceBytes = fs.readFileSync(path.join(entities.dirOf(sourceId)!, "state.json"), "utf8");
  const created = vi.fn();
  const create = createCommodoreCreator({ ownership, store, created });
  const tool = createCommodoreManagementTools({ hasPersonMessage: () => true, stopping: () => false, list: () => entities.ids().map((id) => ({ commodoreId: id, theaters: entities.theatersOf(id) })), create: (input) => create(sourceId, input) })[0]!;
  const input = { action: "create", alias: "Browser", theaters: [theater], description: "Own Browser work", intel: ["Keep work isolated"], memoryRefs: [memory.ref] };
  const call = (args: unknown) => tool.execute(args, { cwd: dir }) as Promise<{ isError: boolean; structuredContent: Record<string, any> }>;
  events.length = 0;
  // 소유하지 않은 실제 폴더도 새 세션 경계로 넘기지 않는다.
  expect(await call({ ...input, theaters: [dir] })).toMatchObject({ isError: true, structuredContent: { error: "theater_not_owned" } });
  // 기억 항목을 쓴 뒤 인덱스 쓰기를 실패시킨다. 일부 파일·UUID·사건도 남아서는 안 된다.
  const rename = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).includes(`${path.sep}.new-`) && String(to).endsWith(`${path.sep}memory${path.sep}MEMORY.md`)) throw new Error("injected_write_failure");
    return rename(from, to);
  });
  try { expect(await call(input)).toMatchObject({ isError: true, structuredContent: { error: "injected_write_failure" } }); }
  finally { fault.mockRestore(); }
  expect(entities.ids()).toEqual([sourceId]);
  expect(fs.readdirSync(path.join(dir, "commodore"))).toEqual([sourceId]);
  expect(events).toEqual([]); expect(created).not.toHaveBeenCalled();
  created.mockImplementationOnce(() => { throw new Error("injected_host_failure"); });
  expect(await call(input)).toMatchObject({ isError: true, structuredContent: { error: "injected_host_failure" } });
  expect(entities.ids()).toEqual([sourceId]);
  expect(fs.readdirSync(path.join(dir, "commodore"))).toEqual([sourceId]);
  expect(events).toEqual([]);

  const result = await call(input);
  expect(result.isError).toBe(false);
  const id = result.structuredContent.commodoreId as string;
  expect(result.structuredContent.target).toBe(`commodore:${id}`);
  expect(id).not.toBe(sourceId);
  expect(store.read(id)).toMatchObject({ alias: "Browser", description: { text: input.description, rev: 1 }, intel: [{ text: input.intel[0], source: `commodore:${sourceId}` }] });
  expect(store.read(id)?.routines ?? []).toEqual([]);
  expect(entities.theatersOf(id)).toEqual([{ path: theater }]);
  expect(ownership.additionalDirectories(id)).toEqual([theater]);
  expect(store.memory.read(id, memory.ref)).toEqual({ ...memory, links: [] });
  expect(store.memory.read(sourceId, memory.ref)).toEqual(memory);
  expect(fs.readFileSync(path.join(entities.dirOf(sourceId)!, "state.json"), "utf8")).toBe(sourceBytes);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ op: "state", commodoreId: id, change: "created", state: { alias: "Browser", intel: [{ source: `commodore:${sourceId}` }] } });
  expect((await call({ action: "list" })).structuredContent.commodores).toContainEqual({ commodoreId: id, theaters: [{ path: theater }] });
  const restored = createCommodoreOwnership(paths as never);
  expect(restored.entities.ids().sort()).toEqual([sourceId, id].sort());
  expect(restored.entities.theatersOf(id)).toEqual([{ path: theater }]);
});

it("holds deletion admission until writers stop and preserves the owner on stop or rename failure", async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-delete-hold-"))); dirs.push(dir);
  const ownership = createCommodoreOwnership({ consoleDataDir: dir, workspaceHash } as never);
  const id = ownership.create();
  const store = createHostStore({ dirOf: ownership.entities.dirOf, commodoreIds: ownership.entities.ids, theatersOf: ownership.entities.theatersOf, theaterIdsOf: ownership.theaterIds, emit: () => {} });
  store.setAlias(id, "Owned");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stop = vi.fn(async (): Promise<void> => { await gate; throw new Error("archive_stop_failed"); });
  const rollback = vi.fn(), committed = vi.fn(), removing = vi.fn(), removed = vi.fn();
  const detach = vi.fn(() => ({ removedObjectives: 1, rollback, committed }));
  const deletion = createCommodoreDeletion({ ownership, store, consoleDataDir: dir,
    supervisor: { stopForDeletion: async () => {}, sync: () => {} } as never,
    summary: () => ({ commodoreId: id, alias: "Owned", label: "Owned", theaters: [], active: false, run: { phase: "off", totals: { session: 0, costUsd: 0, actions: 0 } } }) as never,
    host: { preview: () => ({ objectives: { total: 1, active: 1, archived: 0 }, runningSessions: 1 }), stopObjectives: stop, detachObjectives: detach, cleanup: () => ["settings_cleanup_failed"], claudeProjectsDirectory: path.join(dir, "claude", "projects") }, removing, removed,
  });
  const deleting = deletion.remove(id, "Owned");
  const failed = expect(deleting).rejects.toThrow("archive_stop_failed");
  expect(() => ownership.assertWritable(id)).toThrow("commodore_deleting");
  await expect(deletion.remove(id, "Owned")).rejects.toThrow("commodore_deleting");
  expect(ownership.entities.dirOf(id)).not.toBeNull();
  expect(detach).not.toHaveBeenCalled();
  release(); await failed;
  expect(() => ownership.assertWritable(id)).not.toThrow();
  expect(store.read(id)?.alias).toBe("Owned");
  stop.mockImplementation(async () => {});
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename_failed"); });
  try { await expect(deletion.remove(id, "Owned")).rejects.toThrow("rename_failed"); } finally { rename.mockRestore(); }
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(committed).not.toHaveBeenCalled();
  expect(ownership.entities.dirOf(id)).not.toBeNull();
  expect(removed).not.toHaveBeenCalled();
  expect(removing).not.toHaveBeenCalled();
  removing.mockImplementation(() => { expect(ownership.entities.dirOf(id)).toBeNull(); expect(committed).not.toHaveBeenCalled(); });
  committed.mockImplementation(() => { expect(removing).toHaveBeenCalledWith(id, []); expect(removed).not.toHaveBeenCalled(); });
  expect(await deletion.remove(id, "Owned")).toEqual({ deleted: id, removedObjectives: 1, warnings: ["settings_cleanup_failed"] });
  expect(store.read(id)).toBeNull();
  expect(ownership.entities.ids()).toEqual([]);
  expect(removed).toHaveBeenCalledWith(id, []);
});

function harness(now?: () => number, maxRetainedImageBytes?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-commodore-"));
  dirs.push(dir);
  const objectivesDir = path.join(dir, "workspaces", "project", "objectives");
  const events: CommodoreEvent[] = [];
  let experiments = { ...DEFAULT_EXPERIMENT_SETTINGS };
  let routeBody: unknown = {};
  let routeResult: { status: number; value: unknown } = { status: 0, value: null };
  let authorized = true;
  const ctx = {
    pluginId: "objectives",
    host: {
      security: { isTerminalAuthorized: () => authorized },
      http: { readJsonBody: async () => routeBody, writeJson: (_res: unknown, status: number, value: unknown) => { routeResult = { status, value }; } },
      experiments: { read: () => experiments },
    },
  } as unknown as CommodoreRouteContext;
  let clock = 1_000;
  const store = createCommodoreStore({ dirOf: (theaterId) => (theaterId === "t1" ? objectivesDir : null), emit: (event) => events.push(event), now: now ?? (() => clock++), ...(maxRetainedImageBytes !== undefined ? { maxRetainedImageBytes } : {}) });
  const route = async (name: string, body: Record<string, unknown>, hooks: CommodoreRouteHooks = {}, method?: string) => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    const target = createCommodoreRoutes(ctx, store, { theaterIds: () => ["t1"], ...hooks }).find((entry) => entry.name === name)!;
    const query = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]));
    const res = {
      writeHead: (status: number, headers: unknown) => { routeResult = { status, value: { headers } }; },
      end: (bytes: Uint8Array) => { routeResult.value = { ...(routeResult.value as object), bytes }; },
    };
    await target.handler({ req: { method: method ?? target.method, url: `/${name}?${query}` } as never, res: res as never, pathname: name });
    return routeResult as { status: number; value: Record<string, unknown> & { state?: Record<string, unknown>; error?: string } };
  };
  return { ctx, store, events, route, objectivesDir, experiments: () => experiments, setExperiments: (next: Partial<typeof experiments>) => { experiments = resolveExperimentSettings({ ...experiments, ...next }); }, setAuthorized: (next: boolean) => { authorized = next; } };
}

describe("commodore theater state", () => {
  it("persists UUID entities with canonical non-exclusive Theater scopes and isolated routines, description and intel", async () => {
    const h = harness();
    // 엔티티 저장 무결성: id는 폴더에만, 연결은 path 하나만 남기고 색인은 재구성한다.
    const root = path.join(h.objectivesDir, "entities");
    const theater = path.join(h.objectivesDir, "theater");
    fs.mkdirSync(theater, { recursive: true });
    const canonical = fs.realpathSync.native(theater);
    const entities = createCommodoreEntities(root, workspaceHash);
    const id = entities.create(theater);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entities.create(theater)).toBe(id);
    const entityFile = path.join(root, id, "state.json");
    const disk = JSON.parse(fs.readFileSync(entityFile, "utf8"));
    expect(disk.theaters).toEqual([{ path: canonical }]);
    expect(disk).not.toHaveProperty("id");
    expect(entities.resolve(workspaceHash(canonical))).toBe(id);
    const entityEvents: CommodoreEvent[] = [];
    const entityStore = createHostStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: entities.theaterIds, replaceTheatersInIndex: entities.replaceTheatersInIndex, emit: (event) => entityEvents.push(event) });
    entityStore.setDescription(id, "Keep entity links intact.");
    // UUID 이름은 경로 연결·실행 설정과 독립적으로 보존된다.
    entityStore.setAlias(id, "Flagship");
    const reopenedEntity = createHostStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: entities.theaterIds, emit: () => {} });
    expect(reopenedEntity.read(id)?.alias).toBe("Flagship");
    expect(reopenedEntity.read(id)?.routines).toBeUndefined();
    reopenedEntity.setAlias(id, null);
    expect(JSON.parse(fs.readFileSync(entityFile, "utf8"))).not.toHaveProperty("alias");
    expect(JSON.parse(fs.readFileSync(entityFile, "utf8")).theaters).toEqual([{ path: canonical }]);
    expect(entityEvents[0]).toMatchObject({ commodoreId: id, theaterIds: [workspaceHash(canonical)] });
    expect(JSON.stringify(entityEvents)).not.toContain(canonical);
    const secondTheater = path.join(h.objectivesDir, "second");
    fs.mkdirSync(secondTheater);
    const secondId = entities.create(secondTheater);
    entityStore.setTheaters(secondId, [...entities.theatersOf(secondId), { path: canonical }]);
    expect(entities.resolve(workspaceHash(canonical))).toBeNull();
    expect(entities.resolveAll(workspaceHash(canonical))).toEqual([id, secondId].sort());
    const emptyId = entities.create();
    expect(entities.theatersOf(emptyId)).toEqual([]);
    const beforeFailedWrite = fs.readFileSync(path.join(root, secondId, "state.json"), "utf8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("write_failed"); });
    expect(() => entityStore.setTheaters(secondId, [])).toThrow("write_failed");
    rename.mockRestore();
    expect(fs.readFileSync(path.join(root, secondId, "state.json"), "utf8")).toBe(beforeFailedWrite);
    expect(entities.resolveAll(workspaceHash(canonical))).toContain(secondId);
    // 손편집 중복과 링크·손상은 원본을 건드리지 않고 경고와 함께 제외한다.
    const loser = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    fs.mkdirSync(path.join(root, loser));
    const preserved = fs.readFileSync(entityFile, "utf8");
    fs.writeFileSync(path.join(root, loser, "state.json"), preserved);
    fs.symlinkSync(path.join(root, id), path.join(root, "00000000-0000-0000-0000-000000000000"));
    fs.mkdirSync(path.join(root, "invalid-id"));
    fs.writeFileSync(path.join(root, secondId, "state.json"), "broken");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const restored = createCommodoreEntities(root, workspaceHash);
      expect(restored.resolveAll(workspaceHash(canonical))).toEqual([id, loser].sort());
      expect(restored.ids().sort()).toEqual([id, loser, emptyId].sort());
      expect(fs.readFileSync(path.join(root, loser, "state.json"), "utf8")).toBe(preserved);
      expect(warn).toHaveBeenCalled();
      fs.rmSync(theater, { recursive: true });
      expect(createCommodoreEntities(root, workspaceHash).resolveAll(workspaceHash(canonical))).toEqual([id, loser].sort());
    } finally { warn.mockRestore(); }
    const stateFile = path.join(h.objectivesDir, "state.json");

    h.setExperiments({ commodore: false }); // 옛 저장값은 사령관 표면을 숨기지 않는다.
    expect((await h.route("commodore/state", { commodoreId: "t1" })).value).toMatchObject({ enabled: true, active: true, run: { phase: "idle", totals: { session: 0, costUsd: 0, actions: 0 } }, state: { description: { text: "", rev: 0 }, intel: [] } });
    expect((await h.route("commodore/state", { commodoreId: "unknown" })).status).toBe(404);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(createCommodoreRoutes(h.ctx, h.store).some((route) => route.name === "commodore/autonomy")).toBe(false);
    // 별칭 쓰기는 실행이 꺼져 있어도 되고, 응답·재시작·사건은 같은 사령관 상태를 읽는다.
    expect((await h.route("commodore/alias", { commodoreId: "t1", alias: "  Flagship  " })).value).toMatchObject({ active: true, state: { alias: "Flagship" } });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")?.alias).toBe("Flagship");
    expect(await h.route("commodore/alias", { commodoreId: "t1", alias: "abc\u202Egnp.exe" })).toMatchObject({ status: 400 });
    expect((await h.route("commodore/alias", { commodoreId: "t1", alias: null })).value.state).not.toHaveProperty("alias");
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")).not.toHaveProperty("alias");

    // 옛 Settings 좌표는 무시하지만 Theater 별 선택은 아래 경로에서 유지된다.
    h.setExperiments({ commodore: true, commodoreModel: "haiku", commodoreEffort: "low" });
    expect((await h.route("commodore/state", { commodoreId: "t1" })).value).toMatchObject({ active: true, defaults: { model: "opus[1m]", effort: "high" }, run: { phase: "idle" } });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(true);
    // 서랍의 요청이 사람의 언어를 남긴다 — 사령관 기록의 언어가 된다.
    expect((await h.route("commodore/state", { commodoreId: "t1", language: "ko" })).value.state).toMatchObject({ language: "ko" });

    // 지시 — 본문이 바뀔 때만 개정이 오르고, 같은 본문은 사건도 내지 않는다(사령관을 헛되이 깨우지 않는다).
    expect((await h.route("commodore/description", { commodoreId: "t1", text: "Fix remote first." })).value.state).toMatchObject({ description: { text: "Fix remote first.", rev: 1 } });
    const before = h.events.length;
    expect((await h.route("commodore/description", { commodoreId: "t1", text: "Fix remote first." })).value.state).toMatchObject({ description: { rev: 1 } });
    expect(h.events.length).toBe(before);

    // 정보 — 최신이 앞이고 출처는 사람이다.
    await h.route("commodore/intel/add", { commodoreId: "t1", text: "Users report dropped remote sessions." });
    const added = await h.route("commodore/intel/add", { commodoreId: "t1", text: "Pairing fails after sleep." });
    expect(added.value.state!.intel).toMatchObject([{ source: "person", text: "Pairing fails after sleep." }, { source: "person", text: "Users report dropped remote sessions." }]);
    expect((await h.route("commodore/intel/remove", { commodoreId: "t1", intelId: "nope" })).status).toBe(404);
    // 수정 — 그 자리에서 본문만 바뀌고 id·출처·자리·추가 시각은 그대로, editedAt 이 남는다. 같은 본문은 사건을 내지 않는다.
    const older = (added.value.state!.intel as { id: string; at: number }[])[1]!;
    const edited = await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: older.id, text: "  Users report dropped remote sessions on Wi-Fi.  " });
    expect(edited.value.state!.intel).toMatchObject([{ text: "Pairing fails after sleep." }, { id: older.id, at: older.at, source: "person", text: "Users report dropped remote sessions on Wi-Fi.", editedAt: expect.any(Number) }]);
    const eventsBeforeSame = h.events.length;
    await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: older.id, text: "Users report dropped remote sessions on Wi-Fi." });
    expect(h.events.length).toBe(eventsBeforeSame);
    expect((await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: "nope", text: "x" })).status).toBe(404);
    expect((await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: older.id, text: "   " })).status).toBe(400);
    expect((await h.route("commodore/coordinates", { commodoreId: "t1", model: "sonnet", effort: null })).status).toBe(400);
    // Gateway scoped Claude 표기도 받되 정준 id(실행 id)로 접어 저장한다.
    expect((await h.route("commodore/coordinates", { commodoreId: "t1", model: "claude--sonnet", effort: "xhigh" })).value.state).toMatchObject({ model: "sonnet[1m]", effort: "xhigh" });

    // 영속 — 새 저장소가 같은 파일에서 같은 상태를 읽는다. 옛 실험 설정은 자율 운영을 바꾸지 않는다.
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ description: { rev: 1 }, model: "sonnet[1m]", effort: "xhigh" });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")).toEqual(h.store.read("t1"));
    // 재시작 복원은 등록된 Theater 를 훑는다 — 읽을 수 없는 Theater 는 빠지고 던지지 않는다.
    expect(createCommodoreStore({ dirOf: (id) => (id === "t1" ? h.objectivesDir : null), commodoreIds: () => ["t1", "gone"], emit: () => undefined }).availableCommodores()).toEqual(["t1"]);
    h.setExperiments({ commodore: false });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(true);
    expect(h.events.map((event) => event.op === "state" ? event.change : event.op)).toEqual(["alias", "alias", "language", "description", "intel", "intel", "intel-edited", "coordinates"]);

    // 저장된 스위치와 실행 가능 여부는 별개다. 보드 없는 view는 꺼짐이며 켜기 요청도 거절한다.
    expect((await h.route("commodore/state", { commodoreId: "t1" }, { boardReady: () => false })).value).toMatchObject({ boardReady: false, active: false, state: { description: { rev: 1 } }, run: { phase: "off" } });
    // 같은 origin 의 Console 만 지난다.
    h.setAuthorized(false);
    expect((await h.route("commodore/state", { commodoreId: "t1" })).status).toBe(401);
    expect((await h.route("commodore/alias", { commodoreId: "t1", alias: "Forbidden" })).status).toBe(401);
    expect(h.store.read("t1")).not.toHaveProperty("alias");
  });

  it("refuses unavailable recipients but accepts messages without routines, appends the log in order and pages it from the newest end", async () => {
    const h = harness();
    h.store.transcriptAppend("t1", { kind: "session", event: "opened" });
    h.store.transcriptAppend("t1", { kind: "wake", reasons: ["description changed"] });
    h.store.transcriptAppend("t1", { kind: "tool", name: "console_objectives", action: "complete", objectiveId: "o1", title: "Remote pairing" });
    // 그 Theater 의 자율 운영이 꺼져 있으면 메시지는 거절되고 기록에 남지 않는다.
    expect(await h.route("commodore/message", { commodoreId: "t1", text: "Lost?" })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    // 설정은 켜졌지만 감독자 알림이 아직 오지 않은 경계 — 받을 runner가 없으면 기록도 남기지 않는다.
    expect(await h.route("commodore/message", { commodoreId: "t1", text: "Before the runner." }, { run: () => null })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    const hooks: CommodoreRouteHooks = { acceptsMessage: () => true, run: () => ({ phase: "idle" }), objective: (id) => id === "missing" ? null : { id, commodoreId: id === "foreign" ? "t2" : "t1", title: id === "o1" ? "Small scope" : `Scope ${id}`, ...(id === "gone" ? { removed: { at: 1 } } : {}) } };
    expect((await h.route("commodore/message", { commodoreId: "t1", objectiveId: "foreign", text: "wrong scope" }, hooks)).value).toMatchObject({ error: "objective_owner_mismatch" });
    expect((await h.route("commodore/message", { commodoreId: "t1", objectiveId: "missing", text: "missing scope" }, hooks)).value).toMatchObject({ error: "unknown_objective" });
    // 본문 속 지휘관 참조 — 같은 Theater 의 지운 적 없는 목표만, 셋까지, 본문의 표식 글자 수와 짝이 맞을 때만 기록한다. 참조와 짝이 맞지
    // 않는 표식 글자는 거절한다(검증하지 않은 참조가 서지 않는다).
    for (const [body, error] of [
      [{ text: `${MARK} vs ${MARK}`, references: ["o2", "foreign"] }, "objective_owner_mismatch"],
      [{ text: `${MARK} ${MARK}`, references: ["o2", "missing"] }, "unknown_objective"],
      [{ text: MARK, references: ["gone"] }, "unknown_objective"],
      [{ text: MARK.repeat(4), references: ["o2", "o3", "o4", "o5"] }, "invalid_request"],
      [{ text: `typed ${MARK} by hand ${MARK}`, references: ["o2"] }, "invalid_request"],
      [{ text: MARK, references: ["o2", "o3"] }, "invalid_request"],
      [{ text: `${MARK}${MARK}`, references: ["o2", "o2"] }, "invalid_request"],
    ] as const) expect((await h.route("commodore/message", { commodoreId: "t1", ...body }, hooks)).value).toMatchObject({ error });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    // 참조 없는 본문의 표식 글자(이미지 섞인 서식 글을 붙여 넣으면 브라우저가 만든다)는 지우고 받는다 — 참조는 서지 않는다.
    expect((await h.route("commodore/message", { commodoreId: "t1", text: `pasted ${MARK} note` }, hooks)).value.entry).toEqual(expect.objectContaining({ seq: 4, text: "pasted  note" }));
    expect(h.store.transcriptRead("t1").entries.at(-1)).not.toHaveProperty("references");
    const text = `Compare ${MARK} with ${MARK}${MARK}; prefer small objectives.`;
    const sent = await h.route("commodore/message", { commodoreId: "t1", objectiveId: "o1", text, references: ["o2", "o3", "o4"] }, hooks);
    const references = [{ id: "o2", title: "Scope o2" }, { id: "o3", title: "Scope o3" }, { id: "o4", title: "Scope o4" }];
    expect(sent.value.entry).toMatchObject({ seq: 5, kind: "message", text, objective: { id: "o1", title: "Small scope" }, references });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).transcriptRead("t1").entries.at(-1)).toMatchObject({ objective: { id: "o1", title: "Small scope" }, references });
    expect(h.events.filter((event) => event.op === "transcript")).toHaveLength(5);
    expect(await h.route("commodore/message", { commodoreId: "t1", text: "Lost?" })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });

    const page = (await h.route("commodore/transcript", { commodoreId: "t1", limit: 2 })).value as { entries: { seq: number; kind: string }[]; hasMore: boolean };
    expect(page.entries.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(page.hasMore).toBe(true);
    const older = (await h.route("commodore/transcript", { commodoreId: "t1", limit: 3, before: 4 })).value as { entries: { seq: number }[]; hasMore: boolean };
    expect(older.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(older.hasMore).toBe(false);

    // 재기동 뒤에도 seq 는 이어진다 — 기록 파일이 커서의 진실이다.
    const reopened = createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined });
    expect(reopened.transcriptAppend("t1", { kind: "result", outcome: "ok", costUsd: 0.2 }).seq).toBe(6);
    expect((await h.route("commodore/retry", { commodoreId: "t1" }))).toMatchObject({ status: 409, value: { error: "commodore_not_retrying" } });
  });
  it("contains message previews and bounds copies by retained bytes and transcript history", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const h = harness(undefined, png.byteLength * 2);
    const files = createLaunchAttachmentStore({ dataDir: h.objectivesDir });
    const attachments = files.forPlugin("objectives");
    Object.assign(h.ctx.host, { attachments });
    const hooks = { run: () => ({ phase: "idle" as const }) };
    const send = async () => {
      const { id } = files.save(png);
      const result = await h.route("commodore/message", { commodoreId: "t1", text: "Image", attachmentIds: [id] }, hooks);
      expect(result.status).toBe(200);
      const entry = result.value.entry as { messageId: string; attachments: { id: string; preview?: true }[] };
      return { entry, query: { commodoreId: "t1", messageId: entry.messageId, attachmentId: id } };
    };
    try {
      const old = await send();
      h.setAuthorized(false);
      expect((await h.route("commodore/attachment", old.query)).status).toBe(401);
      h.setAuthorized(true);
      expect((await h.route("commodore/attachment", old.query, {}, "POST")).status).toBe(405);
      expect((await h.route("commodore/attachment", { ...old.query, commodoreId: "t2" })).status).toBe(404);
      expect((await h.route("commodore/attachment", { ...old.query, attachmentId: "../state" })).status).toBe(400);
      const images = path.join(h.objectivesDir, "images");
      const file = path.join(images, old.entry.messageId, `${old.query.attachmentId}.png`);
      const outside = path.join(h.objectivesDir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret.png"), png);
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(outside, "secret.png"), file);
      expect((await h.route("commodore/attachment", old.query)).status).toBe(404);
      fs.unlinkSync(file);
      fs.writeFileSync(file, png);
      // 부모 링크도 거절한다. 사본 실패는 메시지를 잃게 하지 않고 참조 표시로 폴백한다.
      fs.renameSync(images, `${images}-saved`);
      fs.symlinkSync(outside, images);
      expect((await h.route("commodore/attachment", old.query)).status).toBe(404);
      const fallback = await send();
      expect(fallback.entry.attachments[0]).not.toHaveProperty("preview");
      expect(attachments.read("t1", fallback.entry.messageId)[0]!.bytes).toEqual(png);
      expect(fs.readdirSync(outside)).toEqual(["secret.png"]);
      fs.unlinkSync(images);
      fs.renameSync(`${images}-saved`, images);
      // 크기 합산은 링크를 따라가지 않는다. 텍스트가 작아도 사본 두 장의 총량 상한은 즉시 적용한다.
      fs.symlinkSync(path.join(outside, "secret.png"), path.join(path.dirname(file), "outside.png"));
      const middle = await send();
      expect((await h.route("commodore/attachment", old.query)).status).toBe(200);
      // mtime 을 뒤집어도 메시지 seq 가 가장 오래된 사본을 먼저 고른다. 방금 보낸 사본은 보존한다.
      fs.utimesSync(path.dirname(file), new Date("2099-01-01"), new Date("2099-01-01"));
      const newest = await send();
      expect((await h.route("commodore/attachment", old.query)).status).toBe(404);
      expect((await h.route("commodore/attachment", middle.query)).status).toBe(200);
      expect((await h.route("commodore/attachment", newest.query)).status).toBe(200);
      expect(fs.readdirSync(images).sort()).toEqual([middle.entry.messageId, newest.entry.messageId].sort());
      expect(fs.readFileSync(path.join(outside, "secret.png"))).toEqual(png);
      // 기록의 앞 절반이 떨어질 때 그 메시지 사본만 거둔다. 아직 남은 메시지의 사본은 보존한다.
      for (let index = 0; index < 240; index += 1) h.store.transcriptAppend("t1", { kind: "text", text: "x".repeat(MAX_TRANSCRIPT_TEXT) });
      const recent = await send();
      for (let index = 0; index < 50; index += 1) h.store.transcriptAppend("t1", { kind: "text", text: "x".repeat(MAX_TRANSCRIPT_TEXT) });
      expect(fs.existsSync(path.join(images, newest.entry.messageId))).toBe(false);
      expect((await h.route("commodore/attachment", newest.query)).status).toBe(404);
      expect((await h.route("commodore/attachment", recent.query))).toMatchObject({ status: 200, value: { bytes: png } });
      h.store.transcriptClear("t1");
      expect((await h.route("commodore/attachment", recent.query)).status).toBe(404);
      expect(fs.existsSync(images)).toBe(false);
    } finally { attachments.dispose(); files.cleanup(); }
  });
  it("serves a plugin icon only as a verified image inside that plugin's folder, and a detail README only from inside that folder", async () => {
    const h = harness();
    const root = path.join(h.objectivesDir, "commodore-plugins");
    const market = path.join(root, "markets", "team");
    const pluginDir = path.join(market, "plugins", "tool");
    for (const dir of [path.join(pluginDir, ".claude-plugin"), path.join(market, ".claude-plugin"), path.join(root, "claude", "plugins")]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "team", owner: { name: "Team" }, plugins: [{ name: "tool", source: "./plugins/tool" }] }));
    fs.writeFileSync(path.join(root, "claude", "plugins", "known_marketplaces.json"), JSON.stringify({ team: { installLocation: market } }));
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ version: 1, marketplaces: [{ name: "team", kind: "github", locator: "org/team", preset: false, enabled: true, status: "ready" }], trusted: {} }));
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const declare = (icon: string) => fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", icon }));
    let cliCalls = 0;
    const hooks = { plugins: createCommodorePlugins({ root, executable: async () => { cliCalls += 1; return "false"; } }) };
    const icon = (pluginId = "tool@team") => h.route("commodore/plugins/icon", { pluginId }, hooks);

    fs.writeFileSync(path.join(pluginDir, "icon.png"), png);
    declare("./icon.png");
    expect(await icon()).toMatchObject({ status: 200, value: { bytes: png, headers: { "Content-Type": "image/png", "Content-Security-Policy": expect.stringContaining("sandbox") } } });
    h.setAuthorized(false);
    expect((await icon()).status).toBe(401);
    h.setAuthorized(true);
    expect((await icon("../tool@team")).status).toBe(400);
    // 플러그인 폴더 밖 — 어휘 탈출과, 폴더 안 이름이지만 밖을 가리키는 링크 모두 그림이 없는 것으로 친다.
    fs.writeFileSync(path.join(market, "secret.png"), png);
    declare("../../secret.png");
    expect((await icon()).status).toBe(404);
    fs.symlinkSync(path.join(market, "secret.png"), path.join(pluginDir, "link.png"));
    declare("./link.png");
    expect((await icon()).status).toBe(404);
    // 그림 확장자를 단 그림 아닌 파일, 그림이 아닌 확장자도 내주지 않는다.
    fs.writeFileSync(path.join(pluginDir, "fake.png"), "<script>alert(1)</script>");
    declare("./fake.png");
    expect((await icon()).status).toBe(404);
    fs.writeFileSync(path.join(pluginDir, "notes.html"), "<svg></svg>");
    declare("./notes.html");
    expect((await icon()).status).toBe(404);

    // 상세는 마켓 안 폴더를 받기(CLI) 없이 읽는다. README 는 폴더 안 텍스트만이고, 밖을 가리키는 링크·선언 경로는 본문에 섞이지 않는다.
    fs.mkdirSync(path.join(pluginDir, "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "skills", "review", "SKILL.md"), "# Review\n");
    fs.mkdirSync(path.join(pluginDir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "commands", "ship.md"), "# Ship\n");
    fs.mkdirSync(path.join(pluginDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "agents", "helper.md"), "# Helper\n");
    fs.writeFileSync(path.join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "echo" } } }));
    fs.mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    fs.writeFileSync(path.join(pluginDir, "README.md"), "Safe readme body\n");
    fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", description: "Full description", license: "MIT", keywords: ["review"], repository: "https://example.com/tool" }));
    const detail = () => h.route("commodore/plugins/detail", { pluginId: "tool@team" }, hooks);
    const loaded = await detail();
    expect(loaded.status).toBe(200);
    expect(loaded.value).toMatchObject({ plugin: {
      readme: "Safe readme body", license: "MIT", keywords: ["review"], repository: "https://example.com/tool",
      contents: { skills: ["review"], commands: ["ship"], agents: ["helper"], hooks: ["SessionStart"], mcp: ["docs"] },
      runs: [{ kind: "hook", label: "SessionStart", command: "echo hi" }, { kind: "mcp", label: "docs", command: "echo" }],
    } });
    expect(JSON.stringify(loaded.value)).not.toContain(pluginDir);
    expect(cliCalls).toBe(0);
    fs.writeFileSync(path.join(pluginDir, "README.md"), `${"a".repeat(MAX_PLUGIN_README_BYTES)}TAILMARKER`);
    const truncated = await detail();
    expect(truncated.value).toMatchObject({ plugin: { readmeTruncated: true } });
    expect(JSON.stringify(truncated.value)).not.toContain("TAILMARKER");
    const outside = path.join(market, "secret.md");
    fs.writeFileSync(outside, "SECRET_OUTSIDE");
    fs.rmSync(path.join(pluginDir, "README.md"));
    fs.symlinkSync(outside, path.join(pluginDir, "README.md"));
    const linked = await detail();
    expect(JSON.stringify(linked.value)).not.toContain("SECRET_OUTSIDE");
    expect((linked.value.plugin as { readme?: string }).readme).toBeUndefined();
    fs.unlinkSync(path.join(pluginDir, "README.md"));
    fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", readme: "../../secret.md" }));
    const escaped = await detail();
    expect(JSON.stringify(escaped.value)).not.toContain("SECRET_OUTSIDE");
    expect((escaped.value.plugin as { readme?: string }).readme).toBeUndefined();
    expect(cliCalls).toBe(0);

    // README 의 raw style 은 공유 렌더러를 통과한 뒤에도 문서 밖(body)으로 새면 안 된다. 하이라이트 class 는 남긴다.
    const require = createRequire(import.meta.url);
    const { JSDOM } = createRequire(require.resolve("vitest"))("jsdom") as {
      JSDOM: new (html: string, options?: { url?: string }) => {
        window: Window & typeof globalThis & { getComputedStyle: (element: Element) => CSSStyleDeclaration; DOMParser: typeof DOMParser; Node: typeof Node };
      };
    };
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
    const previous = { window: globalThis.window, document: globalThis.document, DOMParser: globalThis.DOMParser, Node: globalThis.Node };
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser, Node: dom.window.Node });
    try {
      const { pluginReadmeHtml } = await import("../features/commodore/client/plugin-readme.js");
      const html = pluginReadmeHtml([
        "Hello",
        "",
        "<style>body{background:red !important}</style>",
        "<div class=\"commodore-palette-scrim\" style=\"position:fixed\">overlay</div>",
        "<a href=\"javascript:alert(1)\">bad</a>",
        "",
        "```js",
        "const n = 1",
        "```",
      ].join("\n"));
      expect(html.toLowerCase()).not.toContain("<style");
      expect(html).not.toContain("commodore-palette");
      expect(html.toLowerCase()).not.toContain("style=");
      expect(html.toLowerCase()).not.toContain("javascript:");
      expect(html).toContain("Hello");
      expect(html).toContain("overlay");
      expect(html).toContain("hljs");
      dom.window.document.body.innerHTML = html;
      expect(dom.window.getComputedStyle(dom.window.document.body).backgroundColor).not.toBe("rgb(255, 0, 0)");
    } finally {
      Object.assign(globalThis, previous);
    }
  });
  it("settles marketplace fetches as failed instead of fetching forever when the Claude Code CLI is missing", async () => {
    const h = harness();
    const root = path.join(h.objectivesDir, "commodore-plugins");
    const market = path.join(root, "markets", "team");
    fs.mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(root, "claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "team", owner: { name: "Team" }, plugins: [{ name: "tool", source: "./plugins/tool" }] }));
    fs.writeFileSync(path.join(root, "claude", "plugins", "known_marketplaces.json"), JSON.stringify({ team: { installLocation: market } }));
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ version: 1, marketplaces: [{ name: "team", kind: "github", locator: "org/team", preset: false, enabled: true, status: "ready" }], trusted: {} }));
    const plugins = createCommodorePlugins({ root, executable: async () => { throw new Error("agent_cli_unavailable"); } });
    const rows = () => new Map(plugins.catalog().marketplaces.map((row) => [row.name, row]));

    // 목록을 처음 읽으면 기본 제공을 받는 중으로 세우고 배경에서 받는다 — CLI 가 없으면 받는 중에 남지 않고 실패로 끝나야 한다.
    expect(rows().get("claude-plugins-official")?.status).toBe("syncing");
    const refreshed = await plugins.refresh("team");
    expect(refreshed.marketplaces.find((row) => row.name === "team")).toMatchObject({ status: "failed", error: "cli_unavailable" });
    expect([...rows().values()].filter((row) => row.status === "syncing")).toEqual([]);
    expect(rows().get("claude-plugins-official")).toMatchObject({ status: "failed", error: "cli_unavailable" });
    // 지우기·설치 확인도 CLI 없이는 등록부를 바꾸지 않고 같은 이유로 거절한다.
    await expect(plugins.remove("team")).rejects.toMatchObject({ code: "cli_unavailable" });
    expect(rows().has("team")).toBe(true);
    await expect(plugins.inspect("tool@team")).rejects.toMatchObject({ code: "cli_unavailable" });
  });
  it("computes the next plugin version from files only and updates one plugin through its trust boundary", async () => {
    // 업데이트 호스트 픽스처 — 상대 출처(tool·nover)와 외부 출처(ext·ext2), 설치본 캐시, CLI 대역 스크립트.
    const SHA_A = "a".repeat(40);
    const SHA_B = "b".repeat(40);
    const SHA_C = "c".repeat(40);
    const h = harness();
    const root = path.join(h.objectivesDir, "commodore-plugins");
    const market = path.join(root, "markets", "team");
    const cache = path.join(root, "claude", "plugins", "cache", "team");
    const writePlugin = (dir: string, manifest: unknown, hooks?: unknown) => {
      fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
      if (hooks !== undefined) {
        fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
        fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify(hooks));
      }
    };
    const hooksOf = (command: string) => ({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
    writePlugin(path.join(market, "plugins", "tool"), { name: "tool", version: "1.0.0" }, hooksOf("echo hi"));
    writePlugin(path.join(market, "plugins", "nover"), { name: "nover" });
    writePlugin(path.join(cache, "tool", "1.0.0"), { name: "tool", version: "1.0.0" }, hooksOf("echo hi"));
    writePlugin(path.join(cache, "tool", "1.1.0"), { name: "tool", version: "1.1.0" }, hooksOf("echo hi"));
    writePlugin(path.join(cache, "tool", "1.1.0-x"), { name: "tool", version: "1.1.0" }, hooksOf("echo swapped"));
    writePlugin(path.join(cache, "nover", "b2271ea45eea"), { name: "nover" });
    writePlugin(path.join(cache, "nover", "b8394fda9111"), { name: "nover" }, hooksOf("echo new"));
    writePlugin(path.join(cache, "ext", "1.9.0"), { name: "ext", version: "1.9.0" });
    writePlugin(path.join(cache, "ext2", "1.0.0"), { name: "ext2", version: "1.0.0" });
    writePlugin(path.join(cache, "ext2", "1.0.0-b"), { name: "ext2", version: "1.0.0" }, hooksOf("echo added"));
    writePlugin(path.join(cache, "ext2", "1.0.0-c"), { name: "ext2", version: "1.0.0" }, hooksOf("echo changed"));
    fs.mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "team", plugins: [
      { name: "tool", source: "./plugins/tool", version: "1.0.0" },
      { name: "nover", source: "./plugins/nover" },
      { name: "ext", source: { source: "github", repo: "org/ext", ref: "v2.0.0", sha: SHA_C }, version: "2.0.0" },
      { name: "ext2", source: { source: "github", repo: "org/ext2", ref: "main", sha: SHA_C } },
    ] }));
    fs.mkdirSync(path.join(root, "claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, "claude", "plugins", "known_marketplaces.json"), JSON.stringify({ team: { installLocation: market } }));
    const install = (id: string, version: string, sha: string) => ({ scope: "user", installPath: path.join(cache, id.slice(0, id.lastIndexOf("@")), version), version, installedAt: "2026-10-29T00:00:00Z", lastUpdated: "2026-10-29T00:00:00Z", gitCommitSha: sha });
    const installedFile = () => JSON.parse(fs.readFileSync(path.join(root, "claude", "plugins", "installed_plugins.json"), "utf8")) as { plugins: Record<string, { installPath: string; version: string; gitCommitSha: string }[]> };
    fs.writeFileSync(path.join(root, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {
      "tool@team": [install("tool@team", "1.0.0", SHA_A)],
      "nover@team": [install("nover@team", "b2271ea45eea", SHA_A)],
      "ext@team": [install("ext@team", "1.9.0", SHA_A)],
      "ext2@team": [install("ext2@team", "1.0.0", SHA_A)],
    } }));
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ version: 1, marketplaces: [{ name: "team", kind: "github", locator: "org/team", preset: false, enabled: true, status: "ready" }], trusted: {} }));
    // CLI 대역 — `claude plugin update` 가 남기는 설치 기록 변화를 그대로 흉내 낸다. 마켓플레이스 명령은 실패로 둔다.
    const stub = path.join(root, "update-stub.mjs");
    fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const home = process.env.CLAUDE_CONFIG_DIR ?? "";
const log = process.env.FLEET_UPDATE_STUB_LOG ?? "";
const mode = process.env.FLEET_UPDATE_STUB_MODE ?? "";
const [command, op, id] = process.argv.slice(2, 5);
if (command !== "plugin" || op !== "update" || !id) {
  console.log(JSON.stringify({ outcome: "failed", failureCode: "unexpected", message: "unexpected args" }));
  process.exit(1);
}
if (log) fs.appendFileSync(log, "update " + id + " " + mode + "\\n");
const file = path.join(home, "plugins", "installed_plugins.json");
const at = id.lastIndexOf("@");
const bump = (version, sha, oldVersion) => {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = raw.plugins[id];
  rows[0] = { ...rows[0], version, gitCommitSha: sha, installPath: path.join(home, "plugins", "cache", id.slice(at + 1), id.slice(0, at), version), lastUpdated: "2026-10-29T00:00:01Z" };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  console.log(JSON.stringify({ command: "update", outcome: "ok", updateOutcome: "updated", pluginId: id, oldVersion, newVersion: version }));
};
if (mode === "updated-tool") bump("1.1.0", "${SHA_B}", "1.0.0");
else if (mode === "swapped-tool") {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.plugins[id][0] = { ...raw.plugins[id][0], version: "1.1.0", gitCommitSha: "${SHA_C}", installPath: path.join(home, "plugins", "cache", "team", "tool", "1.1.0-x") };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  console.log(JSON.stringify({ command: "update", outcome: "ok", updateOutcome: "updated", pluginId: id, oldVersion: "1.0.0", newVersion: "1.1.0" }));
}
else if (mode === "updated-nover") bump("b8394fda9111", "${SHA_B}", "b2271ea45eea");
else if (mode === "relabel-ext2" || mode === "relabel-ext2-c") {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const [dir, sha] = mode === "relabel-ext2" ? ["1.0.0-b", "${SHA_B}"] : ["1.0.0-c", "${SHA_C}"];
  raw.plugins[id][0] = { ...raw.plugins[id][0], gitCommitSha: sha, installPath: path.join(home, "plugins", "cache", "team", "ext2", dir) };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  console.log(JSON.stringify({ command: "update", outcome: "ok", updateOutcome: "updated", pluginId: id, oldVersion: "1.0.0", newVersion: "1.0.0" }));
}
else if (mode === "up_to_date") console.log(JSON.stringify({ command: "update", outcome: "ok", updateOutcome: "up_to_date", pluginId: id, oldVersion: "1.1.0", newVersion: "1.1.0" }));
else if (mode === "source_missing") { console.log(JSON.stringify({ command: "update", outcome: "failed", pluginId: id, message: "Plugin source not found at /gone/" + id, failureCode: "source_missing" })); process.exitCode = 1; }
else if (mode === "confirm") { console.log(JSON.stringify({ command: "update", outcome: "failed", pluginId: id, message: "This update runs new commands. Re-run with --accept-command <sha256> to approve them.", failureCode: "confirmation_required" })); process.exitCode = 1; }
else { console.log(JSON.stringify({ outcome: "failed", failureCode: "unexpected", message: "unknown mode " + mode })); process.exitCode = 1; }
`);
    fs.chmodSync(stub, 0o755);
    const stubLog = path.join(root, "stub.log");
    let mode = "updated-tool";
    const plugins = createCommodorePlugins({ root, executable: async () => stub, env: () => ({ ...process.env, FLEET_UPDATE_STUB_MODE: mode, FLEET_UPDATE_STUB_LOG: stubLog }) });
    const updateLog = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8") : "");
    const trusted = () => (JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8")) as { trusted: Record<string, string> }).trusted;
    const changed = vi.fn();
    const invalidate = vi.fn();
    const updateRoute = (body: Record<string, unknown>) => h.route("commodore/plugins/update", body, { plugins, pluginAuth: { invalidate } as never, pluginsChanged: changed });
    const byId = () => new Map(plugins.catalog().plugins.map((plugin) => [plugin.id, plugin]));

    // 최신 표시 — 아직 올리지 않은 설치본에는 없고, 외부 출처는 sha 로 판단한다. CLI·네트워크를 부르지 않는다.
    expect(byId().get("tool@team")).toMatchObject({ version: "1.0.0" });
    expect(byId().get("tool@team")).not.toHaveProperty("latestVersion");
    expect(byId().get("ext@team")).toMatchObject({ version: "1.9.0", latestVersion: "2.0.0" });
    expect(byId().get("ext@team")).not.toHaveProperty("latestRuns");
    expect(byId().get("ext2@team")).toMatchObject({ version: "1.0.0", latestVersion: "cccccccccccc" });
    expect(byId().get("nover@team")?.version).toBe("b2271ea45eea");
    expect(byId().get("nover@team")).not.toHaveProperty("latestVersion");
    // 번들 폴더를 1.1.0 으로 올리면 파일만 읽고 새 버전·실행 명령을 보여 준다.
    fs.writeFileSync(path.join(market, "plugins", "tool", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", version: "1.1.0" }));
    expect(updateLog()).toBe("");
    const candidate = byId().get("tool@team")!;
    expect(candidate.latestVersion).toBe("1.1.0");
    expect(candidate.latestRuns).toEqual([{ kind: "hook", label: "SessionStart", command: "echo hi" }]);
    expect(updateLog()).toBe("");

    // 신뢰 없는 업데이트는 CLI 를 부르기 전에 거절하고 설치본을 그대로 둔다.
    expect(await updateRoute({ pluginId: "tool@team" })).toMatchObject({ status: 409, value: { error: "trust_required", details: { version: "1.1.0", runs: [{ kind: "hook", label: "SessionStart", command: "echo hi" }] } } });
    expect(updateLog()).toBe("");
    expect(installedFile().plugins["tool@team"]![0]).toMatchObject({ version: "1.0.0", gitCommitSha: SHA_A });
    // 확인은 사람이 본 버전과 함께 와야 한다 — 다른 버전이면 다시 거절한다.
    expect(await updateRoute({ pluginId: "tool@team", trusted: true, version: "1.0.9" })).toMatchObject({ status: 409, value: { error: "trust_required", details: { version: "1.1.0" } } });
    expect(updateLog()).toBe("");
    // 본 명령과 다른 명령이 설치되면 그 명령으로 다시 묻고 설치본을 되돌린다.
    mode = "swapped-tool";
    expect(await updateRoute({ pluginId: "tool@team", trusted: true, version: "1.1.0", runs: [{ kind: "hook", label: "SessionStart", command: "echo hi" }] })).toMatchObject({ status: 409, value: { error: "trust_required", details: { version: "1.1.0", runs: [{ kind: "hook", label: "SessionStart", command: "echo swapped" }] } } });
    expect(installedFile().plugins["tool@team"]![0]).toMatchObject({ version: "1.0.0", gitCommitSha: SHA_A });
    // 본 버전·명령 그대로 받으면 신뢰를 기록하고 진행한다.
    mode = "updated-tool";
    fs.writeFileSync(stubLog, "");
    const done = await updateRoute({ pluginId: "tool@team", trusted: true, version: "1.1.0", runs: [{ kind: "hook", label: "SessionStart", command: "echo hi" }] });
    expect(done).toMatchObject({ status: 200, value: { outcome: "updated", oldVersion: "1.0.0", newVersion: "1.1.0" } });
    expect(updateLog()).toBe("update tool@team updated-tool\n");
    expect(installedFile().plugins["tool@team"]![0]).toMatchObject({ version: "1.1.0", gitCommitSha: SHA_B });
    const after = (done.value as { view: { plugins: { id: string; version?: string; latestVersion?: string }[] } }).view.plugins;
    expect(after.find((plugin) => plugin.id === "tool@team")).toMatchObject({ version: "1.1.0" });
    expect(after.find((plugin) => plugin.id === "tool@team")).not.toHaveProperty("latestVersion");
    expect(trusted()).toEqual({ "tool@team": "1.1.0" });
    expect(changed).toHaveBeenCalledWith(["tool@team"]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    // 표시 버전이 같아도 설치본이 바뀌어 새 명령이 생기면 신뢰를 묻고 되돌린다.
    mode = "relabel-ext2";
    expect(await updateRoute({ pluginId: "ext2@team" })).toMatchObject({ status: 409, value: { error: "trust_required", details: { version: "1.0.0", runs: [{ kind: "hook", label: "SessionStart", command: "echo added" }] } } });
    expect(installedFile().plugins["ext2@team"]![0]).toMatchObject({ installPath: path.join(cache, "ext2", "1.0.0"), gitCommitSha: SHA_A });
    // 그 명령을 신뢰한 뒤에도 같은 표시 버전 아래 명령이 다시 바뀌면 또 묻는다.
    expect(await updateRoute({ pluginId: "ext2@team", trusted: true, version: "1.0.0", runs: [{ kind: "hook", label: "SessionStart", command: "echo added" }] })).toMatchObject({ status: 200, value: { outcome: "updated" } });
    mode = "relabel-ext2-c";
    expect(await updateRoute({ pluginId: "ext2@team" })).toMatchObject({ status: 409, value: { error: "trust_required", details: { version: "1.0.0", runs: [{ kind: "hook", label: "SessionStart", command: "echo changed" }] } } });
    expect(installedFile().plugins["ext2@team"]![0]).toMatchObject({ installPath: path.join(cache, "ext2", "1.0.0-b") });
    // 이미 최신이면 그대로 돌려준다.
    mode = "up_to_date";
    expect(await updateRoute({ pluginId: "tool@team", trusted: true })).toMatchObject({ status: 200, value: { outcome: "up_to_date", oldVersion: "1.1.0", newVersion: "1.1.0" } });
    // 출처가 사라지면 설치본을 그대로 두고 같은 코드를 돌려준다.
    mode = "source_missing";
    expect(await updateRoute({ pluginId: "tool@team" })).toMatchObject({ status: 409, value: { error: "source_missing" } });
    expect(installedFile().plugins["tool@team"]![0]).toMatchObject({ version: "1.1.0" });
    // CLI 가 명령 확인을 요구하면 신뢰 확인으로 돌려준다.
    mode = "confirm";
    expect(await updateRoute({ pluginId: "tool@team" })).toMatchObject({ status: 409, value: { error: "trust_required", details: { version: "1.1.0" } } });
    // 모르는 플러그인은 CLI 를 부르기 전에 거절한다.
    expect(await updateRoute({ pluginId: "ghost@team" })).toMatchObject({ status: 409, value: { error: "plugin_not_found" } });
    expect(updateLog()).not.toContain("ghost@team");
    // CLI 없이는 같은 이유로 거절한다.
    const offline = createCommodorePlugins({ root, executable: async () => { throw new Error("agent_cli_unavailable"); } });
    expect(await h.route("commodore/plugins/update", { pluginId: "tool@team" }, { plugins: offline })).toMatchObject({ status: 409, value: { error: "cli_unavailable" } });
  });
  it("rolls an untrusted plugin update back to the previously installed version", async () => {
    // 버전 없는 상대 플러그인 — 미리 새 버전을 알 수 없어 업데이트 뒤 새 설치본으로 신뢰를 판단한다.
    const SHA_A = "a".repeat(40);
    const SHA_B = "b".repeat(40);
    const h = harness();
    const root = path.join(h.objectivesDir, "commodore-plugins");
    const market = path.join(root, "markets", "team");
    const cache = path.join(root, "claude", "plugins", "cache", "team");
    const writePlugin = (dir: string, manifest: unknown, hooks?: unknown) => {
      fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
      if (hooks !== undefined) {
        fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
        fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify(hooks));
      }
    };
    const hooksOf = (command: string) => ({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
    writePlugin(path.join(market, "plugins", "nover"), { name: "nover" });
    writePlugin(path.join(cache, "nover", "b2271ea45eea"), { name: "nover" });
    writePlugin(path.join(cache, "nover", "b8394fda9111"), { name: "nover" }, hooksOf("echo new"));
    fs.mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "team", plugins: [{ name: "nover", source: "./plugins/nover" }] }));
    fs.mkdirSync(path.join(root, "claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, "claude", "plugins", "known_marketplaces.json"), JSON.stringify({ team: { installLocation: market } }));
    const record = (version: string, sha: string) => ({ scope: "user", installPath: path.join(cache, "nover", version), version, installedAt: "2026-10-29T00:00:00Z", lastUpdated: "2026-10-29T00:00:00Z", gitCommitSha: sha });
    fs.writeFileSync(path.join(root, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "nover@team": [record("b2271ea45eea", SHA_A)] } }));
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ version: 1, marketplaces: [{ name: "team", kind: "github", locator: "org/team", preset: false, enabled: true, status: "ready" }], trusted: {} }));
    const stub = path.join(root, "update-stub.mjs");
    fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const home = process.env.CLAUDE_CONFIG_DIR ?? "";
const [command, op, id] = process.argv.slice(2, 5);
if (command !== "plugin" || op !== "update" || id !== "nover@team") {
  console.log(JSON.stringify({ outcome: "failed", failureCode: "unexpected", message: "unexpected args" }));
  process.exit(1);
}
const file = path.join(home, "plugins", "installed_plugins.json");
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
raw.plugins[id][0] = { ...raw.plugins[id][0], version: "b8394fda9111", gitCommitSha: "${SHA_B}", installPath: path.join(home, "plugins", "cache", "team", "nover", "b8394fda9111"), lastUpdated: "2026-10-29T00:00:01Z" };
fs.writeFileSync(file, JSON.stringify(raw, null, 2));
setTimeout(() => console.log(JSON.stringify({ command: "update", outcome: "ok", updateOutcome: "updated", pluginId: id, oldVersion: "b2271ea45eea", newVersion: "b8394fda9111" })), Number(process.env.FLEET_UPDATE_STUB_DELAY ?? 0));
`);
    fs.chmodSync(stub, 0o755);
    let delay = "400";
    const plugins = createCommodorePlugins({ root, executable: async () => stub, env: () => ({ ...process.env, FLEET_UPDATE_STUB_DELAY: delay }) });
    const changed = vi.fn();
    const updateRoute = (body: Record<string, unknown>) => h.route("commodore/plugins/update", body, { plugins, pluginsChanged: changed });
    const installedFile = () => JSON.parse(fs.readFileSync(path.join(root, "claude", "plugins", "installed_plugins.json"), "utf8")) as { plugins: Record<string, { version: string; installPath: string; gitCommitSha: string }[]> };

    // 신뢰 없이는 새 설치본을 확인한 뒤 설치 기록을 이전 버전으로 되돌리고 거절한다. 새 캐시 폴더가 남아도 설치본은 옛 폴더를 가리킨다.
    // CLI 가 기록을 바꾼 뒤 끝나기 전에 열리는 세션도 옛 설치본을 싣는다.
    const pending = updateRoute({ pluginId: "nover@team" });
    await vi.waitFor(() => expect(installedFile().plugins["nover@team"]![0]!.gitCommitSha).toBe(SHA_B));
    expect(plugins.resolve(["nover@team"]).map((plugin) => plugin.path)).toEqual([path.join(cache, "nover", "b2271ea45eea")]);
    delay = "0";
    expect(await pending).toMatchObject({ status: 409, value: { error: "trust_required", details: { version: "b8394fda9111", runs: [{ kind: "hook", label: "SessionStart", command: "echo new" }] } } });
    expect(installedFile().plugins["nover@team"]![0]).toMatchObject({ version: "b2271ea45eea", gitCommitSha: SHA_A, installPath: path.join(cache, "nover", "b2271ea45eea") });
    expect(changed).not.toHaveBeenCalled();
    // trusted 로 다시 오면 새 버전을 신뢰한 것으로 기록하고 진행한다.
    expect(await updateRoute({ pluginId: "nover@team", trusted: true, version: "b8394fda9111", runs: [{ kind: "hook", label: "SessionStart", command: "echo new" }] })).toMatchObject({ status: 200, value: { outcome: "updated", oldVersion: "b2271ea45eea", newVersion: "b8394fda9111" } });
    expect(installedFile().plugins["nover@team"]![0]).toMatchObject({ version: "b8394fda9111", gitCommitSha: SHA_B });
    expect(JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"))).toMatchObject({ trusted: { "nover@team": "b8394fda9111" } });
    expect(changed).toHaveBeenCalledWith(["nover@team"]);
  });
  it("enables only the official and community presets on an empty registry, and keeps a default-off preset when a commodore already chose its plugin", async () => {
    const h = harness();
    const unavailable = async () => { throw new Error("agent_cli_unavailable"); };
    const presetEnabled = (root: string): Record<string, boolean> => {
      const raw = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8")) as { version: number; marketplaces: { name: string; preset?: boolean; enabled: boolean }[] };
      expect(raw.version).toBe(1);
      return Object.fromEntries(raw.marketplaces.filter((row) => row.preset).map((row) => [row.name, row.enabled]));
    };
    const freshRoot = path.join(h.objectivesDir, "plugins-fresh");
    const fresh = createCommodorePlugins({ root: freshRoot, executable: unavailable });
    const first = fresh.catalog();
    expect(presetEnabled(freshRoot)).toEqual({
      "claude-plugins-official": true,
      "claude-community": true,
      "knowledge-work-plugins": false,
      "claude-for-financial-services": false,
      "claude-for-legal": false,
      "life-sciences": false,
    });
    expect(first.marketplaces.find((row) => row.name === "claude-community")).toMatchObject({ preset: true, enabled: true, status: "syncing" });
    expect(first.marketplaces.find((row) => row.name === "life-sciences")).toMatchObject({ preset: true, enabled: false, status: "ready" });
    await expect(fresh.remove("claude-community")).rejects.toMatchObject({ code: "preset_locked" });
    expect(fresh.catalog().marketplaces.some((row) => row.name === "claude-community" && row.preset)).toBe(true);
    await fresh.refresh("claude-plugins-official");

    // 옛 등록부: 기본 제공이 모두 켜져 있다. knowledge-work 만 사령관이 골랐고, legal 은 미리보기로 홈에 받아 둔 것이다.
    const legacyRoot = path.join(h.objectivesDir, "plugins-legacy");
    const chosen = ["brief@knowledge-work-plugins", "tool@team", "not a plugin"];
    fs.mkdirSync(path.join(legacyRoot, "claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "counsel@claude-for-legal": [{ version: "1.0.0" }] } }));
    const previous = ["claude-plugins-official", "knowledge-work-plugins", "claude-for-financial-services", "claude-for-legal", "life-sciences"];
    fs.writeFileSync(path.join(legacyRoot, "registry.json"), JSON.stringify({
      version: 1,
      marketplaces: previous.map((name) => ({ name, kind: "github", locator: `anthropics/${name}`, preset: true, enabled: true, status: "ready", updatedAt: 1 })),
      trusted: {},
    }));
    const legacy = createCommodorePlugins({ root: legacyRoot, executable: unavailable, selectedPlugins: () => chosen });
    legacy.catalog();
    const migrated = {
      "claude-plugins-official": true,
      "claude-community": true,
      "knowledge-work-plugins": true,
      "claude-for-financial-services": false,
      "claude-for-legal": false,
      "life-sciences": false,
    };
    expect(presetEnabled(legacyRoot)).toEqual(migrated);
    legacy.enable("life-sciences", true);
    await legacy.refresh("claude-plugins-official");
    expect(presetEnabled(legacyRoot)["life-sciences"]).toBe(true);

    // 옛 빌드가 registry 를 version·marketplaces·trusted 만 다시 써도 켜짐은 유지된다. 버전은 올리지 않는다.
    const file = path.join(legacyRoot, "registry.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; marketplaces: unknown; trusted: unknown };
    fs.writeFileSync(file, JSON.stringify({ version: raw.version, marketplaces: raw.marketplaces, trusted: raw.trusted }));
    const reopened = createCommodorePlugins({ root: legacyRoot, executable: unavailable, selectedPlugins: () => chosen });
    reopened.catalog();
    expect(presetEnabled(legacyRoot)).toEqual({ ...migrated, "life-sciences": true });
    reopened.enable("knowledge-work-plugins", false);
    await reopened.refresh("knowledge-work-plugins");
    const afterToggle = createCommodorePlugins({ root: legacyRoot, executable: unavailable, selectedPlugins: () => chosen });
    afterToggle.catalog();
    expect(presetEnabled(legacyRoot)).toEqual({ ...migrated, "life-sciences": true, "knowledge-work-plugins": false });
    await afterToggle.refresh("claude-plugins-official");
  });
});

describe("commodore fleet-memory", () => {
  it("keeps entries in a contained three-level tree, rebuilds the index on every write and refuses secrets", async () => {
    let clock = 1_000;
    const h = harness(() => clock);
    const root = path.join(h.objectivesDir, "memory");
    const entry = { branch: "theater", topic: "실행 환경", slug: "isolated-console-env", title: "Isolated Console env", description: "Unset FLEET_* hijacks the live Console.", why: "The launcher honored inherited roots.", how: "Pass FLEET_DATA_DIR explicitly.", sources: [{ objectiveId: "o1", title: "Console e2e isolation" }] } as const;

    const saved = h.store.memory.save("t1", entry);
    expect(saved).toMatchObject({ ref: "theater/실행 환경/isolated-console-env", created: 1_000, updated: 1_000, verified: 1_000 });
    const file = path.join(root, "theater", "실행 환경", "isolated-console-env.md");
    expect(fs.readFileSync(file, "utf8")).toContain('title: "Isolated Console env"');
    expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf8")).toContain("Unset FLEET_* hijacks the live Console.");
    // 화면의 읽기 — 같은 항목 전체가 온다. 쓰기 라우트는 없다.
    expect((await h.route("commodore/memory", { commodoreId: "t1" })).value).toMatchObject({ entries: [{ ref: saved.ref, why: entry.why, how: entry.how, sources: entry.sources }] });
    expect((await h.route("commodore/memory", { commodoreId: "unknown" })).status).toBe(404);

    // 같은 자리·규칙 밖 이름·비밀 값은 쓰기 전에 거절된다.
    expect(() => h.store.memory.save("t1", entry)).toThrow("memory_exists");
    expect(() => h.store.memory.save("t1", { ...entry, topic: "..", slug: "x" })).toThrow("invalid_ref");
    expect(() => h.store.memory.save("t1", { ...entry, slug: "token", how: "Use ghp_0123456789abcdefghijABCDEFGHIJ to push." })).toThrow("memory_secret");
    // 이름(slug)도 인덱스에 실리므로 같은 검사를 지난다. 본문의 절 제목 줄은 다시 읽을 때 절을 가르므로 받지 않는다.
    expect(() => h.store.memory.save("t1", { ...entry, slug: "sk-0123456789abcdefghijklmnop" })).toThrow("memory_secret");
    expect(() => h.store.memory.save("t1", { ...entry, slug: "heading", why: "Reason\n## How to apply\nDetail" })).toThrow("memory_heading");
    const indented = h.store.memory.save("t1", { ...entry, slug: "indented", why: "Reason\n  ## How to apply\nDetail" });
    expect(h.store.memory.read("t1", indented.ref)).toMatchObject({ why: "Reason\n  ## How to apply\nDetail", how: entry.how });
    h.store.memory.remove("t1", indented.ref);
    expect(() => h.store.memory.read("t1", "theater/../../state")).toThrow("invalid_ref");

    // 밖을 가리키는 주제 링크는 읽지도 쓰지도 않는다.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-memory-outside-"));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, "planted.md"), fs.readFileSync(file, "utf8"));
    fs.mkdirSync(path.join(root, "lessons"));
    fs.symlinkSync(outside, path.join(root, "lessons", "planted"), "dir");
    expect(h.store.memory.list("t1").map((item) => item.ref)).toEqual([saved.ref]);
    expect(() => h.store.memory.save("t1", { ...entry, branch: "lessons", topic: "planted", slug: "planted" })).toThrow("invalid_ref");
    expect(fs.readdirSync(outside)).toEqual(["planted.md"]);
    // 갈래 자체가 밖을 가리키면 그 아래 주제 디렉터리도 만들지 않는다.
    fs.symlinkSync(outside, path.join(root, "crew"), "dir");
    expect(() => h.store.memory.save("t1", { ...entry, branch: "crew", topic: "lineups", slug: "x" })).toThrow("invalid_ref");
    expect(fs.readdirSync(outside)).toEqual(["planted.md"]);

    // 필드 없는 갱신은 다시 확인한 것 — 검증 시각만 오른다. 삭제는 빈 주제를 걷고 인덱스를 비운다.
    clock = 5_000;
    expect(h.store.memory.update("t1", saved.ref, {})).toMatchObject({ change: "verify", entry: { updated: 1_000, verified: 5_000 } });
    h.store.memory.remove("t1", saved.ref);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf8")).toBe("");
    expect(h.events.flatMap((event) => (event.op === "memory" ? [event.change] : []))).toEqual(["save", "save", "delete", "verify", "delete"]);
  });
});

describe("commodore session", () => {
  function agentStub() {
    const created: AgentSessionOptions[] = [];
    const sent: string[] = [];
    let emit: ((event: AgentEvent) => void) | undefined;
    let disposed = 0;
    const agent: AgentHost = {
      createSession: async (options) => {
        created.push(options);
        emit = options.onEvent;
        return {
          send: async (text) => { if (typeof text !== "string") throw new Error("Expected text-only turn"); sent.push(text); await script(text); },
          steer: () => false, cancel: () => undefined,
          dispose: async () => { disposed += 1; },
        };
      },
    };
    let script: (text: string) => Promise<void> = async () => undefined;
    return { agent, created, sent, emit: (event: AgentEvent) => emit?.(event), setScript: (next: typeof script) => { script = next; }, disposedCount: () => disposed };
  }

  it("opens a plugin-owned session with the base prompt only, wakes with reasons only, and keeps a redacted log", async () => {
    const h = harness();
    const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
    fs.mkdirSync(theaterRoot, { recursive: true });
    // Theater 의 프로젝트 MCP 서버 — 사령관 세션에는 싣지 않는다.
    fs.writeFileSync(path.join(theaterRoot, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["./mcp.js"] } } }));
    const outside = path.join(h.objectivesDir, "..", "..", "..", "outside.txt");
    h.store.setDescription("t1", "Fix remote first.");
    h.store.addIntel("t1", { text: "older" });
    const newest = h.store.addIntel("t1", { text: "newest" }).item;
    h.store.setSources("t1", [{ kind: "github-issues", label: "feedback", locator: "acme/fleet" }, { kind: "url", label: "forum", locator: "https://example.test/forum" }]);
    const stub = agentStub();
    const commands: { file: string; args: readonly string[] }[] = [];
    const session = createCommodoreSession({
      commodoreId: "t1", cwd: h.objectivesDir, theaterLabel: "fleet-harness", theaterRoot, agent: stub.agent, store: h.store,
      theaters: () => [{ theaterId: "th1", label: "fleet-harness", root: theaterRoot }, { theaterId: "th2", label: "gone", root: null }],
      coordinates: { model: "opus[1m]", effort: "high" }, boardTools: [
        defineConsoleTool({ name: "console_objectives", description: "list", actions: { inbox: { kind: "read", input: z.object({}) } } }).plugin({ execute: async () => ({ content: [] }) }),
        defineConsoleTool({ name: "console_objectives_detail", description: "objective", actions: { complete: { kind: "write", input: z.object({ objectiveId: z.string() }) } } })
          .plugin({ execute: async (args) => (args as { action?: unknown }).action === "complete" ? { content: [{ type: "text", text: JSON.stringify({ error: "not_awaiting_review", hint: "secret hint" }) }], isError: true } : { content: [] } }),
      ], now: () => 10_000,
      execute: async (file, args) => { commands.push({ file, args }); return { stdout: JSON.stringify([{ number: 7, title: "Pairing drops", state: "OPEN", updatedAt: "2026-10-01T00:00:00Z", labels: [{ name: "bug" }], url: "https://example.test/7" }]), stderr: "" }; },
    });

    stub.setScript(async () => {
      // 호스트처럼 도구를 먼저 실행하고(결과는 세션 이벤트에 실리지 않는다) tool-end 로 끝만 알린다.
      await stub.created[0]!.tools!.custom![1]!.tools[1]!.execute({ action: "complete", objectiveId: "o2" }, { cwd: theaterRoot, toolCallId: "u0" });
      stub.emit({ kind: "tool-start", id: "u0", name: "mcp__console__console_objectives_detail", input: { action: "complete", objectiveId: "o2" } });
      stub.emit({ kind: "tool-end", id: "u0", isError: true });
      stub.emit({ kind: "thinking", text: "The description " }); stub.emit({ kind: "thinking", text: "changed." });
      stub.emit({ kind: "tool-start", id: "u1", name: "mcp__commodore__description", input: {} });
      stub.emit({ kind: "tool-end", id: "u1", isError: false });
      stub.emit({ kind: "text", text: "Completing " }); stub.emit({ kind: "text", text: "the pairing objective." });
      stub.emit({ kind: "tool-start", id: "u2", name: "mcp__console__console_objectives_detail", input: { action: "complete", batchId: "secret detail that must not be logged", objectiveId: "o1", title: "Remote pairing" } });
      stub.emit({ kind: "tool-end", id: "u2", isError: false });
      stub.emit({ kind: "tool-start", id: "u3", name: "mcp__console__console_objectives", input: { action: "inbox" } });
      stub.emit({ kind: "tool-end", id: "u3", isError: false });
      stub.emit({ kind: "tool-start", id: "u4", name: "Read", input: { file_path: outside } });
      stub.emit({ kind: "tool-end", id: "u4", isError: false });
      stub.emit({ kind: "tool-start", id: "u5", name: "Glob", input: { pattern: `${outside}/**` } });
      stub.emit({ kind: "tool-end", id: "u5", isError: true });
      stub.emit({ kind: "result", isError: false, source: "message", usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.25 } });
    });
    const outcome = await session.turn({ reasons: ["description changed (rev 1)", "1 new intel item"] });
    expect(outcome).toMatchObject({ outcome: "ok", actions: 1, usage: { costUsd: 0.25 } });

    // 세션 — 베이스 프롬프트뿐이고 지시·정보 본문은 프롬프트에도 깨움 턴에도 없다.
    const options = stub.created[0]!;
    expect(options).toMatchObject({ model: "opus[1m]", effort: "high", continuation: "conversation" });
    expect(options.systemPrompt).toContain("owner UUID t1");
    expect(options.systemPrompt).toContain("The person reads the log in English.");
    expect(options.systemPrompt).not.toContain("Fix remote first.");
    expect(options.tools).toMatchObject({ builtins: ["WebSearch", "WebFetch", "Read", "Bash", "Glob", "Grep", "Skill"], browser: { scopeId: "commodore:t1" } });
    // Theater 들은 추가 폴더로(그 프로젝트 스킬) 붙고, 그 .mcp.json 서버는 건네지 않는다.
    expect(options.workspace?.additionalDirectories).toEqual([theaterRoot]);
    expect(options.workspace?.mcpServers).toBeUndefined();
    expect(options.tools!.consoleUse).toBeUndefined();
    expect(options.tools!.custom!.map((group) => [group.name, group.tools.map((tool) => tool.name)])).toEqual([["commodore", ["description", "intel", "routines", "routine_add", "routine_update", "routine_remove", "ask_person", "withdraw_ask", "asks", "memory_view", "memory_save", "memory_update", "memory_delete", "issue_list"]], ["console", ["console_objectives", "console_objectives_detail"]]]);
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]).toMatch(/^\[wake \d\d:\d\d · prompt v\d+\] description changed \(rev 1\); 1 new intel item\.\n\nYour fleet-memory is empty\.\n\nCurrent added Theaters: \[\{"theaterId":"th1","label":"fleet-harness","root":".+"\},\{"theaterId":"th2","label":"gone","available":false\}\]\n\nCurrent alias: none\. You have no alias for this turn\.$/);
    expect(stub.sent[0]).not.toContain("newest");

    // 기록 — 사고·텍스트는 블록으로, 보드 행위는 action·objectiveId·title 만, 도구 입력의 나머지는 없다.
    const log = h.store.transcriptRead("t1").entries;
    expect(log.map((entry) => entry.kind)).toEqual(["wake", "tool", "thinking", "tool", "text", "tool", "tool", "tool", "tool", "result"]);
    // 거절된 보드 행위는 코드 한 낱말로 남고 행위로 세지 않는다 — 결과의 힌트는 싣지 않는다.
    expect(log[1]).toMatchObject({ kind: "tool", name: "console_objectives_detail", action: "complete", objectiveId: "o2", ok: false, error: "not_awaiting_review" });
    expect(log[2]).toMatchObject({ kind: "thinking", text: "The description changed." });
    expect(log[3]).toMatchObject({ kind: "tool", name: "description", ok: true });
    expect(log[5]).toMatchObject({ kind: "tool", name: "console_objectives_detail", action: "complete", objectiveId: "o1", title: "Remote pairing", ok: true });
    expect(JSON.stringify(log)).not.toContain("secret");
    // 내장 Read의 경로, Glob 에 넘긴 절대 경로는 기록 요약에도 싣지 않는다.
    expect(log[7]).toMatchObject({ kind: "tool", name: "Read", ok: true });
    expect(log[7]).not.toHaveProperty("summary");
    expect(log[8]).toMatchObject({ kind: "tool", name: "Glob", ok: false });
    expect(log[8]).not.toHaveProperty("summary");
    expect(JSON.stringify(log)).not.toContain(outside);
    expect(log[9]).toMatchObject({ kind: "result", outcome: "ok", costUsd: 0.25, inputTokens: 1200 });
    expect(h.store.read("t1")!.run).toEqual({ session: 0, costUsd: 0.25, actions: 1 });

    // 사령관 전용 도구 — 지시·정보는 저장소에서.
    const tools = Object.fromEntries(options.tools!.custom![0]!.tools.map((tool) => [tool.name, tool]));
    const call = async (name: string, args: Record<string, unknown>) => await tools[name]!.execute(args, { cwd: theaterRoot }) as { isError: boolean; structuredContent: Record<string, unknown> };
    expect((await call("description", {})).structuredContent).toMatchObject({ text: "Fix remote first.", rev: 1 });
    const intel = (await call("intel", {})).structuredContent as { items: { text: string }[]; sources: { kind: string }[] };
    expect(intel.items.map((item) => item.text)).toEqual(["newest", "older"]);
    expect(intel.sources.map((source) => source.kind)).toEqual(["github-issues", "url"]);
    expect(((await call("intel", { since: newest.id })).structuredContent as { items: unknown[] }).items).toEqual([]);
    // 이미 본 항목이 그 뒤에 고쳐지면 since 로도 보인다 — id 와 자리는 그대로, editedAt 이 붙는다.
    const olderId = h.store.read("t1")!.intel[1]!.id;
    h.store.editIntel("t1", olderId, "older, corrected");
    expect(((await call("intel", { since: newest.id })).structuredContent as { items: unknown[] }).items).toEqual([{ id: olderId, at: expect.any(String), editedAt: expect.any(String), source: "person", text: "older, corrected" }]);
    const routine = (await call("routine_add", { name: "Check merge", task: "Read the review", schedule: { kind: "every", minutes: 60 } })).structuredContent;
    expect(routine).toMatchObject({ enabled: true, name: "Check merge" });
    const routineId = routine.id as string;
    h.setAuthorized(false);
    expect((await h.route("commodore/routine-toggle", { commodoreId: "t1", routineId, enabled: false })).status).toBe(401);
    h.setAuthorized(true);
    expect((await h.route("commodore/routine-toggle", { commodoreId: "t1", routineId, enabled: false })).status).toBe(200);
    expect((await call("routine_update", { routineId, enabled: true })).structuredContent).toMatchObject({ error: "routine_paused_by_person" });
    await call("routine_update", { routineId, task: "Read the corrected review" });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => {} }).read("t1")?.routines).toMatchObject([{ enabled: false, pausedBy: "person" }]);
    await h.route("commodore/routine-toggle", { commodoreId: "t1", routineId, enabled: true });
    expect((await call("routine_update", { routineId, enabled: false })).isError).toBe(false);
    expect((await call("routine_update", { routineId, enabled: true })).isError).toBe(false);
    expect((await call("routine_add", { name: "Check merge", task: "Duplicate", schedule: { kind: "every", minutes: 60 } })).structuredContent).toMatchObject({ error: "routine_name_taken" });
    expect((await call("routines", {})).structuredContent).toMatchObject({ routines: [{ id: routineId, nextRunAt: expect.any(Number) }] });
    expect((await call("routine_remove", { routineId, reason: "Finished" })).isError).toBe(false);
    expect(h.store.read("t1")?.routines).toEqual([]);
    const sources = h.store.read("t1")!.sources;
    expect((await call("issue_list", { sourceId: sources[0]!.id })).structuredContent).toMatchObject({ issues: [{ number: 7, labels: ["bug"] }] });
    expect(commands.at(-1)).toMatchObject({ file: "gh", args: ["issue", "list", "-R", "acme/fleet", "--state", "open", "--limit", "30", "--json", "number,title,state,updatedAt,labels,url"] });
    expect((await call("issue_list", { sourceId: sources[1]!.id })).structuredContent).toMatchObject({ hint: expect.stringContaining("WebFetch") });

    // fleet-memory — 사령관 도구로만 쓰고, 다음 깨움부터 인덱스가 턴에 실린다. 출처는 이 Theater 보드의 목표만 받는다.
    expect((await call("memory_save", { branch: "lessons", topic: "Console E2E", slug: "offline-keeps-sse", title: "Offline keeps SSE", description: "CDP offline leaves an open EventSource alive.", why: "A reconnect repro stayed connected.", how: "Fire onerror on a hooked EventSource.", sourceObjectiveIds: ["elsewhere"] })).structuredContent).toMatchObject({ error: "unknown_objective" });
    expect((await call("memory_save", { branch: "lessons", topic: "Console E2E", slug: "offline-keeps-sse", title: "Offline keeps SSE", description: "CDP offline leaves an open EventSource alive.", why: "A reconnect repro stayed connected.", how: "Fire onerror on a hooked EventSource." })).structuredContent).toMatchObject({ ref: "lessons/Console E2E/offline-keeps-sse" });
    expect((await call("memory_view", {})).structuredContent).toMatchObject({ entries: [{ ref: "lessons/Console E2E/offline-keeps-sse" }] });

    // 턴 오류는 결말로 돌아오고 기록에 남는다; 폐기는 세션을 닫는다.
    stub.setScript(async () => { throw new Error("rate limit exceeded (429)"); });
    expect(await session.turn({ reasons: ["routine"] })).toMatchObject({ outcome: "error", error: "rate_limited" });
    expect(stub.sent[1]).toContain("Your fleet-memory index (read an entry with memory_view):");
    expect(stub.sent[1]).toContain("CDP offline leaves an open EventSource alive.");
    expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "result", outcome: "error", error: "rate_limited" });
    // 최종 응답의 OpenUI 진단은 다음 모델 입력에 한 번만 싣고, 공개 기록·미리보기에는 남기지 않는다.
    const malformed = "```openui-lang\nnot a valid root\n```";
    const feedback = openUIFeedbackNote(malformed)!;
    expect(feedback).toBeTruthy();
    stub.setScript(async () => {
      stub.emit({ kind: "text", text: malformed });
      stub.emit({ kind: "tool-start", id: "openui-check", name: "Read", input: {} });
      stub.emit({ kind: "tool-end", id: "openui-check", isError: false });
      stub.emit({ kind: "text", text: "Done." });
      stub.emit({ kind: "result", isError: false, source: "message" });
    });
    await session.turn({ reasons: ["message"] });
    stub.setScript(async () => { stub.emit({ kind: "result", isError: false, source: "message" }); });
    await session.turn({ reasons: ["routine"] });
    const feedbackInput = stub.sent.at(-1)!;
    expect(feedbackInput).toContain(feedback);
    const serializedFeedback = JSON.stringify(feedback).slice(1, -1);
    expect(JSON.stringify(h.store.transcriptRead("t1"))).not.toContain(serializedFeedback);
    expect(JSON.stringify(h.store.transcriptLast("t1"))).not.toContain(serializedFeedback);
    await session.turn({ reasons: ["routine"] });
    expect(stub.sent.at(-1)).not.toContain(feedback);
    await session.dispose();
    expect(stub.disposedCount()).toBe(1);
    await expect(session.turn({ reasons: ["routine"] })).rejects.toThrow("session_disposed");
  });
});

describe("commodore supervisor", () => {
  it("owns accepted images beyond the draft TTL, delivers blocks and releases success, clear and undelivered messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const h = harness(Date.now);
    const files = createLaunchAttachmentStore({ dataDir: h.objectivesDir, now: Date.now });
    const attachments = files.forPlugin("objectives");
    Object.assign(h.ctx.host, { attachments });
    const turns: AgentInput[] = [];
    let readTurnAttachments: CommodoreAttachmentReader | undefined;
    let activeId: string | undefined;
    const copies: Uint8Array[] = [];
    const foreign = files.save(Buffer.from("iVBORw0KGgo=", "base64")).id;
    attachments.claim("t2", "another-message", [foreign], MAX_COMMODORE_MESSAGE_IMAGE_BYTES);
    const rejected: string[] = [];
    let fail = true;
    let created = 0;
    const agent: AgentHost = { createSession: async (options) => { created += 1; return ({
      send: async (input) => {
        turns.push(input);
        if (activeId && readTurnAttachments) {
          copies.push(readTurnAttachments([activeId])[0]!.bytes);
          try { readTurnAttachments([foreign]); } catch (error) { rejected.push((error as Error).message); }
        }
        options.onEvent?.({ kind: "result", isError: fail, source: "message", ...(fail ? { detail: "network" } : {}) });
      },
      steer: () => false, cancel() {}, dispose: async () => undefined,
    }); } };
    const supervisor = createCommodoreSupervisor({ store: h.store, agent, attachments, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }), objectives: () => [], subscribeObjectives: () => () => undefined, boardTools: (_theaterId, read) => { readTurnAttachments = read; return []; }, emit: () => undefined });
    const hooks = { acceptsMessage: (id: string) => supervisor.acceptsMessage(id), run: (id: string) => supervisor.status(id), clear: (id: string) => supervisor.clear(id) };
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const sendImage = async (bytes = png) => {
      const { id } = files.save(bytes);
      activeId = id;
      const result = await h.route("commodore/message", { commodoreId: "t1", text: "Look at this", attachmentIds: [id] }, hooks);
      return { id, result, entry: result.value.entry as { messageId: string } };
    };
    try {
      const accepted = await sendImage();
      expect(accepted.result.status).toBe(200);
      files.discard(accepted.id); // 브라우저의 늦은 제거는 서버가 수락한 메시지를 건드리지 못한다.
      expect(files.forPlugin("other").read("t1", accepted.entry.messageId)).toEqual([]);
      expect((await h.route("commodore/message", { commodoreId: "t1", text: "again", attachmentIds: [accepted.id] }, hooks)).status).toBe(400);
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      files.assertSaveCapacity();
      expect(attachments.read("t1", accepted.entry.messageId)[0]!.bytes).toEqual(png);
      // 실패 뒤의 보존은 다음 재시도 턴을 위한 것이다 — 턴 밖의 도구는 그 바이트를 읽지 못한다.
      expect(() => readTurnAttachments!([accepted.id])).toThrow("attachment_not_available");
      fail = false;
      await supervisor.retry("t1");
      const delivered = turns.at(-1)!;
      expect(typeof delivered).not.toBe("string");
      expect(delivered).toEqual(expect.arrayContaining([{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }]));
      expect(attachments.read("t1", accepted.entry.messageId)).toEqual([]);
      // 전달 원본은 거뒀어도 기록 사본은 재시작 뒤까지 남고, 브라우저는 경로 없이 같은 출처 라우트로 읽는다.
      const previewQuery = { commodoreId: "t1", messageId: accepted.entry.messageId, attachmentId: accepted.id };
      expect(await h.route("commodore/attachment", previewQuery)).toMatchObject({ status: 200, value: { bytes: png, headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } } });
      expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).images.read("t1", accepted.entry.messageId, accepted.id)?.bytes).toEqual(png);
      expect(JSON.stringify(accepted.result.value)).not.toContain(h.objectivesDir);
      expect(accepted.result.value.entry).toMatchObject({ attachments: [{ id: accepted.id, preview: true }] });
      expect(copies.at(-1)).toEqual(png);
      expect(rejected).toEqual(expect.arrayContaining(["attachment_not_available"]));
      expect(() => readTurnAttachments!([accepted.id])).toThrow("attachment_not_available");
      expect((delivered as Exclude<AgentInput, string>).filter((block) => block.type === "text").some((block) => block.text.includes(accepted.id))).toBe(true);
      // raw 12 MiB와 같아도 파일마다 붙는 padding으로 base64 16 MiB를 넘기 전에 교대한다.
      await supervisor.clear("t1");
      expect((await h.route("commodore/attachment", previewQuery)).status).toBe(404);
      expect(fs.existsSync(path.join(h.objectivesDir, "images"))).toBe(false);
      const beforeBudget = created;
      const fourMiB = Buffer.alloc(4 * 1024 * 1024); png.copy(fourMiB);
      for (let index = 0; index < 3; index += 1) {
        expect((await sendImage(fourMiB)).result.status).toBe(200);
        await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      }
      expect(created - beforeBudget).toBe(2);
      const tooLarge = Buffer.alloc(MAX_COMMODORE_MESSAGE_IMAGE_BYTES + 1); png.copy(tooLarge);
      const over = await sendImage(tooLarge);
      expect(over.result).toMatchObject({ status: 400, value: { error: "attachment_budget_exceeded" } });
      expect(files.resolve([over.id])).toHaveLength(1); files.unreserve([over.id]); files.discard(over.id);
      const cleared = await sendImage();
      await supervisor.clear("t1");
      expect(attachments.read("t1", cleared.entry.messageId)).toEqual([]);
      const stopped = await sendImage();
      await Promise.resolve(); await supervisor.dispose();
      expect(attachments.read("t1", stopped.entry.messageId)).toEqual([]);
      expect(h.store.transcriptRead("t1").entries.some((entry) => entry.kind === "undelivered")).toBe(true);
    } finally { await supervisor.dispose(); attachments.dispose(); files.cleanup(); vi.useRealTimers(); }
  });
  it("clears the active session and transcript without losing standing state or reviving deleted history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const h = harness(Date.now);
    const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
    let hold = true;
    let cancel: (() => void) | undefined;
    const agent: AgentHost = { createSession: async (options) => {
      const entry = { options, sent: [] as string[], disposed: false }; sessions.push(entry);
      return {
        send: async (text) => { if (typeof text !== "string") throw new Error("Expected text-only turn"); entry.sent.push(text); if (hold) await new Promise<void>((resolve) => { cancel = () => { options.onEvent?.({ kind: "cancelled" }); resolve(); }; }); else options.onEvent?.({ kind: "result", isError: false, source: "message" }); },
        steer: () => false, cancel: () => cancel?.(), dispose: async () => { entry.disposed = true; },
      };
    } };
    const supervisor = createCommodoreSupervisor({ store: h.store, agent, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }), objectives: () => [], subscribeObjectives: () => () => undefined, boardTools: () => [], emit: () => undefined });
    const hooks = { acceptsMessage: (id: string) => supervisor.acceptsMessage(id), clear: (id: string) => supervisor.clear(id), run: (id: string) => supervisor.status(id) };
    try {
      h.setExperiments({ commodore: true });
      h.store.setDescription("t1", "Keep the description.");
      h.store.addIntel("t1", { text: "Keep the intel." });
      h.store.setSources("t1", [{ kind: "url", label: "Reference", locator: "https://example.com" }]);
      h.store.setCoordinates("t1", { model: "sonnet", effort: "high" });
      h.store.setCommander("t1", { model: "opus[1m]", effort: "high" });
      h.store.routineAdd("t1", { name: "Standing routine", task: "Keep the routine", schedule: { kind: "every", minutes: 120 } });
      h.store.transcriptAppend("t1", { kind: "message", text: "Old active instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      h.store.transcriptAppend("t1", { kind: "message", text: "Old queued instruction." });
      const before = h.store.read("t1")!;
      const file = path.join(h.objectivesDir, "transcript.jsonl");
      const oldRaw = fs.readFileSync(file, "utf8");
      expect((await h.route("commodore/clear", { commodoreId: "t1" }, hooks)).status).toBe(400);
      h.setAuthorized(false);
      expect((await h.route("commodore/clear", { commodoreId: "t1", confirm: true }, hooks)).status).toBe(401);
      h.setAuthorized(true);
      expect((await h.route("commodore/clear", { commodoreId: "t1", confirm: true }, hooks)).status).toBe(200);
      expect(sessions[0]!.disposed).toBe(true);
      expect(h.store.read("t1")).toEqual({ ...before, transcriptClearedThrough: expect.any(Number) });
      expect(fs.existsSync(file)).toBe(false);
      expect(h.store.transcriptRead("t1").entries).toEqual([]);
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      expect(supervisor.status("t1")?.context).toBeUndefined();
      // 폐기된 SDK의 늦은 스트림 콜백도 기록 파일을 되살릴 수 없다.
      sessions[0]!.options.onEvent?.({ kind: "text", text: "Late old response" });
      sessions[0]!.options.onEvent?.({ kind: "result", isError: false, source: "message" });
      expect(fs.existsSync(file)).toBe(false);
      // 경계 영속 뒤 파일 삭제 전에 내려간 경우도 새 저장소는 옛 줄을 감춘다.
      fs.writeFileSync(file, oldRaw);
      const reopened = createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined });
      expect(reopened.transcriptRead("t1").entries).toEqual([]);
      fs.rmSync(file);
      hold = false;
      h.store.transcriptAppend("t1", { kind: "message", text: "A fresh instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sessions).toHaveLength(2);
      expect(sessions[1]!.sent[0]).toContain("A fresh instruction.");
      expect(sessions[1]!.sent[0]).not.toMatch(/Old active|Old queued|replacement session|recent actions/);
      expect(h.store.transcriptRead("t1").entries.every((entry) => entry.seq > h.store.read("t1")!.transcriptClearedThrough!)).toBe(true);
      expect(h.events.some((event) => event.op === "state" && event.change === "clear")).toBe(true);
      // 다른 창의 끄기가 runner를 목록에서 내린 직후에도, Clear는 그 세션의 마지막 기록까지 기다린다.
      hold = true;
      h.store.transcriptAppend("t1", { kind: "message", text: "Stopping while clearing." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      await supervisor.clear("t1");
      await vi.advanceTimersByTimeAsync(1);
      expect(fs.existsSync(file)).toBe(false);
      expect(h.store.transcriptRead("t1").entries).toEqual([]);
    } finally { await supervisor.dispose(); vi.useRealTimers(); }
  });
  it("runs only enabled routines, removes one-time schedules, defers person removals and skips missed repeats on restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const h = harness(Date.now);
    h.store.setDescription("t1", "Keep routines scoped.");
    const sent: string[] = [];
    let fail = false;
    let holdTurn = false;
    let finishTurn: (() => void) | undefined;
    const agent: AgentHost = { createSession: async (options) => ({
      send: async (input) => {
        sent.push(input as string);
        if (holdTurn) await new Promise<void>((resolve) => { finishTurn = resolve; });
        options.onEvent?.({ kind: "result", isError: fail, source: "message", ...(fail ? { detail: "network" } : {}) });
      },
      steer: () => false, cancel() { finishTurn?.(); }, dispose: async () => {},
    }) };
    const make = (store = h.store) => createHostSupervisor({ store, agent, experiments: h.experiments, theaterIds: () => [], cwd: () => h.objectivesDir, theater: () => null,
      board: () => ({ tools: () => [], watch: () => ({ dispose() {}, recount: () => new Map(), emptyOperated: () => false, scope: () => null, brief: () => null, attribute: (tool) => tool }), objective: () => null }), emit: () => {},
    });
    let supervisor = make();
    try {
      supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(24 * TEST_HOUR_MS);
      expect(sent).toEqual([]); // 루틴 없는 기본 상태에는 주기적 깨움이 없다.
      const repeating = h.store.routineAdd("t1", { name: "Read issues", task: "Check the issue source", schedule: { kind: "every", minutes: 60 } });
      const once = h.store.routineAdd("t1", { name: "Check review", task: "Read the review result", schedule: { kind: "once", at: Date.now() + 60_000 } });
      await h.route("commodore/routine-toggle", { commodoreId: "t1", routineId: repeating.id, enabled: false });
      await vi.advanceTimersByTimeAsync(TEST_HOUR_MS + COALESCE_MS);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Check review: Read the review result");
      expect(h.store.read("t1")?.routines?.some((r) => r.id === once.id)).toBe(false);
      await h.route("commodore/routine-toggle", { commodoreId: "t1", routineId: repeating.id, enabled: true });
      await vi.advanceTimersByTimeAsync(TEST_HOUR_MS + COALESCE_MS);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain("Read issues: Check the issue source");
      expect(h.store.read("t1")?.routines?.[0]?.lastRunAt).toEqual(expect.any(Number));
      // 모음 시간 안에 꺼도 이미 예약된 깨움이 실행하지 않는다.
      const cancelled = h.store.routineAdd("t1", { name: "Cancel me", task: "Must not run", schedule: { kind: "once", at: Date.now() + 1_000 } });
      await vi.advanceTimersByTimeAsync(1_001);
      await h.route("commodore/routine-toggle", { commodoreId: "t1", routineId: cancelled.id, enabled: false });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
      expect(sent).toHaveLength(2);
      await h.route("commodore/routine-remove", { commodoreId: "t1", routineId: cancelled.id });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sent).toHaveLength(2);
      h.store.transcriptAppend("t1", { kind: "message", text: "What changed?" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sent.at(-1)).toContain('The person removed routine "Cancel me"');
      expect(h.store.read("t1")?.routineNotices).toEqual([]);
      const overdue = h.store.routineAdd("t1", { name: "Overdue", task: "Run after restart", schedule: { kind: "once", at: Date.now() + 60_000 } });
      await supervisor.dispose();
      await vi.advanceTimersByTimeAsync(48 * TEST_HOUR_MS);
      const restored = createCommodoreStore({ dirOf: () => h.objectivesDir, commodoreIds: () => ["t1"], emit: () => {}, now: Date.now });
      supervisor = make(restored); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sent).toHaveLength(4);
      expect(sent.at(-1)).toContain("Overdue: Run after restart");
      expect(sent.at(-1)).not.toContain("Read issues: Check the issue source");
      expect(restored.read("t1")?.routines?.some((r) => r.id === overdue.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(TEST_HOUR_MS + COALESCE_MS);
      expect(sent).toHaveLength(5);
      expect(sent.at(-1)).toContain("Read issues: Check the issue source");
      // 일회성은 목록에서 사라져도 턴 중 다른 루틴이 깨운 뒤 실패하면 두 할 일을 함께 재시도한다.
      fail = true;
      holdTurn = true;
      const retryOnce = restored.routineAdd("t1", { name: "Retry once", task: "Retry this task", schedule: { kind: "once", at: Date.now() + 1_000 } });
      await vi.advanceTimersByTimeAsync(1_000 + COALESCE_MS + 1);
      expect(sent).toHaveLength(6);
      expect(supervisor.status("t1")?.phase).toBe("turn");
      expect(restored.read("t1")?.routines?.some((r) => r.id === retryOnce.id)).toBe(false);
      restored.routineAdd("t1", { name: "Concurrent routine", task: "Keep this new task too", schedule: { kind: "once", at: Date.now() + 1_000 } });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(sent).toHaveLength(6);
      expect(supervisor.status("t1")?.phase).toBe("turn");
      holdTurn = false;
      finishTurn!();
      await vi.advanceTimersByTimeAsync(1);
      expect(supervisor.status("t1")?.phase).toBe("retrying");
      fail = false;
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! + 1);
      expect(sent).toHaveLength(7);
      expect(sent.at(-1)).toContain("Concurrent routine: Keep this new task too");
      expect(sent.at(-1)).toContain("Retry once: Retry this task");
      // 요일·지역 시각의 달력 일정도 같은 깨움 경계를 통과한다.
      const daily = new Date(Date.now() + 2 * 60_000); daily.setSeconds(0, 0);
      restored.routineAdd("t1", { name: "Daily check", task: "Read the board", schedule: { kind: "daily", time: `${String(daily.getHours()).padStart(2, "0")}:${String(daily.getMinutes()).padStart(2, "0")}`, days: [daily.getDay()] } });
      await vi.advanceTimersByTimeAsync(daily.getTime() - Date.now() + COALESCE_MS + 1);
      expect(sent).toHaveLength(8);
      expect(sent.at(-1)).toContain("Daily check: Read the board");
      fail = true;
      const pausedRetry = restored.routineAdd("t1", { name: "Pause retry", task: "Do not retry after pause", schedule: { kind: "every", minutes: 30 } });
      await vi.advanceTimersByTimeAsync(30 * 60_000 + COALESCE_MS + 1);
      expect(sent).toHaveLength(9);
      restored.routineUpdate("t1", pausedRetry.id, { enabled: false }, "person");
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! + 1);
      expect(sent).toHaveLength(9);
      expect(supervisor.status("t1")?.phase).toBe("idle");
    } finally { await supervisor.dispose(); vi.useRealTimers(); }
  });
  it("hands messages to the running turn, returns unread ones to the queue, and opens a fresh conversation with a transcript summary across restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    try {
      const h = harness(Date.now);
      h.setExperiments({ commodore: true });
      const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
      fs.mkdirSync(theaterRoot, { recursive: true });
      // 남는 대화를 흉내 내는 호스트 — key 마다 대화가 남고, 같은 key 로 다시 열면 이어 받는다. 도는 턴은 건넨 말을 받는다.
      const sessions: { sent: string[]; steered: { text: string; id: string }[]; emit: (event: AgentEvent) => void; finish: () => void }[] = [];
      let managementTool: ConsoleMcpTool | undefined;
      const createCommodore = vi.fn(() => ({ commodoreId: "new", target: "commodore:new" }));
      const createInput = { action: "create", alias: "Browser", theaters: [theaterRoot], description: "Private description", intel: ["Private intel"] };
      const callCreate = () => managementTool!.execute(createInput, { cwd: theaterRoot, toolCallId: "create-browser" });
      const agent: AgentHost = {
        createSession: async (options) => {
          managementTool = options.tools?.custom?.find((group) => group.name === "console")?.tools.find((tool) => tool.name === "console_commodores");
          let finish = () => {};
          const entry = { sent: [] as string[], steered: [] as { text: string; id: string }[], emit: (event: AgentEvent) => options.onEvent?.(event), finish: () => finish() };
          sessions.push(entry);
          let turning = false; let cancelled = false;
          return {
            send: async (text) => { entry.sent.push(text as string); turning = true; cancelled = false; await new Promise<void>((resolve) => { finish = resolve; }); turning = false; options.onEvent?.(cancelled ? { kind: "cancelled" } : { kind: "result", isError: false, source: "message" }); },
            steer: (text, id) => { if (!turning) return false; entry.steered.push({ text: text as string, id }); return true; },
            cancel: () => { for (const { id } of entry.steered) options.onEvent?.({ kind: "input-cancelled", id }); cancelled = true; finish(); },
            dispose: async () => undefined,
          };
        },
      };
      let hasPersonMessage: (() => boolean) | undefined;
      const objectives: Objective[] = [];
      let commanderActivity: "running" | "idle" = "idle";
      let lifecycle: "dormant" | "live" = "dormant";
      let revision = 0;
      const resumeFailures: { objectiveId: string; title: string; error: string }[] = [];
      const make = () => createCommodoreSupervisor({ store: h.store, agent, experiments: () => h.experiments(), theater: () => ({ label: "x", root: theaterRoot }), objectives: () => objectives, subscribeObjectives: () => () => undefined, observe: restClock(() => ({ lifecycle, activity: commanderActivity, generation: "g1", output: { revision } })), resumeFailures: { take: () => resumeFailures.splice(0), subscribe: () => () => undefined }, boardTools: (_theaterId, _readAttachments, hasMessage) => { hasPersonMessage = hasMessage; return []; }, managementTools: (_id, turn) => createCommodoreManagementTools({ hasPersonMessage: turn.hasPersonMessage, stopping: turn.stopping, list: () => [], create: createCommodore }), emit: () => undefined });
      let supervisor = make();
      h.store.read("t1");
      // 지난 종료가 듣지 못한 빈 보드 알림 — 다음 기동이 다시 깨운다.
      h.store.transcriptAppend("t1", { kind: "unheard", codes: ["empty"] });
      h.store.transcriptAppend("t1", { kind: "session", event: "stopped", reason: "Console stopping" });
      supervisor.sync("started");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.sent).toHaveLength(1);
      expect(hasPersonMessage!()).toBe(false);
      expect(managementTool).toBeDefined();
      expect(await callCreate()).toMatchObject({ isError: true, structuredContent: { error: "person_message_required" } });
      expect(createCommodore).not.toHaveBeenCalled();
      // 턴 중의 말 — 다음 턴을 기다리지 않고 도는 턴에 건넨다. 그 턴이 집으면 「전달됨」이 남고 다음 턴은 서지 않는다.
      const read = h.store.transcriptAppend("t1", { kind: "message", text: "Use Muse Spark for new commanders." });
      expect(sessions[0]!.steered).toEqual([{ text: expect.stringContaining("Use Muse Spark for new commanders."), id: `m${read.seq}` }]);
      expect(hasPersonMessage!()).toBe(false);
      expect(await callCreate()).toMatchObject({ isError: true, structuredContent: { error: "person_message_required" } });
      sessions[0]!.emit({ kind: "input-started", id: `m${read.seq}` });
      expect(hasPersonMessage!()).toBe(true);
      expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "delivered", seqs: [read.seq] });
      sessions[0]!.emit({ kind: "tool-start", id: "create-browser", name: "mcp__console__console_commodores", input: createInput });
      expect(await callCreate()).toMatchObject({ isError: false, structuredContent: { commodoreId: "new" } });
      expect(createCommodore).toHaveBeenCalledTimes(1);
      sessions[0]!.emit({ kind: "tool-end", id: "create-browser", isError: false });
      const createdEntry = h.store.transcriptRead("t1").entries.at(-1)!;
      expect(createdEntry).toEqual({ seq: expect.any(Number), at: expect.any(Number), kind: "tool", name: "console_commodores", ok: true, action: "create", commodoreId: "new", alias: "Browser" });
      // 집히지 못한 말은 대기열로 돌아와 다음 턴에 실린다 — 잃지 않는다.
      const unread = h.store.transcriptAppend("t1", { kind: "message", text: "And check the roster." });
      sessions[0]!.emit({ kind: "input-cancelled", id: `m${unread.seq}` });
      sessions[0]!.finish();
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(2);
      expect(sessions[0]!.sent[1]).toContain("And check the roster.");
      expect(sessions[0]!.sent[1]).not.toContain("Use Muse Spark");
      expect(hasPersonMessage!()).toBe(true);
      sessions[0]!.finish();
      await vi.advanceTimersByTimeAsync(10);
      expect(hasPersonMessage!()).toBe(false);
      expect(await callCreate()).toMatchObject({ isError: true, structuredContent: { error: "person_message_required" } });
      expect(createCommodore).toHaveBeenCalledTimes(1);

      // Console 재시작 — 재시작만으로는 깨우지 않는다(빈 보드도 다시 알리지 않는다). 새 대화의 첫 턴은 제품 기록의 최근 결과 요약을 싣는다.
      await supervisor.dispose();
      supervisor = make();
      supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      h.store.transcriptAppend("t1", { kind: "message", text: "Status?" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(2);
      expect(sessions[1]!.sent).toHaveLength(1);
      expect(sessions[1]!.sent[0]).not.toContain("Console restarted");
      expect(sessions[1]!.sent[0]).toContain("2026-10-17T12:");
      expect(sessions[1]!.sent[0]).toContain("board actions");
      expect(h.store.read("t1")!.run!.session).toBe(2);
      sessions[1]!.finish();
      await vi.advanceTimersByTimeAsync(10);
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      // 끊긴 턴의 말은 새 대화에 다시 싣는다.
      const cut = h.store.transcriptAppend("t1", { kind: "message", text: "Recheck the roster." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions.at(-1)!.sent.at(-1)).toContain("Recheck the roster.");
      await supervisor.dispose(); // Console 종료는 진행 턴을 취소하고 미전달 말을 보존한다.
      const lines = () => h.store.transcriptRead("t1").entries.flatMap((entry) => (entry.kind === "undelivered" || entry.kind === "requeued" ? [`${entry.kind}:${entry.seqs.join(",")}`] : []));
      expect(lines().at(-1)).toBe(`undelivered:${cut.seq}`);
      supervisor = make(); supervisor.sync("restart");
      await supervisor.dispose();
      expect(lines().slice(-2)).toEqual([`requeued:${cut.seq}`, `undelivered:${cut.seq}`]);
      supervisor = make(); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(lines().at(-1)).toBe(`requeued:${cut.seq}`);
      expect(sessions.at(-1)!.sent.at(-1)).toContain("Recheck the roster.");
      sessions.at(-1)!.finish(); await vi.advanceTimersByTimeAsync(10);
      // Clear 는 남은 대화를 버린다 — 다음 세션은 새 대화다.
      await supervisor.clear("t1");
      h.store.transcriptAppend("t1", { kind: "message", text: "After clear." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions.at(-1)!.sent[0]).not.toContain("board actions");
      sessions.at(-1)!.finish();
      await vi.advanceTimersByTimeAsync(10);
      await supervisor.dispose();

      // 재기동 당시 진행·구상·인계 대기만 남은 목표는 스스로 잇는다. 시간이 지나거나 live 로 복원된 것만으로는 깨우지 않는다.
      const running = { id: "o1", theaterId: "t1", title: "Resuming", createdAt: Date.now(), commodoreOperated: true, done: null, removed: null, commenced: true, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, decisionRequestRevision: 0, criteriaProposals: [], followups: [], followupBatches: [], personHolds: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective;
      objectives.push(running, { ...running, id: "o2", commenced: false, planning: true, missions: [] }, { ...running, id: "o3", awaitingHandoff: true, missions: [{ ...running.missions[0]!, done: true }] });
      const settleWait = SETTLE_MS + SETTLE_CHECK_MS + COALESCE_MS + 10;
      const beforeRestart = sessions.length;
      const wakes = () => h.store.transcriptRead("t1").entries.filter((entry) => entry.kind === "wake");
      const beforeWakes = wakes().length;
      supervisor = make(); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(settleWait * 2);
      lifecycle = "live";
      await vi.advanceTimersByTimeAsync(settleWait * 2);
      expect(sessions).toHaveLength(beforeRestart);
      expect(wakes()).toHaveLength(beforeWakes);
      // 자동 재개 턴이 돌고 끝나도 보드가 같으면 재기동만의 깨움이다. 보드가 앞으로 간 뒤의 쉼만 평시처럼 깨운다.
      commanderActivity = "running";
      await vi.advanceTimersByTimeAsync(SETTLE_CHECK_MS);
      commanderActivity = "idle";
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions).toHaveLength(beforeRestart);
      expect(wakes()).toHaveLength(beforeWakes);
      for (const objective of objectives) Object.assign(objective, { boardUpdatedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions).toHaveLength(beforeRestart + 1);
      expect(wakes().at(-1)).toMatchObject({ reasons: ["settled:3"] });
      sessions.at(-1)!.finish(); await vi.advanceTimersByTimeAsync(10);
      await supervisor.dispose();
      // 점검 사이 짧은 재개 턴도 보드 불변이면 깨우지 않는다 — 세션 revision 은 보드의 전진이 아니다.
      objectives.splice(1);
      supervisor = make(); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions).toHaveLength(beforeRestart + 1);
      revision++;
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions).toHaveLength(beforeRestart + 1);
      Object.assign(running, { boardUpdatedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions).toHaveLength(beforeRestart + 2);
      expect(wakes().at(-1)).toMatchObject({ reasons: ["settled:1"] });
      sessions.at(-1)!.finish(); await vi.advanceTimersByTimeAsync(10);
      await supervisor.dispose();
      // 끌 때 아직 듣지 못한 대기만 다음 기동이 다시 깨운다. 이미 들었거나 재기동만 거친 대기는 깨우지 않는다.
      Object.assign(running, { awaitingReview: true });
      supervisor = make(); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(settleWait * 2);
      expect(sessions).toHaveLength(beforeRestart + 2);
      Object.assign(running, { boardUpdatedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions).toHaveLength(beforeRestart + 3);
      await supervisor.dispose(); // 깨운 턴이 끝나기 전에 꺼진다.
      expect(h.store.transcriptRead("t1").entries.slice(-2)).toMatchObject([{ kind: "unheard", codes: ["settled"], objectiveIds: [running.id] }, { kind: "session", event: "stopped" }]);
      supervisor = make(); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(beforeRestart + 4);
      expect(wakes().at(-1)).toMatchObject({ reasons: ["settled:1"] });
      expect(sessions.at(-1)!.sent[0]).toContain("waits on you: awaiting review");
      sessions.at(-1)!.finish(); await vi.advanceTimersByTimeAsync(10);
      await supervisor.dispose();
      supervisor = make(); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(settleWait * 2);
      expect(sessions).toHaveLength(beforeRestart + 4);
      await supervisor.dispose();
      // 스스로 잇지 못한 목표는 진행 상태뿐이어도 별도의 resume-failed 경로로 알린다.
      Object.assign(running, { awaitingReview: false, personHolds: [] });
      resumeFailures.push({ objectiveId: running.id, title: running.title, error: "resume unavailable" });
      supervisor = make(); supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(beforeRestart + 5);
      expect(wakes().at(-1)).toMatchObject({ reasons: ["resume-failed:1"] });
      sessions.at(-1)!.finish(); await vi.advanceTimersByTimeAsync(settleWait * 2);
      expect(sessions.at(-1)!.sent).toHaveLength(1);
      await supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("closes a late-opening session without sending a turn after the board becomes unavailable", async () => {
    vi.useFakeTimers();
    const h = harness(Date.now);
    h.store.setDescription("t1", "Wait for the board.");
    let available = true;
    let release: (() => void) | undefined;
    const sent = vi.fn(), disposed = vi.fn();
    const agent: AgentHost = { createSession: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { send: async () => { sent(); }, steer: () => false, cancel() {}, dispose: async () => { disposed(); } };
    } };
    const supervisor = createHostSupervisor({ store: h.store, agent, experiments: h.experiments, theaterIds: () => [], cwd: () => h.objectivesDir, theater: () => null,
      board: () => available ? ({ tools: () => [], watch: () => ({ dispose() {}, recount: () => new Map(), emptyOperated: () => false, scope: () => null, brief: () => null, attribute: (tool) => tool }), objective: () => null }) : null, emit: () => {},
    });
    try {
      supervisor.sync("restart");
      h.store.transcriptAppend("t1", { kind: "message", text: "Start a turn." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(release).toBeDefined();
      available = false; supervisor.sync(); release!();
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).not.toHaveBeenCalled();
      expect(disposed).toHaveBeenCalledTimes(1);
      expect(supervisor.status("t1")).toBeNull();
    } finally { release?.(); await supervisor.dispose(); vi.useRealTimers(); }
  });

  it("restores on register, coalesces events without periodic wakes, retries failures, compacts long sessions and preserves input on shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    try {
      const h = harness();
      // Theater 모델은 Gateway에서 꺼져 있다 — 저장값은 그대로 두고 로스터 폴백(sonnet)으로 열며 그 사실을 기록에 남긴다.
      h.setExperiments({ commodore: true });
      h.store.setCoordinates("t1", { model: "codex--gpt-6-luna", effort: "medium" });
      const sonnetRow = { id: "sonnet", label: "Sonnet", launch: { model: "sonnet" }, chips: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ id: effort, label: effort, launch: { model: "sonnet", effort } })) };
      // 설치된 Claude Code가 별칭을 푸는 정식 id — 사령관은 그 id로 열고, 회전은 별칭 좌표로 판정한다.
      const models = {
        resolve: (stored: ModelCoordinate, _target: unknown, fallback?: ModelCoordinate) => ({ ...resolveRosterCoordinate([{ id: "gateway:claude", label: "Claude", rows: [sonnetRow] }], stored, fallback ?? { model: "sonnet" }), wireModel: "sonnet" }),
        pinClaudeVersion: async (model: string) => model === "sonnet" ? "claude-sonnet-installed" : model,
      };
      h.store.setLanguage("t1", "ko");
      const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
      fs.mkdirSync(theaterRoot, { recursive: true });
      const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
      let fail: string | null = null;
      let inputTokens = 1_000;
      let compaction: { readonly preTokens: number; readonly postTokens: number } | null = null;
      let compactionFails = false;
      let holdTurn = false;
      let completeOnCancel = false;
      let cancelTurn: (() => void) | undefined;
      const agent: AgentHost = {
        createSession: async (options) => {
          const entry = { options, sent: [] as string[], disposed: false };
          sessions.push(entry);
          return {
            send: async (text) => {
              if (typeof text !== "string") throw new Error("Expected text-only turn"); entry.sent.push(text);
              if (fail) throw new Error(fail);
              if (holdTurn) {
                await new Promise<void>((resolve) => { cancelTurn = () => { options.onEvent?.(completeOnCancel ? { kind: "result", isError: false, source: "message" } : { kind: "cancelled" }); cancelTurn = undefined; resolve(); }; });
                return;
              }
              if (compaction) { options.onEvent?.({ kind: "compacted", trigger: "auto", ...compaction }); compaction = null; }
              // 요약이 실패한 채 창을 넘긴 세션 — Claude Code(2.1.296 실측)는 압축 실패를 알리고 턴을 오류로 끝내며, 다음 턴도 같다.
              if (compactionFails) {
                options.onEvent?.({ kind: "compact-failed" });
                options.onEvent?.({ kind: "result", isError: true, source: "message", detail: "Prompt is too long · automatic compaction failed", usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 } });
                return;
              }
              options.onEvent?.({ kind: "text", text: "ok" });
              // 턴 합계(inputTokens)는 도구 호출마다 다시 더해진 값이고, 대화 크기는 마지막 호출의 입력(contextTokens)이다.
              options.onEvent?.({ kind: "result", isError: false, source: "message", usage: { inputTokens: inputTokens * 2, outputTokens: 10, costUsd: 0.01, contextTokens: inputTokens } });
            },
            steer: () => false, cancel: () => cancelTurn?.(),
            dispose: async () => { entry.disposed = true; },
          };
        },
      };
      const objectives: Objective[] = [];
      const boardListeners: ((event: ObjectiveEvent) => void)[] = [];
      const commanderActivity = new Map<string, "running" | "background">();
      // 띄운 적 없는 목표 — 관측이 없으니 그룹 대화도 없다.
      const sessionless = new Set<string>();
      const runs: CommodoreEvent[] = [];
      const restNotices: string[] = [];
      const supervisor = createCommodoreSupervisor({
        store: h.store, agent, experiments: () => h.experiments(), models, theater: () => ({ label: "fleet-harness", root: theaterRoot }),
        objectives: () => objectives, subscribeObjectives: (listener) => { boardListeners.push(listener); return () => undefined; },
        // 사령관의 보드 쓰기 — 개시하면 그 목표가 진행 중이 되고 사건이 난다(실제 도구처럼 쓰는 동안).
        // 지휘관이 일하는 동안의 개시는 실제 도구처럼 objective_busy 로 거절된다.
        boardTools: () => [{ name: "console_objectives_detail", description: "", inputSchema: {}, execute: async (args) => {
          const target = objectives.find((objective) => objective.id === (args as { objectiveId?: string }).objectiveId);
          if (target && commanderActivity.has(target.id)) return { content: [], structuredContent: { error: "objective_busy", retryWhen: "commander_turn_end" }, isError: true };
          if (target) { (target as unknown as { commenced: boolean }).commenced = true; for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: target.id }); }
          return { content: [] };
        } }], observe: restClock((id) => sessionless.has(id) ? null : ({ lifecycle: "live", activity: commanderActivity.get(id) ?? "idle", surface: "chat", supportedActions: [], attention: { kind: "none" }, output: { revision: 0, outcome: "none" } } as never)),
        notifyCommanderRest: async (id) => { restNotices.push(id); return true; },
        emit: (event) => { if (event.op === "run") runs.push(event); },
      });
      const tokens = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "wake" ? [entry.reasons] : []);
      const sessionEvents = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "session" ? [entry.event] : []);

      // 등록 복원 — 재시작 자체는 깨움이 아니다. 지난 실행이 종료를 남기지 못하고 끝났으면(열린 세션이 마지막) 무엇을 듣지 못했는지
      // 모르므로 빈 보드도 다시 알린다.
      h.store.transcriptAppend("t1", { kind: "session", event: "opened", model: "claude-sonnet-installed", effort: "medium" });
      supervisor.sync("restart");
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.options).toMatchObject({ model: "claude-sonnet-installed", effort: "medium" });
      expect(sessions[0]!.options.systemPrompt).toContain("The person reads the log in Korean.");
      expect(tokens()).toEqual([["empty"]]);
      expect(sessionEvents()).toEqual(["opened", "restarted"]);
      expect(h.store.transcriptRead("t1").entries.findLast((entry) => entry.kind === "session")).toMatchObject({ reason: "fallback:model_off:sonnet[1m]" });
      expect(h.store.read("t1")?.model).toBe("codex--gpt-6-luna");
      expect(sessions[0]!.sent[0]).toContain("the board has no open objective you operate");
      expect(sessions[0]!.sent[0]).not.toContain("Console restarted");
      expect(supervisor.status("t1")!.nextWakeAt).toBeUndefined();
      expect(h.store.read("t1")!.run).toMatchObject({ session: 1, costUsd: 0.01 });

      // 지시·정보·메시지 — 몇 초 안의 이유는 한 턴으로, 정보는 누적 수로, 메시지는 본문째.
      h.store.setDescription("t1", "Ship remote first.");
      const first = h.store.addIntel("t1", { text: "a" }).item; h.store.addIntel("t1", { text: "b" });
      // 수정은 새 정보가 아니라 수정으로 깨운다 — 같은 항목을 거듭 고쳐도 한 항목이다.
      h.store.editIntel("t1", first.id, "a2"); h.store.editIntel("t1", first.id, "a3");
      // 턴 전에 지운 새 정보는 추가·수정 이유 모두에서 빠져 기존 수와 문장을 바꾸지 않는다.
      const cancelled = h.store.addIntel("t1", { text: "cancelled" }).item;
      h.store.editIntel("t1", cancelled.id, "cancelled edit");
      h.store.removeIntel("t1", cancelled.id);
      h.store.transcriptAppend("t1", { kind: "message", text: "Keep objectives small." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["description", "intel:2", "intel-edited:1", "message"]);
      const note = sessions[0]!.sent.at(-1)!;
      expect(note).toContain(`description changed: rev 1; 2 new intel items; the person edited 1 intel item: ${first.id}; the person sent you a message`);
      expect(note).toContain("> Keep objectives small.");
      expect(note).not.toContain("Ship remote first.");

      // 남은 이유가 없는 취소는 모델 턴과 빈 깨움 기록을 만들지 않는다.
      const wakesBeforeCancel = tokens().length;
      const turnsBeforeCancel = sessions[0]!.sent.length;
      const transient = h.store.addIntel("t1", { text: "transient" }).item;
      h.store.editIntel("t1", transient.id, "transient edit");
      h.store.removeIntel("t1", transient.id);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens()).toHaveLength(wakesBeforeCancel);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeCancel);
      // 보드 — 기준 제안과 단계 이동은 그룹이 일하는 동안 깨우지 않지만, 결정 요청은 지휘관 턴이 끝나기 전에 바로 싣는다.
      // 결정으로 깨운 보드가 그대로면 나중에 그룹이 대기 중으로 들어서도 중복으로 깨우지 않는다.
      const settleWait = SETTLE_MS + SETTLE_CHECK_MS + COALESCE_MS + 10;
      const turnsBeforeBoard = sessions[0]!.sent.length;
      commanderActivity.set("o1", "running");
      objectives.push({ id: "o1", theaterId: "t1", title: "Remote pairing", createdAt: Date.now(), commodoreOperated: true, done: null, removed: null, commenced: false, planning: true, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, decisionRequestRevision: 0, criteriaProposals: [{ id: "c1" }], followups: [], followupBatches: [], personHolds: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective);
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard);
      Object.assign(objectives[0]!, { decisionRequest: { id: "q1" }, decisionRequestRevision: 1, boardUpdatedAt: Date.now() });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["decision:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain("inbox: 1 decision request");
      expect(sessions[0]!.sent.at(-1)).toContain('Board at wake:\n- o1 "Remote pairing"\n  status: planning · missions 0/1 done\n  waits on you: criteria proposal, decision request\n  group: commander running · no members\n  since your last turn: new → planning');
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 1);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(settleWait * 2);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 1);
      // 결정 이후 보드가 앞으로 가면 새 대기 항목은 여전히 그룹이 쉴 때 싣는다.
      commanderActivity.set("o1", "running");
      Object.assign(objectives[0]!, { criteriaProposals: [{ id: "c2" }], boardUpdatedAt: Date.now() });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 1);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(tokens().at(-1)).toEqual(["settled:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('1 objective group went idle: "Remote pairing".\n\nBoard at wake:\n- o1 "Remote pairing"\n  status: planning · missions 0/1 done\n  waits on you: criteria proposal, decision request\n  group: idle 0 min · commander idle · no members');
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 2);
      // 지휘관이 다시 일하는 동안의 개시는 objective_busy 로 거절된다 — 그 일이 끝나 대기 중이 되면 보드가 그대로여도 다시 깨운다.
      const board = sessions[0]!.options.tools!.custom!.find((group) => group.tools.some((tool) => tool.name === "console_objectives_detail"))!.tools.find((tool) => tool.name === "console_objectives_detail")!;
      commanderActivity.set("o1", "running");
      expect(await board.execute({ action: "commence", objectiveId: "o1" }, { cwd: theaterRoot })).toMatchObject({ isError: true });
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(tokens().at(-1)).toEqual(["settled:1"]);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 3);
      // 구성원 실패는 보드 시계를 옮기지 않아도 새 실패로 다시 깨운다.
      Object.assign(objectives[0]!, { members: [{ id: "w0", role: "implementer", sessionName: null, failure: { error: "rate_limit", consecutiveFailures: 1 } }] });
      await vi.advanceTimersByTimeAsync(SETTLE_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["settled:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain("waits on you: criteria proposal, decision request, failed member turn");
      // 사령관 자신의 쓰기(개시)는 깨우지 않는다.
      Object.assign(objectives[0]!, { planning: false, criteriaProposals: [], decisionRequest: null, members: [], boardUpdatedAt: Date.now() });
      await board.execute({ action: "commence", objectiveId: "o1" }, { cwd: theaterRoot });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 4);

      // 다른 목표의 단계 이동은 깨우지 않고 다음 턴 요약에 실린다. 사람에게 넘긴 항목만 기다리며 멈춘 그룹도 깨우지 않는다.
      commanderActivity.set("o2", "running");
      objectives.push({ id: "o2", theaterId: "t1", title: "Lineup", createdAt: Date.now(), commodoreOperated: true, done: null, removed: null, commenced: false, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, decisionRequestRevision: 0, criteriaProposals: [], followups: [], followupBatches: [], personHolds: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective);
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o2" });
      (objectives[1] as unknown as { commenced: boolean }).commenced = true;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o2" });
      const hold = { target: "review", requestId: null, reason: "Product call", at: Date.now(), by: { kind: "commodore" }, settled: null as unknown };
      Object.assign(objectives[0]!, { awaitingReview: true, personHolds: [hold], boardUpdatedAt: Date.now() });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 4);
      // 사람이 돌려주면 바로 깨우고, 그 목표의 요약과 깨우지 않은 이동이 함께 간다. 같은 보드로 대기 중 깨움을 또 하지 않는다.
      hold.settled = { at: Date.now(), by: { kind: "person" }, outcome: "returned" };
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["returned:1"]);
      const returned = sessions[0]!.sent.at(-1)!;
      expect(returned).toContain('- o1 "Remote pairing"\n  status: awaiting review · missions 0/1 done\n  waits on you: awaiting review\n  group: idle 0 min · commander idle · no members\n  since your last turn: in progress → awaiting review');
      expect(returned).toContain('Other objectives moved since your last turn:\n- "Lineup": new → lineup ready; lineup ready → in progress');
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 5);

      // 사람이 운영하는 목표 — 생기고 옮겨 가도 깨우지 않는다(다음 턴의 범위 줄에만 남는다). 사람이 맡기면 한 번 바로 깨우고,
      // 그 턴의 범위 줄에 목표 id·운영 판정·코드가 남는다. 돌려받은 뒤의 변화는 다시 깨우지 않는다.
      sessionless.add("o3");
      const human = { id: "o3", theaterId: "t1", title: "Person's own", createdAt: Date.now(), done: null, removed: null, commenced: false, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, decisionRequestRevision: 0, criteriaProposals: [], followups: [], followupBatches: [], missions: [] as { id: string; text: string; done: boolean }[] } as unknown as Objective & { commodoreOperated?: boolean; planning: boolean; missions: { id: string; text: string; done: boolean }[] };
      objectives.push(human);
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      human.planning = true;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 5);
      human.planning = false;
      human.commodoreOperated = true;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('"Person\'s own" handed to you by the person (not started)');
      const entries = h.store.transcriptRead("t1").entries;
      expect(entries.at(-1)).toMatchObject({ kind: "result" });
      expect(entries.slice(-4, -2)).toMatchObject([{ kind: "wake", reasons: ["status:1"] }, { kind: "wake-scope", woke: [{ id: "o3", operator: "commodore", codes: ["status"] }], held: [{ id: "o3", operator: "human", codes: ["pending", "status"] }] }]);
      human.commodoreOperated = false;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      human.missions.push({ id: "m1", text: "x", done: false });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      await vi.advanceTimersByTimeAsync(settleWait);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeBoard + 6);
      Object.assign(objectives[0]!, { awaitingReview: false, personHolds: [] });
      (objectives[1] as unknown as { missions: { done: boolean }[] }).missions[0]!.done = true;
      commanderActivity.delete("o2");

      // 막힌 항목 — 구성원이 일해 그룹이 대기 중이 되지 않아도, 지휘관이 쉰 지 1분이면 기준 수정안으로 한 번 깨운다. 지휘관이 일하는
      // 동안은 쉼 시계가 가지 않는다. 같은 보드로 그룹이 나중에 대기 중이 되어도 다시 깨우지 않는다.
      (objectives[0] as unknown as { members: unknown[] }).members.push({ id: "w1", role: "implementer", sessionName: "objective-o1-member-1" });
      commanderActivity.set("w1", "running");
      commanderActivity.set("o1", "running");
      Object.assign(objectives[0]!, { criteriaProposals: [{ id: "c3" }], boardUpdatedAt: Date.now() });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      const beforeBlocked = sessions[0]!.sent.length;
      await vi.advanceTimersByTimeAsync(BLOCK_MS + settleWait);
      expect(sessions[0]!.sent).toHaveLength(beforeBlocked);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(BLOCK_MS - 5_000);
      expect(sessions[0]!.sent).toHaveLength(beforeBlocked);
      await vi.advanceTimersByTimeAsync(5_000 + 2 * SETTLE_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["criteria:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('- o1 "Remote pairing"\n  status: in progress · missions 0/1 done\n  waits on you: criteria proposal\n  group: commander idle · members: implementer running');
      expect(sessions[0]!.sent).toHaveLength(beforeBlocked + 1);
      // 마지막 제안이 승인된 뒤 다음 점검 전에 새 제안이 서도 새 항목이다 — 지휘관이 계속 쉬면 다시 한 번 깨운다.
      Object.assign(objectives[0]!, { criteriaProposals: [], boardUpdatedAt: Date.now() });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      Object.assign(objectives[0]!, { criteriaProposals: [{ id: "c4" }], boardUpdatedAt: Date.now() + 1 });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(65_000 + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["criteria:1"]);
      expect(sessions[0]!.sent).toHaveLength(beforeBlocked + 2);
      commanderActivity.delete("w1");
      await vi.advanceTimersByTimeAsync(settleWait * 2);
      expect(sessions[0]!.sent).toHaveLength(beforeBlocked + 2);
      Object.assign(objectives[0]!, { criteriaProposals: [], boardUpdatedAt: Date.now() });

      // 정체 — 구성원이 일하는 동안 지휘관이 15분 쉬면 한 번 깨우고 지휘관에게 사실을 보낸다. 15분 안에 움직인 지휘관은 정체가 아니다.
      // 구성원이 일하는 그룹은 대기 중이 아니므로 그사이 대기 중 깨움도 없다.
      commanderActivity.set("w1", "running");
      commanderActivity.set("o1", "running");
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
      const beforeRest = sessions[0]!.sent.length;
      await vi.advanceTimersByTimeAsync(COMMANDER_REST_MS - STALL_CHECK_MS);
      expect(sessions[0]!.sent).toHaveLength(beforeRest);
      expect(restNotices).toEqual([]);
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["stalled:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain("1 stalled objective: Remote pairing");
      expect(supervisor.status("t1")).toMatchObject({ stalled: ["o1"] });
      expect(restNotices).toEqual(["o1"]);
      // 통지 때문에 생긴 지휘관 턴은 같은 에피소드다 — 15분을 다시 쉬어도 깨우지 않고 통지도 없다.
      const sentAfterFirstStall = sessions[0]!.sent.length;
      const tokensAfterFirstStall = tokens().length;
      commanderActivity.set("o1", "running");
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(COMMANDER_REST_MS + STALL_CHECK_MS + COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(sentAfterFirstStall);
      expect(tokens()).toHaveLength(tokensAfterFirstStall);
      expect(restNotices).toEqual(["o1"]);
      expect(supervisor.status("t1")).toMatchObject({ stalled: ["o1"] });

      // 이미 전달한 항목의 삭제는 수정 이유를 걷고 별도 이유와 본문 발췌로 한 턴 깨운다.
      h.store.editIntel("t1", first.id, "x".repeat(70));
      h.store.removeIntel("t1", first.id);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["intel-removed:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain(`the person removed 1 intel item: ${first.id} "${"x".repeat(59)}…"`);
      expect(h.store.read("t1")!.intel.some((item) => item.id === first.id)).toBe(false);

      // 오류 — 1·5·15분 뒤 재시도, 자율 운영은 그대로. 사람의 「지금 다시 시도」는 곧바로 한 턴.
      fail = "rate limit exceeded";
      h.store.addIntel("t1", { text: "c" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      const near = (at: number | undefined, expected: number) => { expect(at).toBeGreaterThan(expected - 100); expect(at).toBeLessThanOrEqual(expected); };
      expect(supervisor.status("t1")).toMatchObject({ phase: "retrying", reason: "rate_limited" });
      near(supervisor.status("t1")!.nextWakeAt, Date.now() + RETRY_DELAYS_MS[0]!);
      expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "error", code: "rate_limited" });
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! + 10);
      expect(supervisor.status("t1")!.phase).toBe("retrying");
      near(supervisor.status("t1")!.nextWakeAt, Date.now() + RETRY_DELAYS_MS[1]!);
      fail = null;
      await supervisor.retry("t1");
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      expect(tokens().at(-1)).toEqual(["intel:1", "retry"]);
      await expect(supervisor.retry("t1")).rejects.toThrow("commodore_not_retrying");

      // 압축 — 문맥이 길어져도 세션을 바꾸지 않는다. 세션은 창(폴백 Sonnet 1M)의 75%를 압축 지점으로 받아 같은 세션에서
      // 대화를 요약해 이어 가고, 그 사실이 기록에 남는다. 미터는 턴 합계가 아니라 마지막 호출의 대화 크기와 그 지점을 읽는다.
      expect(sessions[0]!.options.compactAt).toBe(750_000);
      inputTokens = 760_000;
      h.store.addIntel("t1", { text: "d" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(supervisor.status("t1")).toMatchObject({ context: { window: 1_000_000, inputTokens: 760_000, compactAt: 750_000 } });
      compaction = { preTokens: 760_000, postTokens: 12_000 };
      inputTokens = 14_000;
      h.store.addIntel("t1", { text: "e" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.disposed).toBe(false);
      expect(h.store.transcriptRead("t1").entries.find((entry) => entry.kind === "compacted")).toMatchObject({ trigger: "auto", preTokens: 760_000, postTokens: 12_000 });
      expect(supervisor.status("t1")).toMatchObject({ context: { inputTokens: 14_000 } });

      // 교대 — 요약이 실패해 넘친 세션은 같은 세션으로 다시 시도하지 않는다. 다음 시도가 새 세션 + 최근 행위 요약으로 연다.
      compactionFails = true;
      h.store.addIntel("t1", { text: "f" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(supervisor.status("t1")).toMatchObject({ phase: "retrying" });
      expect(sessions).toHaveLength(1);
      compactionFails = false;
      inputTokens = 1_000;
      await supervisor.retry("t1");
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.disposed).toBe(true);
      expect(sessionEvents()).toEqual(["opened", "restarted", "replaced"]);
      expect(tokens().at(-1)).toEqual(["intel:1", "retry", "rotated"]);
      expect(sessions[1]!.sent[0]).toContain("This is a replacement session. Summary of your recent actions");
      expect(h.store.read("t1")!.run!.session).toBe(2);

      // 사람에게 묻기 — 사령관의 질문은 기록에 구조화된 줄로 남고, 사람의 답이 사령관을 「사람이 답함」으로 깨우며 답은 asks 도구로 읽힌다.
      // 끝난 질문은 다른 답으로 덮이지 않고 거둘 수도 없다.
      const commodoreTool = (name: string) => sessions[1]!.options.tools!.custom!.find((group) => group.name === "commodore")!.tools.find((tool) => tool.name === name)!;
      const useTool = async (name: string, args: Record<string, unknown>) => ((await commodoreTool(name).execute(args, { cwd: theaterRoot })) as { structuredContent: Record<string, unknown> }).structuredContent;
      const asked = await useTool("ask_person", { questions: [{ header: "Candidates", text: "Open these candidates as objectives?", options: [{ label: "Open both" }, { label: "Only the first" }] }], reason: "Product direction is the person's call" });
      expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "ask", askId: asked.askId, questions: [{ options: ["Open both", "Only the first"] }] });
      const ask = h.store.read("t1")!.asks!.find((entry) => entry.id === asked.askId)!;
      const answer = (optionIndex: number) => h.route("commodore/ask/answer", { commodoreId: "t1", askId: ask.id, answers: [{ questionId: ask.questions[0]!.id, selectedOptionIds: [ask.questions[0]!.options[optionIndex]!.id], text: "" }] });
      expect((await answer(1)).status).toBe(200);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["answered:1"]);
      expect(sessions[1]!.sent.at(-1)).toContain('the person answered 1 item you handed or asked them: your question "Open these candidates as objectives?"');
      expect(await useTool("asks", {})).toMatchObject({ open: 0, asks: [{ askId: ask.id, state: "answered", answers: [{ question: "Open these candidates as objectives?", selected: ["Only the first"] }] }] });
      expect((await answer(0)).value).toMatchObject({ error: "ask_already_answered" });
      expect((await answer(1)).value).toMatchObject({ repeated: true });
      expect(await useTool("withdraw_ask", { askId: ask.id })).toMatchObject({ error: "ask_already_answered" });
      expect(h.store.read("t1")!.asks!.find((entry) => entry.id === ask.id)!.settled).toMatchObject({ outcome: "answered", answers: [{ selectedOptionIds: [ask.questions[0]!.options[1]!.id] }] });

      // Console 종료는 진행 턴을 거두고 읽지 못한 메시지를 보존한다.
      holdTurn = true;
      const activeMessage = h.store.transcriptAppend("t1", { kind: "message", text: "Cancel this instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(supervisor.status("t1")).toMatchObject({ phase: "turn" });
      const pendingMessage = h.store.transcriptAppend("t1", { kind: "message", text: "Hold the release." });
      await supervisor.dispose();
      expect(sessions[1]!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      expect(h.store.transcriptRead("t1").entries.slice(-3)).toMatchObject([{ kind: "result", outcome: "cancelled" }, { kind: "undelivered", seqs: [activeMessage.seq, pendingMessage.seq] }, { kind: "session", event: "stopped" }]);
      expect(runs.at(-1)).toMatchObject({ op: "run", run: { phase: "off", reason: "Console stopping" } });
    } finally { vi.useRealTimers(); }
  });
});
