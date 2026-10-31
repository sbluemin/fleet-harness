import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTaskforceRoutes, type TaskforceRouteContext } from "../features/commodore/host/taskforce/routes.js";
import { createTaskforceStore, type TaskforceStore } from "../features/commodore/host/taskforce/store.js";
import type { TaskforceEvent } from "../features/commodore/shared/contracts/taskforce.js";

/**
 * TaskForce 원장의 필수 계약 — 덧붙인 순서대로 seq가 오르고, 재기동 복원이 같은
 * 말을 읽으며, 삭제는 TF 디렉터리째 걷는다. 판단·깨움 런타임의 전제다.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const consoleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-taskforce-"));
  dirs.push(consoleDataDir);
  const events: TaskforceEvent[] = [];
  let clock = 1_000;
  const store = createTaskforceStore({ root: path.join(consoleDataDir, "taskforce"), emit: (event) => events.push(event), now: () => clock++ });
  let routeBody: unknown = {};
  let routeResult: { status: number; value: unknown } = { status: 0, value: null };
  const ctx = {
    host: {
      security: { isTerminalAuthorized: () => true },
      http: { readJsonBody: async () => routeBody, writeJson: (_res: unknown, status: number, value: unknown) => { routeResult = { status, value }; } },
    },
  } as unknown as TaskforceRouteContext;
  const route = async (name: string, body: Record<string, unknown>) => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    const target = createTaskforceRoutes(ctx, store, { isKnownCommodore: () => true }).find((entry) => entry.name === name)!;
    await target.handler({ req: { method: target.method } as never, res: {} as never, pathname: `/api/v1/${name}` });
    return routeResult as { status: number; value: Record<string, unknown> };
  };
  const reopen = (): TaskforceStore =>
    createTaskforceStore({ root: path.join(consoleDataDir, "taskforce"), emit: () => undefined, now: () => clock++ });
  return { consoleDataDir, events, store, route, reopen };
}

describe("taskforce ledger", () => {
  it("appends entries with strictly increasing seq, restores them after reopen, and removes the directory on delete", async () => {
    const h = harness();
    const members = [randomUUID(), randomUUID(), randomUUID()];
    const created = await h.route("taskforce/create", { name: "출격 TF", topic: "오늘의 주제", members });
    expect(created.status).toBe(200);
    const taskforceId = (created.value.taskforce as { id: string }).id;
    expect((created.value.entry as { seq: number }).seq).toBe(1);

    // 닫힌 TF의 말은 기록에 남기기 전에 거절한다.
    expect((await h.route("taskforce/close", { taskforceId })).status).toBe(200);
    expect((await h.route("taskforce/post", { taskforceId, text: "닫힌 뒤의 말" })).status).toBe(409);
    expect((await h.route("taskforce/reopen", { taskforceId })).status).toBe(200);

    const first = await h.route("taskforce/post", { taskforceId, text: "사람의 말", mentions: [members[0]] });
    expect(first.status).toBe(200);
    const second = h.store.append(taskforceId, { speaker: { kind: "commodore", commodoreId: members[0]! }, text: "사령관의 말" });
    expect(second.entry.seq).toBeGreaterThan((first.value.entry as { seq: number }).seq);

    const page = await h.route("taskforce/read", { taskforceId });
    expect(page.status).toBe(200);
    const entries = (page.value.entries as { seq: number; text: string }[]);
    const seqs = entries.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // 재기동 복원 — 새 저장소 인스턴스가 같은 원장을 읽는다.
    const restored = h.reopen();
    const reread = restored.readLedger(taskforceId);
    expect(reread.entries.map((entry) => [entry.seq, entry.text])).toEqual(
      entries.map((entry) => [entry.seq, entry.text]),
    );
    expect(restored.read(taskforceId)?.lastSeq).toBe(second.entry.seq);

    // 원장 사건이 순서대로 나갔다.
    expect(h.events.filter((event) => event.op === "taskforce-ledger").map((event) => event.taskforceId)).toContain(taskforceId);

    expect((await h.route("taskforce/delete", { taskforceId })).status).toBe(200);
    expect(fs.existsSync(path.join(h.consoleDataDir, "taskforce", taskforceId))).toBe(false);
    expect(h.reopen().read(taskforceId)).toBeNull();
  });
});
