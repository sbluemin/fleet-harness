import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
import { afterEach, describe, expect, it } from "vitest";

import { commodoreActive, createCommodoreRoutes } from "../server/commodore/routes.js";
import { createCommodoreStore } from "../server/commodore/store.js";
import type { CommodoreEvent } from "../server/commodore/types.js";

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
  return { ctx, store, events, route, objectivesDir, setExperiments: (next: Partial<typeof experiments>) => { experiments = { ...experiments, ...next }; }, setAuthorized: (next: boolean) => { authorized = next; } };
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
