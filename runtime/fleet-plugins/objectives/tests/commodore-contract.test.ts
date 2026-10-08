import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentEvent, AgentHost, AgentSessionOptions } from "@fleet-console/sdk/agent";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { resolveRosterCoordinate, type ModelCoordinate } from "@fleet-console/sdk/models";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commodoreActive, createCommodoreRoutes, type CommodoreRouteHooks } from "../server/commodore/routes.js";
import { createCommodoreSession } from "../server/commodore/session.js";
import { createCommodoreStore } from "../server/commodore/store.js";
import { COALESCE_MS, createCommodoreSupervisor, DEFAULT_PATROL_MS, RETRY_DELAYS_MS, STALL_CHECK_MS, STALL_MS } from "../server/commodore/supervisor.js";
import type { CommodoreEvent } from "../server/commodore/types.js";
import type { Objective, ObjectiveEvent } from "../server/types.js";

/**
 * 사령관 Theater 상태의 필수 계약 — 보드 곁 `commodore/` 에 한 건으로 영속되고, 지시 개정은 본문이 바뀔 때만 오르며,
 * 실험 기능이 꺼진 채로는 자율 운영을 켤 수 없고, 기록은 덧붙인 순서대로 쪽을 나눠 읽힌다.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function harness(now?: () => number) {
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
  } as unknown as FleetPluginServerContext;
  let clock = 1_000;
  const store = createCommodoreStore({ dirOf: (theaterId) => (theaterId === "t1" ? objectivesDir : null), emit: (event) => events.push(event), now: now ?? (() => clock++) });
  const route = async (name: string, body: Record<string, unknown>, hooks: CommodoreRouteHooks = {}) => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    await createCommodoreRoutes(ctx, store, hooks).find((entry) => entry.name === name)!.handler({ req: { method: "POST" } as never, res: {} as never, pathname: name });
    return routeResult as { status: number; value: Record<string, unknown> & { state?: Record<string, unknown>; error?: string } };
  };
  return { ctx, store, events, route, objectivesDir, experiments: () => experiments, setExperiments: (next: Partial<typeof experiments>) => { experiments = { ...experiments, ...next }; }, setAuthorized: (next: boolean) => { authorized = next; } };
}

describe("commodore theater state", () => {
  it("persists autonomy, directive and intel beside the board and gates autonomy on the experiment", async () => {
    const h = harness();
    const stateFile = path.join(h.objectivesDir, "commodore", "state.json");

    expect((await h.route("commodore/state", { theaterId: "t1" })).value).toMatchObject({ enabled: false, active: false, run: { phase: "off", totals: { session: 0, costUsd: 0, actions: 0 } }, state: { autonomy: false, directive: { text: "", rev: 0 }, intel: [] } });
    expect((await h.route("commodore/state", { theaterId: "unknown" })).status).toBe(404);
    expect((await h.route("commodore/autonomy", { theaterId: "t1", autonomy: true }))).toMatchObject({ status: 409, value: { error: "commodore_disabled" } });
    expect(fs.existsSync(stateFile)).toBe(false);

    // 옛 Settings 좌표는 무시하지만 Theater 별 선택은 아래 경로에서 유지된다.
    h.setExperiments({ commodore: true, commodoreModel: "haiku", commodoreEffort: "low" });
    expect((await h.route("commodore/autonomy", { theaterId: "t1", autonomy: true })).value).toMatchObject({ active: true, defaults: { model: "opus[1m]", effort: "high" }, run: { phase: "idle" } });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(true);
    // 서랍의 요청이 사람의 언어를 남긴다 — 사령관 기록의 언어가 된다.
    expect((await h.route("commodore/state", { theaterId: "t1", language: "ko" })).value.state).toMatchObject({ language: "ko" });

    // 지시 — 본문이 바뀔 때만 개정이 오르고, 같은 본문은 사건도 내지 않는다(사령관을 헛되이 깨우지 않는다).
    expect((await h.route("commodore/directive", { theaterId: "t1", text: "Fix remote first." })).value.state).toMatchObject({ directive: { text: "Fix remote first.", rev: 1 } });
    const before = h.events.length;
    expect((await h.route("commodore/directive", { theaterId: "t1", text: "Fix remote first." })).value.state).toMatchObject({ directive: { rev: 1 } });
    expect(h.events.length).toBe(before);

    // 정보 — 최신이 앞이고 출처는 사람이다.
    await h.route("commodore/intel/add", { theaterId: "t1", text: "Users report dropped remote sessions." });
    const added = await h.route("commodore/intel/add", { theaterId: "t1", text: "Pairing fails after sleep." });
    expect(added.value.state!.intel).toMatchObject([{ source: "person", text: "Pairing fails after sleep." }, { source: "person", text: "Users report dropped remote sessions." }]);
    expect((await h.route("commodore/intel/remove", { theaterId: "t1", intelId: "nope" })).status).toBe(404);
    expect((await h.route("commodore/coordinates", { theaterId: "t1", model: "sonnet", effort: null })).status).toBe(400);
    // Gateway scoped Claude 표기도 받되 정준 id(실행 id)로 접어 저장한다.
    expect((await h.route("commodore/coordinates", { theaterId: "t1", model: "claude--sonnet", effort: "xhigh" })).value.state).toMatchObject({ model: "sonnet", effort: "xhigh" });

    // 영속 — 새 저장소가 같은 파일에서 같은 상태를 읽고, 실험 기능이 꺼지면 플래그만 꺼진다(저장값은 남는다).
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ autonomy: true, directive: { rev: 1 }, model: "sonnet", effort: "xhigh" });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")).toEqual(h.store.read("t1"));
    // 재시작 복원은 등록된 Theater 를 훑는다 — 읽을 수 없는 Theater 는 빠지고 던지지 않는다.
    expect(createCommodoreStore({ dirOf: (id) => (id === "t1" ? h.objectivesDir : null), theaterIds: () => ["t1", "gone"], emit: () => undefined }).autonomousTheaters()).toEqual(["t1"]);
    h.setExperiments({ commodore: false });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(false);
    expect(h.events.map((event) => event.op === "state" ? event.change : event.op)).toEqual(["autonomy", "language", "directive", "intel", "intel", "coordinates"]);

    // 같은 origin 의 Console 만 지난다.
    h.setAuthorized(false);
    expect((await h.route("commodore/state", { theaterId: "t1" })).status).toBe(401);
  });

  it("refuses messages a stopped Commodore would never read, appends the log in order and pages it from the newest end", async () => {
    const h = harness();
    h.store.transcriptAppend("t1", { kind: "session", event: "opened" });
    h.store.transcriptAppend("t1", { kind: "wake", reasons: ["directive changed"] });
    h.store.transcriptAppend("t1", { kind: "tool", name: "console_objectives", action: "complete", objectiveId: "o1", title: "Remote pairing" });
    // 사령관이 돌지 않으면 메시지는 거절되고 기록에 남지 않는다 — 실험 기능 꺼짐, 그 Theater 의 자율 운영 꺼짐 각각.
    expect(await h.route("commodore/message", { theaterId: "t1", text: "Lost?" })).toMatchObject({ status: 409, value: { error: "commodore_disabled" } });
    h.setExperiments({ commodore: true });
    expect(await h.route("commodore/message", { theaterId: "t1", text: "Lost?" })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    h.store.setAutonomy("t1", true);
    // 설정은 켜졌지만 감독자 알림이 아직 오지 않은 경계 — 받을 runner가 없으면 기록도 남기지 않는다.
    expect(await h.route("commodore/message", { theaterId: "t1", text: "Before the runner." }, { run: () => null })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    const sent = await h.route("commodore/message", { theaterId: "t1", text: "Prefer small objectives." }, { run: () => ({ phase: "idle" }) });
    expect(sent.value.entry).toMatchObject({ seq: 4, kind: "message", text: "Prefer small objectives." });
    expect(h.events.filter((event) => event.op === "transcript")).toHaveLength(4);
    h.setExperiments({ commodore: false });
    expect(await h.route("commodore/message", { theaterId: "t1", text: "Lost?" })).toMatchObject({ status: 409, value: { error: "commodore_disabled" } });

    const page = (await h.route("commodore/transcript", { theaterId: "t1", limit: 2 })).value as { entries: { seq: number; kind: string }[]; hasMore: boolean };
    expect(page.entries.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(page.hasMore).toBe(true);
    const older = (await h.route("commodore/transcript", { theaterId: "t1", limit: 2, before: 3 })).value as { entries: { seq: number }[]; hasMore: boolean };
    expect(older.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(older.hasMore).toBe(false);

    // 재기동 뒤에도 seq 는 이어진다 — 기록 파일이 커서의 진실이다.
    const reopened = createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined });
    expect(reopened.transcriptAppend("t1", { kind: "result", outcome: "ok", costUsd: 0.2 }).seq).toBe(5);
    expect((await h.route("commodore/retry", { theaterId: "t1" }))).toMatchObject({ status: 409, value: { error: "commodore_not_retrying" } });
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
          send: async (text) => { sent.push(text); await script(text); },
          cancel: () => undefined,
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
    fs.mkdirSync(path.join(theaterRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(theaterRoot, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(theaterRoot, "secret.bin"), Buffer.from([0x00, 0x01]));
    const outside = path.join(h.objectivesDir, "..", "..", "..", "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(theaterRoot, "link.txt"));
    h.store.setDirective("t1", "Fix remote first.");
    h.store.addIntel("t1", { text: "older" });
    const newest = h.store.addIntel("t1", { text: "newest" }).item;
    h.store.setSources("t1", [{ kind: "github-issues", label: "feedback", locator: "acme/fleet" }, { kind: "url", label: "forum", locator: "https://example.test/forum" }]);
    const stub = agentStub();
    const wakes: { at: number; reason: string }[] = [];
    const commands: { file: string; args: readonly string[] }[] = [];
    const session = createCommodoreSession({
      theaterId: "t1", theaterLabel: "fleet-harness", theaterRoot, agent: stub.agent, store: h.store,
      coordinates: { model: "opus[1m]", effort: "high" }, boardTools: [{ name: "console_objectives", description: "board", inputSchema: { type: "object", properties: {}, additionalProperties: true }, execute: async (args) => (args as { complete?: unknown }).complete ? { content: [{ type: "text", text: JSON.stringify({ error: "not_awaiting_review", hint: "secret hint" }) }], isError: true } : { content: [] } }], onNextWake: (at, reason) => wakes.push({ at, reason }), now: () => 10_000,
      execute: async (file, args) => { commands.push({ file, args }); return file === "git" ? { stdout: "abc1234\x1f2026-10-03\x1fme\x1ffix: thing\n", stderr: "" } : { stdout: JSON.stringify([{ number: 7, title: "Pairing drops", state: "OPEN", updatedAt: "2026-10-01T00:00:00Z", labels: [{ name: "bug" }], url: "https://example.test/7" }]), stderr: "" }; },
    });

    stub.setScript(async () => {
      // 호스트처럼 도구를 먼저 실행하고(결과는 세션 이벤트에 실리지 않는다) tool-end 로 끝만 알린다.
      await stub.created[0]!.tools!.custom![1]!.tools[0]!.execute({ complete: true, objectiveId: "o2" }, { cwd: theaterRoot, toolCallId: "u0" });
      stub.emit({ kind: "tool-start", id: "u0", name: "mcp__console__console_objectives", input: { complete: true, objectiveId: "o2" } });
      stub.emit({ kind: "tool-end", id: "u0", isError: true });
      stub.emit({ kind: "thinking", text: "The directive " }); stub.emit({ kind: "thinking", text: "changed." });
      stub.emit({ kind: "tool-start", id: "u1", name: "mcp__commodore__directive", input: {} });
      stub.emit({ kind: "tool-end", id: "u1", isError: false });
      stub.emit({ kind: "text", text: "Completing " }); stub.emit({ kind: "text", text: "the pairing objective." });
      stub.emit({ kind: "tool-start", id: "u2", name: "mcp__console__console_objectives", input: { complete: { note: "secret detail that must not be logged" }, objectiveId: "o1", title: "Remote pairing" } });
      stub.emit({ kind: "tool-end", id: "u2", isError: false });
      stub.emit({ kind: "tool-start", id: "u3", name: "mcp__console__console_objectives", input: { view: "inbox" } });
      stub.emit({ kind: "tool-end", id: "u3", isError: false });
      stub.emit({ kind: "result", isError: false, source: "message", usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.25 } });
    });
    const outcome = await session.turn({ reasons: ["directive changed (rev 1)", "1 new intel item"] });
    expect(outcome).toMatchObject({ outcome: "ok", actions: 1, usage: { costUsd: 0.25 } });

    // 세션 — 베이스 프롬프트뿐이고 지시·정보 본문은 프롬프트에도 깨움 턴에도 없다.
    const options = stub.created[0]!;
    expect(options).toMatchObject({ model: "opus[1m]", effort: "high", continuation: "conversation" });
    expect(options.systemPrompt).toContain('Commodore of the Theater "fleet-harness"');
    expect(options.systemPrompt).toContain("The person reads the log in English.");
    expect(options.systemPrompt).not.toContain("Fix remote first.");
    expect(options.tools).toMatchObject({ builtins: ["WebSearch", "WebFetch"] });
    expect(options.tools!.consoleUse).toBeUndefined();
    expect(options.tools!.custom!.map((group) => [group.name, group.tools.map((tool) => tool.name)])).toEqual([["commodore", ["directive", "intel", "next_wake", "read_file", "git_log", "issue_list"]], ["console", ["console_objectives"]]]);
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]).toMatch(/^\[wake \d\d:\d\d · prompt v\d+\] directive changed \(rev 1\); 1 new intel item\.$/);
    expect(stub.sent[0]).not.toContain("newest");

    // 기록 — 사고·텍스트는 블록으로, 보드 행위는 action·objectiveId·title 만, 도구 입력의 나머지는 없다.
    const log = h.store.transcriptRead("t1").entries;
    expect(log.map((entry) => entry.kind)).toEqual(["wake", "tool", "thinking", "tool", "text", "tool", "tool", "result"]);
    // 거절된 보드 행위는 코드 한 낱말로 남고 행위로 세지 않는다 — 결과의 힌트는 싣지 않는다.
    expect(log[1]).toMatchObject({ kind: "tool", name: "console_objectives", action: "complete", objectiveId: "o2", ok: false, error: "not_awaiting_review" });
    expect(log[2]).toMatchObject({ kind: "thinking", text: "The directive changed." });
    expect(log[3]).toMatchObject({ kind: "tool", name: "directive", ok: true });
    expect(log[5]).toMatchObject({ kind: "tool", name: "console_objectives", action: "complete", objectiveId: "o1", title: "Remote pairing", ok: true });
    expect(JSON.stringify(log)).not.toContain("secret");
    expect(log[7]).toMatchObject({ kind: "result", outcome: "ok", costUsd: 0.25, inputTokens: 1200 });
    expect(h.store.read("t1")!.run).toEqual({ session: 0, costUsd: 0.25, actions: 1 });

    // 사령관 전용 도구 — 지시·정보는 저장소에서, 읽기 도구는 Theater 안에서만.
    const tools = Object.fromEntries(options.tools!.custom![0]!.tools.map((tool) => [tool.name, tool]));
    const call = async (name: string, args: Record<string, unknown>) => await tools[name]!.execute(args, { cwd: theaterRoot }) as { isError: boolean; structuredContent: Record<string, unknown> };
    expect((await call("directive", {})).structuredContent).toMatchObject({ text: "Fix remote first.", rev: 1 });
    const intel = (await call("intel", {})).structuredContent as { items: { text: string }[]; sources: { kind: string }[] };
    expect(intel.items.map((item) => item.text)).toEqual(["newest", "older"]);
    expect(intel.sources.map((source) => source.kind)).toEqual(["github-issues", "url"]);
    expect(((await call("intel", { since: newest.id })).structuredContent as { items: unknown[] }).items).toEqual([]);
    expect((await call("next_wake", { inMinutes: 30, reason: "patrol after the merge" })).isError).toBe(false);
    expect(wakes).toEqual([{ at: 10_000 + 30 * 60_000, reason: "patrol after the merge" }]);
    // 사람이 고른 순찰 간격(기본 60분)을 넘는 예약은 거절하지 않고 간격으로 줄인다.
    expect((await call("next_wake", { inMinutes: 90, reason: "too far" })).structuredContent).toMatchObject({ patrolIntervalMinutes: 60, shortened: true });
    expect(wakes.at(-1)).toEqual({ at: 10_000 + 60 * 60_000, reason: "too far" });
    expect((await call("read_file", { path: "src/a.ts" })).structuredContent).toMatchObject({ text: "export const a = 1;\n", truncated: false });
    expect((await call("read_file", { path: "link.txt" })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("read_file", { path: "../outside.txt" })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("read_file", { path: outside })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("read_file", { path: "secret.bin" })).structuredContent).toMatchObject({ error: "binary_file" });
    expect((await call("git_log", { path: "--output=/tmp/x" })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("git_log", { limit: 5, path: "src" })).structuredContent).toMatchObject({ commits: [{ hash: "abc1234", subject: "fix: thing" }] });
    expect(commands.at(-1)).toEqual({ file: "git", args: ["log", "--no-decorate", "--date=short", "--format=%h%x1f%ad%x1f%an%x1f%s", "-n", "5", "--", "src"] });
    const sources = h.store.read("t1")!.sources;
    expect((await call("issue_list", { sourceId: sources[0]!.id })).structuredContent).toMatchObject({ issues: [{ number: 7, labels: ["bug"] }] });
    expect(commands.at(-1)).toMatchObject({ file: "gh", args: ["issue", "list", "-R", "acme/fleet", "--state", "open", "--limit", "30", "--json", "number,title,state,updatedAt,labels,url"] });
    expect((await call("issue_list", { sourceId: sources[1]!.id })).structuredContent).toMatchObject({ hint: expect.stringContaining("WebFetch") });

    // 턴 오류는 결말로 돌아오고 기록에 남는다; 폐기는 세션을 닫는다.
    stub.setScript(async () => { throw new Error("rate limit exceeded (429)"); });
    expect(await session.turn({ reasons: ["patrol"] })).toMatchObject({ outcome: "error", error: "rate_limited" });
    expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "result", outcome: "error", error: "rate_limited" });
    await session.dispose();
    expect(stub.disposedCount()).toBe(1);
    await expect(session.turn({ reasons: ["patrol"] })).rejects.toThrow("session_disposed");
  });
});

describe("commodore supervisor", () => {
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
        send: async (text) => { entry.sent.push(text); if (hold) await new Promise<void>((resolve) => { cancel = () => { options.onEvent?.({ kind: "cancelled" }); resolve(); }; }); else options.onEvent?.({ kind: "result", isError: false, source: "message" }); },
        cancel: () => cancel?.(), dispose: async () => { entry.disposed = true; },
      };
    } };
    const supervisor = createCommodoreSupervisor({ store: h.store, agent, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }), objectives: () => [], subscribeObjectives: () => () => undefined, boardTools: () => [], emit: () => undefined });
    const hooks = { clear: (id: string) => supervisor.clear(id), run: (id: string) => supervisor.status(id) };
    try {
      h.setExperiments({ commodore: true });
      h.store.setDirective("t1", "Keep the directive.");
      h.store.addIntel("t1", { text: "Keep the intel." });
      h.store.setSources("t1", [{ kind: "url", label: "Reference", locator: "https://example.com" }]);
      h.store.setCoordinates("t1", { model: "sonnet", effort: "high" });
      h.store.setCommander("t1", { model: "opus[1m]", effort: "high" });
      h.store.setPatrol("t1", 120);
      h.store.setAutonomy("t1", true);
      h.store.setStopAt("t1", Date.now() + 3 * 60 * 60_000);
      h.store.transcriptAppend("t1", { kind: "message", text: "Old active instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      h.store.transcriptAppend("t1", { kind: "message", text: "Old queued instruction." });
      const before = h.store.read("t1")!;
      const file = path.join(h.objectivesDir, "commodore", "transcript.jsonl");
      const oldRaw = fs.readFileSync(file, "utf8");
      expect((await h.route("commodore/clear", { theaterId: "t1" }, hooks)).status).toBe(400);
      h.setAuthorized(false);
      expect((await h.route("commodore/clear", { theaterId: "t1", confirm: true }, hooks)).status).toBe(401);
      h.setAuthorized(true);
      expect((await h.route("commodore/clear", { theaterId: "t1", confirm: true }, hooks)).status).toBe(200);
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
      h.store.setAutonomy("t1", false);
      await supervisor.clear("t1");
      await vi.advanceTimersByTimeAsync(1);
      expect(fs.existsSync(file)).toBe(false);
      expect(h.store.transcriptRead("t1").entries).toEqual([]);
    } finally { await supervisor.dispose(); vi.useRealTimers(); }
  });
  it("persists a cancellable stop deadline, cancels pending work, notifies once and restores overdue stops without another patrol", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const h = harness(Date.now);
    const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
    let hold = false;
    let failNotice = false;
    let cancel: (() => void) | undefined;
    const boardWrite = vi.fn(async () => ({ content: [] }));
    const agent: AgentHost = { createSession: async (options) => {
      const entry = { options, sent: [] as string[], disposed: false };
      sessions.push(entry);
      return {
        send: async (text) => {
          entry.sent.push(text);
          if (failNotice) throw new Error("rate limit exceeded");
          if (hold) {
            await new Promise<void>((resolve) => { cancel = () => { options.onEvent?.({ kind: "cancelled" }); cancel = undefined; resolve(); }; });
          } else options.onEvent?.({ kind: "result", isError: false, source: "message" });
        },
        cancel: () => cancel?.(),
        dispose: async () => { entry.disposed = true; },
      };
    } };
    const makeSupervisor = (store = h.store) => createCommodoreSupervisor({
      store, agent, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }),
      objectives: () => [], subscribeObjectives: () => () => undefined,
      boardTools: () => [{ name: "console_objectives", description: "", inputSchema: {}, execute: boardWrite }], emit: () => undefined,
    });
    let supervisor = makeSupervisor();
    const hooks = { run: (id: string) => supervisor.status(id) };
    const schedule = (stopAt: number | null) => h.route("commodore/stop-at", { theaterId: "t1", stopAt }, hooks);
    try {
      expect((await schedule(Date.now() + 60_000)).status).toBe(409);
      h.setExperiments({ commodore: true, commodoreModel: "haiku", commodoreEffort: "low" });
      h.store.setAutonomy("t1", true);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sessions[0]!.options).toMatchObject({ model: "opus[1m]", effort: "high" });
      expect((await schedule(Date.now() - 1)).status).toBe(400);
      expect((await schedule(Date.now() + 31 * 86_400_000)).status).toBe(200);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.store.read("t1")!.autonomy).toBe(true);
      const cancelledAt = Date.now() + 1_000;
      await schedule(cancelledAt);
      expect((await schedule(null)).value.state?.stopAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(sessions[0]!.sent).toHaveLength(1);
      h.store.setDirective("t1", "Keep the board intact.");
      h.store.addIntel("t1", { text: "Keep this intel." });
      hold = true;
      const active = h.store.transcriptAppend("t1", { kind: "message", text: "Interrupt me." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      const pending = h.store.transcriptAppend("t1", { kind: "message", text: "Return me to the person." });
      const stopAt = Date.now() + 1_000;
      expect((await schedule(stopAt)).value.state?.stopAt).toBe(stopAt);
      expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")!.stopAt).toBe(stopAt);
      // 종료 알림도 진행 중으로 붙들어 둔다. 그 동안 메시지·보드 쓰기는 받아서는 안 된다.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessions[0]!.sent).toHaveLength(3);
      expect(sessions[0]!.sent.at(-1)).toContain("The scheduled end time has arrived");
      expect(sessions[0]!.sent.at(-1)).not.toContain("Return me to the person.");
      expect((await h.route("commodore/message", { theaterId: "t1", text: "Too late." }, hooks)).value.error).toBe("commodore_stopping");
      expect((await schedule(null)).value.error).toBe("commodore_stopping");
      const tool = sessions[0]!.options.tools!.custom!.flatMap((group) => group.tools).find((tool) => tool.name === "console_objectives")!;
      expect(await tool.execute({ complete: true }, { cwd: h.objectivesDir })).toMatchObject({ isError: true });
      expect(boardWrite).not.toHaveBeenCalled();
      h.store.addIntel("t1", { text: "No new wake." });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(h.store.read("t1")).toMatchObject({ autonomy: false, directive: { text: "Keep the board intact." } });
      expect(h.store.read("t1")!.stopAt).toBeUndefined();
      expect(h.store.read("t1")!.intel).toHaveLength(2);
      expect(sessions[0]!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      const entries = h.store.transcriptRead("t1").entries;
      expect(entries.filter((entry) => entry.kind === "undelivered")).toMatchObject([{ seqs: [active.seq, pending.seq] }]);
      expect(entries.filter((entry) => entry.kind === "wake" && entry.reasons.includes("scheduled-stop"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_PATROL_MS);
      expect(sessions[0]!.sent).toHaveLength(3);

      // 정상 알림 결말에서도 끄기와 같은 상태가 된다. 껐다 켜면 지난 예약은 되살아나지 않는다.
      hold = false;
      h.store.setAutonomy("t1", true);
      await schedule(Date.now() + COALESCE_MS + 1_000);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1_001);
      expect(sessions.at(-1)!.sent).toHaveLength(2);
      expect(sessions.at(-1)!.sent.at(-1)).toContain("The scheduled end time has arrived");
      expect(h.store.transcriptRead("t1").entries.slice(-2)).toMatchObject([{ kind: "result", outcome: "ok" }, { kind: "session", event: "stopped" }]);
      expect(h.store.read("t1")!.autonomy).toBe(false);
      expect(sessions.at(-1)!.disposed).toBe(true);

      // 예약을 남긴 채 Console이 종료되고 기한 뒤 재기동하면, 재시작 순찰 대신 종료 알림만 한 번 간다.
      h.store.setAutonomy("t1", true);
      await schedule(Date.now() + 60_000);
      await supervisor.dispose();
      await vi.advanceTimersByTimeAsync(60_001);
      const restored = createCommodoreStore({ dirOf: () => h.objectivesDir, theaterIds: () => ["t1"], emit: () => undefined });
      failNotice = true;
      supervisor = makeSupervisor(restored);
      supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(1);
      expect(sessions.at(-1)!.sent).toHaveLength(1);
      expect(sessions.at(-1)!.sent[0]).toContain("The scheduled end time has arrived");
      expect(sessions.at(-1)!.sent[0]).not.toContain("Console restarted;");
      expect(restored.read("t1")!.autonomy).toBe(false);
      expect(restored.read("t1")!.stopAt).toBeUndefined();
      expect(sessions.at(-1)!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      await vi.advanceTimersByTimeAsync(DEFAULT_PATROL_MS);
      expect(sessions.at(-1)!.sent).toHaveLength(1);
    } finally { await supervisor.dispose(); vi.useRealTimers(); }
  });
  it("disposes a session that finishes opening after autonomy is turned off", async () => {
    const h = harness();
    h.setExperiments({ commodore: true });
    h.store.setAutonomy("t1", true);
    const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
    fs.mkdirSync(theaterRoot, { recursive: true });
    let release: () => void = () => undefined;
    const opened = { disposed: false, sent: 0 };
    const agent: AgentHost = {
      createSession: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { send: async () => { opened.sent += 1; }, cancel: () => undefined, dispose: async () => { opened.disposed = true; } };
      },
    };
    const supervisor = createCommodoreSupervisor({
      store: h.store, agent, experiments: () => h.experiments(), theater: () => ({ label: "x", root: theaterRoot }),
      objectives: () => [], subscribeObjectives: () => () => undefined, boardTools: () => [], emit: () => undefined,
    });
    supervisor.sync("autonomy");
    await vi.waitFor(() => expect(release).not.toBeUndefined());
    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 50));
    // 세션이 열리는 중에 끈다 — 늦게 열린 세션도 닫히고 턴은 가지 않는다(살아남은 자식 프로세스가 보드를 바꾸지 못하게).
    h.store.setAutonomy("t1", false);
    release();
    await vi.waitFor(() => expect(opened.disposed).toBe(true));
    expect(opened.sent).toBe(0);
    expect(supervisor.status("t1")).toBeNull();
    await supervisor.dispose();
  });

  it("restores on register, coalesces wake reasons, patrols within the ceiling, retries failures, rotates long sessions and stops with autonomy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    try {
      const h = harness();
      // Theater 모델은 Gateway에서 꺼져 있다 — 저장값은 그대로 두고 로스터 폴백(sonnet)으로 열며 그 사실을 기록에 남긴다.
      h.setExperiments({ commodore: true });
      h.store.setCoordinates("t1", { model: "codex--gpt-6-luna", effort: "medium" });
      const sonnetRow = { id: "sonnet", label: "Sonnet", launch: { model: "sonnet" }, chips: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ id: effort, label: effort, launch: { model: "sonnet", effort } })) };
      const models = { resolve: (stored: ModelCoordinate, _target: unknown, fallback?: ModelCoordinate) => ({ ...resolveRosterCoordinate([{ id: "gateway:claude", label: "Claude", rows: [sonnetRow] }], stored, fallback ?? { model: "sonnet" }), wireModel: "sonnet" }) };
      h.store.setAutonomy("t1", true);
      h.store.setLanguage("t1", "ko");
      const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
      fs.mkdirSync(theaterRoot, { recursive: true });
      const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
      let fail: string | null = null;
      let inputTokens = 1_000;
      let holdTurn = false;
      let completeOnCancel = false;
      let cancelTurn: (() => void) | undefined;
      const agent: AgentHost = {
        createSession: async (options) => {
          const entry = { options, sent: [] as string[], disposed: false };
          sessions.push(entry);
          return {
            send: async (text) => {
              entry.sent.push(text);
              if (fail) throw new Error(fail);
              if (holdTurn) {
                await new Promise<void>((resolve) => { cancelTurn = () => { options.onEvent?.(completeOnCancel ? { kind: "result", isError: false, source: "message" } : { kind: "cancelled" }); cancelTurn = undefined; resolve(); }; });
                return;
              }
              options.onEvent?.({ kind: "text", text: "ok" });
              options.onEvent?.({ kind: "result", isError: false, source: "message", usage: { inputTokens, outputTokens: 10, costUsd: 0.01 } });
            },
            cancel: () => cancelTurn?.(),
            dispose: async () => { entry.disposed = true; },
          };
        },
      };
      const objectives: Objective[] = [];
      const boardListeners: ((event: ObjectiveEvent) => void)[] = [];
      const runs: CommodoreEvent[] = [];
      const supervisor = createCommodoreSupervisor({
        store: h.store, agent, experiments: () => h.experiments(), models, theater: () => ({ label: "fleet-harness", root: theaterRoot }),
        objectives: () => objectives, subscribeObjectives: (listener) => { boardListeners.push(listener); return () => undefined; },
        // 사령관의 보드 쓰기 — 개시하면 그 목표가 진행 중이 되고 사건이 난다(실제 도구처럼 쓰는 동안).
        boardTools: () => [{ name: "console_objectives", description: "", inputSchema: {}, execute: async (args) => {
          const target = objectives.find((objective) => objective.id === (args as { objectiveId?: string }).objectiveId);
          if (target) { (target as unknown as { commenced: boolean }).commenced = true; for (const listener of boardListeners) listener({ op: "upsert", theaterId: "t1", objectiveId: target.id }); }
          return { content: [] };
        } }], observe: () => ({ lifecycle: "live", activity: "idle", surface: "chat", supportedActions: [], attention: { kind: "none" }, output: { revision: 0, outcome: "none" } } as never),
        emit: (event) => { if (event.op === "run") runs.push(event); },
      });
      const tokens = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "wake" ? [entry.reasons] : []);
      const sessionEvents = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "session" ? [entry.event] : []);

      // 등록 복원 — 켜진 Theater 는 「재시작」 턴으로 깨어나고, 빈 보드도 이유가 된다.
      supervisor.sync("restart");
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.options).toMatchObject({ model: "sonnet", effort: "medium" });
      expect(sessions[0]!.options.systemPrompt).toContain("The person reads the log in Korean.");
      expect(tokens()).toEqual([["restart", "empty"]]);
      expect(sessionEvents()).toEqual(["restarted"]);
      expect(h.store.transcriptRead("t1").entries.find((entry) => entry.kind === "session")).toMatchObject({ reason: "fallback:model_off:sonnet" });
      expect(h.store.read("t1")?.model).toBe("codex--gpt-6-luna");
      expect(sessions[0]!.sent[0]).toContain("Console restarted; the board is empty");
      const patrolAt = supervisor.status("t1")!.nextWakeAt!;
      expect(supervisor.status("t1")!.phase).toBe("idle");
      expect(patrolAt).toBeGreaterThan(Date.now() + DEFAULT_PATROL_MS - COALESCE_MS - 100);
      expect(patrolAt).toBeLessThanOrEqual(Date.now() + DEFAULT_PATROL_MS);
      // 사람이 순찰 간격을 고치면 잡혀 있던 순찰이 마지막 턴에서 새 간격 뒤로 옮겨지고, 기본으로 되돌리면 원래 시각이다.
      h.store.setPatrol("t1", 15);
      expect(supervisor.status("t1")!.nextWakeAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
      h.store.setPatrol("t1", null);
      expect(supervisor.status("t1")!.nextWakeAt).toBe(patrolAt);
      expect(h.store.read("t1")!.run).toMatchObject({ session: 1, costUsd: 0.01 });

      // 지시·정보·메시지 — 몇 초 안의 이유는 한 턴으로, 정보는 누적 수로, 메시지는 본문째.
      h.store.setDirective("t1", "Ship remote first.");
      h.store.addIntel("t1", { text: "a" }); h.store.addIntel("t1", { text: "b" });
      h.store.transcriptAppend("t1", { kind: "message", text: "Keep objectives small." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["directive", "intel:2", "message"]);
      const note = sessions[0]!.sent.at(-1)!;
      expect(note).toContain("directive changed: rev 1; 2 new intel items; the person sent you a message");
      expect(note).toContain("> Keep objectives small.");
      expect(note).not.toContain("Ship remote first.");

      // 보드 — 목표 상태가 한 단계 옮겨 갈 때마다(새 목표 포함) 깨우고, 대기 상태는 지금 그 상태인 목표 수로 함께 싣는다.
      objectives.push({ id: "o1", theaterId: "t1", title: "Remote pairing", createdAt: Date.now(), done: null, removed: null, commenced: true, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: { id: "q1" }, decisionRequestRevision: 1, criteriaProposals: [], followups: [], followupBatches: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective);
      for (const listener of boardListeners) listener({ op: "upsert", theaterId: "t1", objectiveId: "o1" });
      for (const listener of boardListeners) listener({ op: "upsert", theaterId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["decision:1", "status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('1 objective status change: "Remote pairing" new → in progress');
      expect(sessions[0]!.sent).toHaveLength(3);
      // 구상이 내려앉으면(미션이 생긴 시작 전 목표) planned 로도 깨운다.
      objectives.push({ id: "o2", theaterId: "t1", title: "Lineup", createdAt: Date.now(), done: null, removed: null, commenced: false, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, decisionRequestRevision: 0, criteriaProposals: [], followups: [], followupBatches: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective);
      for (const listener of boardListeners) listener({ op: "upsert", theaterId: "t1", objectiveId: "o2" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["planned:1", "status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain("1 objective has a lineup ready to commence");
      // 지휘관이 옮긴 상태 — 진행 중에서 검토 대기로.
      (objectives[0] as { awaitingReview: boolean }).awaitingReview = true;
      for (const listener of boardListeners) listener({ op: "upsert", theaterId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["review:1", "status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('"Remote pairing" in progress → awaiting review');
      expect(sessions[0]!.sent).toHaveLength(5);
      // 사령관 자신의 쓰기(개시)로 바뀐 상태는 깨우지 않는다 — 제가 한 일을 다시 듣는 빈 턴을 만들지 않게.
      const board = sessions[0]!.options.tools!.custom!.find((group) => group.tools.some((tool) => tool.name === "console_objectives"))!.tools.find((tool) => tool.name === "console_objectives")!;
      await board.execute({ objectiveId: "o2", commence: true }, { cwd: theaterRoot });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(5);
      (objectives[0] as { awaitingReview: boolean }).awaitingReview = false;
      (objectives[1] as unknown as { missions: { done: boolean }[] }).missions[0]!.done = true;

      // 정체 — 임무가 남았는데 지휘관이 30분 넘게 쉬면 한 번 깨우고, 상태에 그 목표 id 가 선다.
      (objectives[0] as { decisionRequest: unknown }).decisionRequest = null;
      await vi.advanceTimersByTimeAsync(STALL_MS + STALL_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["stalled:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain("1 stalled objective: Remote pairing");
      expect(supervisor.status("t1")).toMatchObject({ stalled: ["o1"] });

      // 순찰 — 사령관의 next_wake 가 없으면 60분 상한에서 깨운다.
      await vi.advanceTimersByTimeAsync(DEFAULT_PATROL_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["patrol"]);

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

      // 교대 — 문맥이 길어지면 다음 깨움에서 새 세션 + 최근 행위 요약. 기록은 끊기지 않는다.
      // 폴백 Sonnet도 1M 좌표라, 75%를 넘는 사용량이어야 교대한다.
      inputTokens = 760_000;
      h.store.addIntel("t1", { text: "d" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(supervisor.status("t1")).toMatchObject({ context: { window: 200_000, inputTokens: 160_000 } });
      inputTokens = 1_000;
      h.store.addIntel("t1", { text: "e" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.disposed).toBe(true);
      expect(sessionEvents()).toEqual(["restarted", "replaced"]);
      expect(tokens().at(-1)).toEqual(["intel:1", "rotated"]);
      expect(sessions[1]!.sent[0]).toContain("This is a replacement session. Summary of your recent actions");
      expect(h.store.read("t1")!.run!.session).toBe(2);

      // 끔 — 진행 중 턴에 실린 메시지와 다음 턴 대기 메시지를 모두 표시하고 다시 보내지 않는다.
      holdTurn = true;
      const activeMessage = h.store.transcriptAppend("t1", { kind: "message", text: "Cancel this instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(supervisor.status("t1")).toMatchObject({ phase: "turn" });
      expect(sessions[1]!.sent.at(-1)).toContain("Cancel this instruction.");
      const sentCount = sessions[1]!.sent.length;
      const pendingMessage = h.store.transcriptAppend("t1", { kind: "message", text: "Hold the release." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS - 500);
      h.store.setAutonomy("t1", false);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessions[1]!.sent).toHaveLength(sentCount);
      expect(h.store.transcriptRead("t1").entries.slice(-3)).toMatchObject([{ kind: "result", outcome: "cancelled" }, { kind: "undelivered", seqs: [activeMessage.seq, pendingMessage.seq] }, { kind: "session", event: "stopped" }]);
      expect(sessions[1]!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      expect(sessionEvents().at(-1)).toBe("stopped");
      expect(runs.at(-1)).toMatchObject({ op: "run", run: { phase: "off", reason: "autonomy off" } });
      h.store.addIntel("t1", { text: "f" });
      await vi.advanceTimersByTimeAsync(DEFAULT_PATROL_MS);
      expect(sessions).toHaveLength(2);
      // 다시 켜도 취소된 메시지는 재전달하지 않는다. stop과 겹쳐도 성공 결말이면 전달 실패로 바꾸지 않는다.
      completeOnCancel = true;
      h.store.setAutonomy("t1", true);
      const delivered = await h.route("commodore/message", { theaterId: "t1", text: "Already received." }, { run: (id) => supervisor.status(id) });
      expect(delivered.status).toBe(200);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(3);
      expect(sessions[2]!.sent[0]).toContain("Already received.");
      expect(sessions[2]!.sent[0]).not.toMatch(/Cancel this instruction|Hold the release/);
      h.store.setAutonomy("t1", false);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.store.transcriptRead("t1").entries.slice(-2)).toMatchObject([{ kind: "result", outcome: "ok" }, { kind: "session", event: "stopped" }]);
      expect(h.store.transcriptRead("t1").entries.filter((entry) => entry.kind === "undelivered")).toHaveLength(1);
      await supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });
});
