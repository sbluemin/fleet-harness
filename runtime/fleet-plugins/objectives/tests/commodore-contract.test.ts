import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentEvent, AgentHost, AgentSessionOptions } from "@fleet-console/sdk/agent";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commodoreActive, createCommodoreRoutes } from "../server/commodore/routes.js";
import { createCommodoreSession } from "../server/commodore/session.js";
import { createCommodoreStore } from "../server/commodore/store.js";
import { COALESCE_MS, createCommodoreSupervisor, PATROL_CEILING_MS, RETRY_DELAYS_MS } from "../server/commodore/supervisor.js";
import type { CommodoreEvent } from "../server/commodore/types.js";
import type { Objective, ObjectiveEvent } from "../server/types.js";

/**
 * 사령관 Theater 상태의 필수 계약 — 보드 곁 `commodore/` 에 한 건으로 영속되고, 지시 개정은 본문이 바뀔 때만 오르며,
 * 실험 기능이 꺼진 채로는 자율 운영을 켤 수 없고, 기록은 덧붙인 순서대로 쪽을 나눠 읽힌다.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function harness() {
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
  const store = createCommodoreStore({ dirOf: (theaterId) => (theaterId === "t1" ? objectivesDir : null), emit: (event) => events.push(event), now: () => clock++ });
  const route = async (name: string, body: Record<string, unknown>) => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    await createCommodoreRoutes(ctx, store).find((entry) => entry.name === name)!.handler({ req: { method: "POST" } as never, res: {} as never, pathname: name });
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

    h.setExperiments({ commodore: true, commodoreModel: "opus[1m]", commodoreEffort: "high" });
    expect((await h.route("commodore/autonomy", { theaterId: "t1", autonomy: true })).value).toMatchObject({ active: true, defaults: { model: "opus[1m]", effort: "high" }, run: { phase: "idle" } });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(true);

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
    expect((await h.route("commodore/coordinates", { theaterId: "t1", model: "sonnet", effort: "low" })).value.state).toMatchObject({ model: "sonnet", effort: "low" });

    // 영속 — 새 저장소가 같은 파일에서 같은 상태를 읽고, 실험 기능이 꺼지면 플래그만 꺼진다(저장값은 남는다).
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ autonomy: true, directive: { rev: 1 }, model: "sonnet" });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")).toEqual(h.store.read("t1"));
    // 재시작 복원은 등록된 Theater 를 훑는다 — 읽을 수 없는 Theater 는 빠지고 던지지 않는다.
    expect(createCommodoreStore({ dirOf: (id) => (id === "t1" ? h.objectivesDir : null), theaterIds: () => ["t1", "gone"], emit: () => undefined }).autonomousTheaters()).toEqual(["t1"]);
    h.setExperiments({ commodore: false });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(false);
    expect(h.events.map((event) => event.op === "state" ? event.change : event.op)).toEqual(["autonomy", "directive", "intel", "intel", "coordinates"]);

    // 같은 origin 의 Console 만 지난다.
    h.setAuthorized(false);
    expect((await h.route("commodore/state", { theaterId: "t1" })).status).toBe(401);
  });

  it("appends the log in order and pages it from the newest end", async () => {
    const h = harness();
    h.store.transcriptAppend("t1", { kind: "session", event: "opened" });
    h.store.transcriptAppend("t1", { kind: "wake", reasons: ["directive changed"] });
    h.store.transcriptAppend("t1", { kind: "tool", name: "console_objectives", action: "complete", objectiveId: "o1", title: "Remote pairing" });
    const sent = await h.route("commodore/message", { theaterId: "t1", text: "Prefer small objectives." });
    expect(sent.value.entry).toMatchObject({ seq: 4, kind: "message", text: "Prefer small objectives." });
    expect(h.events.filter((event) => event.op === "transcript")).toHaveLength(4);

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
      coordinates: { model: "opus[1m]", effort: "high" }, boardTools: [{ name: "console_objectives", description: "board", inputSchema: { type: "object", properties: {}, additionalProperties: true }, execute: async () => ({ content: [] }) }], onNextWake: (at, reason) => wakes.push({ at, reason }), now: () => 10_000,
      execute: async (file, args) => { commands.push({ file, args }); return file === "git" ? { stdout: "abc1234\x1f2026-10-03\x1fme\x1ffix: thing\n", stderr: "" } : { stdout: JSON.stringify([{ number: 7, title: "Pairing drops", state: "OPEN", updatedAt: "2026-10-01T00:00:00Z", labels: [{ name: "bug" }], url: "https://example.test/7" }]), stderr: "" }; },
    });

    stub.setScript(async () => {
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
    expect(options.systemPrompt).not.toContain("Fix remote first.");
    expect(options.tools).toMatchObject({ builtins: ["WebSearch", "WebFetch"] });
    expect(options.tools!.consoleUse).toBeUndefined();
    expect(options.tools!.custom!.map((group) => [group.name, group.tools.map((tool) => tool.name)])).toEqual([["commodore", ["directive", "intel", "next_wake", "read_file", "git_log", "issue_list"]], ["console", ["console_objectives"]]]);
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]).toMatch(/^\[wake \d\d:\d\d\] directive changed \(rev 1\); 1 new intel item\.$/);
    expect(stub.sent[0]).not.toContain("newest");

    // 기록 — 사고·텍스트는 블록으로, 보드 행위는 action·objectiveId·title 만, 도구 입력의 나머지는 없다.
    const log = h.store.transcriptRead("t1").entries;
    expect(log.map((entry) => entry.kind)).toEqual(["wake", "thinking", "tool", "text", "tool", "tool", "result"]);
    expect(log[1]).toMatchObject({ kind: "thinking", text: "The directive changed." });
    expect(log[2]).toMatchObject({ kind: "tool", name: "directive", ok: true });
    expect(log[4]).toMatchObject({ kind: "tool", name: "console_objectives", action: "complete", objectiveId: "o1", title: "Remote pairing", ok: true });
    expect(JSON.stringify(log)).not.toContain("secret detail");
    expect(log[6]).toMatchObject({ kind: "result", outcome: "ok", costUsd: 0.25, inputTokens: 1200 });
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
    expect((await call("next_wake", { inMinutes: 90, reason: "too far" })).isError).toBe(true);
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
  it("restores on register, coalesces wake reasons, patrols within the ceiling, retries failures, rotates long sessions and stops with autonomy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    try {
      const h = harness();
      h.setExperiments({ commodore: true, commodoreModel: "sonnet", commodoreEffort: "medium" });
      h.store.setAutonomy("t1", true);
      const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
      fs.mkdirSync(theaterRoot, { recursive: true });
      const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
      let fail: string | null = null;
      let inputTokens = 1_000;
      const agent: AgentHost = {
        createSession: async (options) => {
          const entry = { options, sent: [] as string[], disposed: false };
          sessions.push(entry);
          return {
            send: async (text) => {
              entry.sent.push(text);
              if (fail) throw new Error(fail);
              options.onEvent?.({ kind: "text", text: "ok" });
              options.onEvent?.({ kind: "result", isError: false, source: "message", usage: { inputTokens, outputTokens: 10, costUsd: 0.01 } });
            },
            cancel: () => undefined,
            dispose: async () => { entry.disposed = true; },
          };
        },
      };
      const objectives: Objective[] = [];
      const boardListeners: ((event: ObjectiveEvent) => void)[] = [];
      const runs: CommodoreEvent[] = [];
      const supervisor = createCommodoreSupervisor({
        store: h.store, agent, experiments: () => h.experiments(), theater: () => ({ label: "fleet-harness", root: theaterRoot }),
        objectives: () => objectives, subscribeObjectives: (listener) => { boardListeners.push(listener); return () => undefined; },
        boardTools: () => [], emit: (event) => { if (event.op === "run") runs.push(event); },
      });
      const tokens = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "wake" ? [entry.reasons] : []);
      const sessionEvents = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "session" ? [entry.event] : []);

      // 등록 복원 — 켜진 Theater 는 「재시작」 턴으로 깨어나고, 빈 보드도 이유가 된다.
      supervisor.sync("restart");
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.options).toMatchObject({ model: "sonnet", effort: "medium" });
      expect(tokens()).toEqual([["restart", "empty"]]);
      expect(sessionEvents()).toEqual(["restarted"]);
      expect(sessions[0]!.sent[0]).toContain("Console restarted; the board is empty");
      const patrolAt = supervisor.status("t1")!.nextWakeAt!;
      expect(supervisor.status("t1")!.phase).toBe("idle");
      expect(patrolAt).toBeGreaterThan(Date.now() + PATROL_CEILING_MS - COALESCE_MS - 100);
      expect(patrolAt).toBeLessThanOrEqual(Date.now() + PATROL_CEILING_MS);
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

      // 보드 — 대기 상태의 서명이 바뀔 때만, 지금 그 상태인 목표 수로.
      objectives.push({ id: "o1", theaterId: "t1", title: "Remote pairing", done: null, removed: null, commenced: true, awaitingReview: false, awaitingHandoff: false, decisionRequest: { id: "q1" }, decisionRequestRevision: 1, criteriaProposals: [], followups: [], followupBatches: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective);
      for (const listener of boardListeners) listener({ op: "upsert", theaterId: "t1", objectiveId: "o1" });
      for (const listener of boardListeners) listener({ op: "upsert", theaterId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["decision:1"]);
      expect(sessions[0]!.sent).toHaveLength(3);

      // 순찰 — 사령관의 next_wake 가 없으면 60분 상한에서 깨운다.
      await vi.advanceTimersByTimeAsync(PATROL_CEILING_MS + COALESCE_MS + 10);
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
      inputTokens = 160_000;
      h.store.addIntel("t1", { text: "d" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      h.store.addIntel("t1", { text: "e" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.disposed).toBe(true);
      expect(sessionEvents()).toEqual(["restarted", "replaced"]);
      expect(tokens().at(-1)).toEqual(["intel:1", "rotated"]);
      expect(sessions[1]!.sent[0]).toContain("This is a replacement session. Summary of your recent actions");
      expect(h.store.read("t1")!.run!.session).toBe(2);

      // 끔 — 글리프를 끄면 세션이 닫히고 깨우기가 멈춘다; 실험 기능을 끄면 같다.
      h.store.setAutonomy("t1", false);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessions[1]!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      expect(sessionEvents().at(-1)).toBe("stopped");
      expect(runs.at(-1)).toMatchObject({ op: "run", run: { phase: "off", reason: "autonomy off" } });
      h.store.addIntel("t1", { text: "f" });
      await vi.advanceTimersByTimeAsync(PATROL_CEILING_MS);
      expect(sessions).toHaveLength(2);
      await supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });
});
