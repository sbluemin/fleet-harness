import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createConsoleControl } from "../features/console-use/host/console-control.js";
import { createLaunchKeyLedger } from "../features/console-use/host/launch-keys.js";

import { createDeferredDeletionCoordinator, DeferredDeletionError } from "../features/workspace/host/deferred-deletion.js";
import type { DurableDeletionTombstone } from "../features/workspace/host/durable-state.js";
import { createOperationStore, type OperationNode } from "../features/execution/host/operations/operations-domain.js";
import { TheaterRegistry, type TheaterRegistration } from "../features/workspace/host/theaters/theater-domain.js";

const THEATER: TheaterRegistration = {
  id: "theater",
  path: "/work/theater",
  realpath: "/work/theater",
  label: "theater",
  registeredAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
};

describe("deferred deletion coordinator", () => {
  it("returns the same receipt for repeated deletion and blocks recreation during grace", () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op"));

    const first = harness.coordinator.deleteOperation("op");
    const repeated = harness.coordinator.deleteOperation("op");

    expect(repeated).toEqual(first);
    expect(harness.coordinator.hasPendingOperation("op")).toBe(true);
    expect(harness.events.filter((event) => event.channel === "operation:deleted")).toHaveLength(1);
  });

  it("restores a Theater together with its Operations and groups", async () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op-a"));
    harness.operations.create(makeOperation("op-b"));
    harness.operations.createGroup({ id: "group-a", theaterId: THEATER.id, name: "Alpha", color: "blue" });
    const deletion = harness.coordinator.deleteTheater(THEATER.id);
    if (!deletion) throw new Error("expected deletion");

    const restored = await harness.coordinator.restore(deletion.deletionId);

    expect(restored).toEqual({ ok: true, kind: "theater", targetId: THEATER.id });
    expect(harness.theaters.get(THEATER.id)).toEqual(THEATER);
    expect(harness.operations.listByTheater(THEATER.id).map((operation) => operation.id)).toEqual(["op-a", "op-b"]);
    expect(harness.operations.listGroups(THEATER.id).map((group) => group.id)).toEqual(["group-a"]);
    expect(harness.events.filter((event) => event.channel === "operation:restored")).toHaveLength(2);
  });

  it("rolls memory back when the durable save fails", () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op"));
    harness.failSave.value = true;

    expect(() => harness.coordinator.deleteOperation("op")).toThrow("save_failed");
    expect(harness.operations.get("op")).not.toBeNull();
    expect(harness.coordinator.list()).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects restore after expiry and purges on a startup sweep", async () => {
    const harness = createHarness();
    harness.operations.create(makeOperation("op"));
    const deletion = harness.coordinator.deleteOperation("op");
    if (!deletion) throw new Error("expected deletion");
    harness.clock.value = deletion.expiresAt;

    await expect(harness.coordinator.restore(deletion.deletionId)).rejects.toMatchObject({ status: 404 } satisfies Partial<DeferredDeletionError>);
    expect(harness.coordinator.list()).toEqual([]);
    expect(harness.events.some((event) => event.channel === "operation:purged")).toBe(true);

    const startup = createHarness();
    startup.clock.value = 10_000;
    startup.coordinator.load([makeExpiredTombstone()]);
    startup.coordinator.sweepExpired();
    expect(startup.coordinator.list()).toEqual([]);
    expect(startup.events).toEqual([expect.objectContaining({ channel: "operation:purged" })]);
  });
});

describe("idempotent launch keys", () => {
  // 저장 무결성 경계 — 키 하나에 Operation 은 많아야 하나, 사람이 지운 키는 purge·재시작 뒤에도 다시 생기지 않는다.
  it("creates at most one Operation per key and keeps a deleted key deleted across purge and restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-launch-keys-"));
    try {
      const harness = createHarness();
      let executions = 0;
      const boot = () => {
        const launchKeys = createLaunchKeyLedger({
          directory, limit: 2,
          operations: () => harness.operations.list(),
          tombstoned: () => harness.coordinator.list().flatMap((item) => item.kind === "operation" ? [item.operation] : item.operations),
        });
        const control = createConsoleControl({ directory, launchKeys, pluginAvailable: () => true, operations: () => harness.operations.list(), theaters: () => [{ id: THEATER.id, name: "theater" }] });
        control.attach({
          observe: () => null,
          execute: async (input, _assertCurrent, _settled, caller) => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            const id = input.newOperationId ?? `launched-${executions}`;
            harness.operations.create({ ...makeOperation(id), pluginId: null, payload: { launchKey: { owner: (caller as { pluginId: string }).pluginId, key: input.launchKey } } });
            return { operationId: id, delivery: "requested" };
          },
        });
        harness.beforePurge.value = (purged) => launchKeys.recordPurged(purged);
        return { launchKeys, control };
      };
      const caller = { kind: "plugin" as const, pluginId: "objectives" };
      const objectiveId = "11111111-2222-4333-8444-555555555555";
      const launch = { kind: "launch" as const, theaterId: THEATER.id, dormant: true, launchKey: "objectives.followup:a", newOperationId: objectiveId };

      const settledId = async (control: ReturnType<typeof boot>["control"], receipt: { id: string; operationId?: string }) => {
        for (let attempt = 0; attempt < 100 && !receipt.operationId; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          receipt = control.getAction(receipt.id, caller) ?? receipt;
        }
        return receipt.operationId;
      };

      const first = boot();
      expect(() => first.control.request(caller, "invalid", { ...launch, launchKey: undefined })).toThrow();
      expect(() => first.control.request({ kind: "operation", operationId: "unrelated" }, "other", launch)).toThrow();
      // 같은 키가 동시에 두 번 와도, 이미 선 뒤에 다시 와도 기동은 한 번이다.
      const [a, b] = [first.control.request(caller, "r1", launch), first.control.request(caller, "r2", launch)];
      expect(await settledId(first.control, a)).toBe(objectiveId);
      expect(await settledId(first.control, b)).toBe(objectiveId);
      expect(first.control.request(caller, "r3", launch).operationId).toBe(objectiveId);
      expect(executions).toBe(1);
      expect(first.control.launchKeyState(caller, THEATER.id, "objectives.followup:a")).toEqual({ state: "live", operationId: objectiveId });
      // 다른 Theater 로 묻는 키는 그 Operation 을 드러내지 않는다.
      expect(() => first.control.launchKeyState(caller, "other", "objectives.followup:a")).toThrow();

      harness.operations.create(makeOperation("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"));
      expect(() => first.control.request(caller, "taken", { ...launch, launchKey: "objectives.followup:collision", newOperationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" })).toThrow("operation_id_taken");
      // 용량이 차면 새 키는 받지 않지만, 이미 수락한 키의 삭제 기록은 막지 않는다.
      first.control.reserveLaunchKeys(caller, THEATER.id, ["objectives.followup:b"]);
      expect(() => first.control.reserveLaunchKeys(caller, THEATER.id, ["objectives.followup:c"])).toThrow("launch_key_capacity");
      harness.operations.create(makeOperation("unrelated"));
      harness.coordinator.deleteOperation("unrelated");
      harness.clock.value += 1; // 테스트 삭제 id 는 시각에서 나온다.
      harness.coordinator.deleteOperation(objectiveId);
      expect(first.control.launchKeyState(caller, THEATER.id, "objectives.followup:a").state).toBe("deleting");
      harness.clock.value += 60_000;
      // 원장 선기록이 실패하면 그 tombstone 만 남아 미뤄진다 — 다른 정리와 무관한 생성·삭제는 막히지 않는다.
      const record = harness.beforePurge.value!;
      harness.beforePurge.value = (purged) => { if (purged.some((node) => node.id === objectiveId)) throw new Error("storage_unavailable"); record(purged); };
      expect(harness.coordinator.hasPendingOperation("brand-new")).toBe(false);
      expect(harness.coordinator.hasPendingOperation("unrelated")).toBe(false);
      harness.operations.create(makeOperation("brand-new"));
      harness.clock.value += 1;
      expect(harness.coordinator.deleteOperation("brand-new")).not.toBeNull();
      expect(first.control.launchKeyState(caller, THEATER.id, "objectives.followup:a").state).toBe("deleting");
      harness.beforePurge.value = record;
      harness.clock.value += 60_000;
      harness.coordinator.sweepExpired();
      expect(harness.coordinator.hasPendingOperation(objectiveId)).toBe(false);
      first.control.dispose();

      // 재시작 — 흔적이 사라진 뒤에도 원장이 purge 를 말하고, 같은 키의 기동은 거절된다.
      const restarted = boot();
      expect(restarted.control.launchKeyState(caller, THEATER.id, "objectives.followup:a")).toEqual({ state: "purged", operationId: objectiveId });
      expect(() => restarted.control.request(caller, "r4", launch)).toThrow("launch_key_deleted");
      expect(restarted.control.launchKeyState(caller, THEATER.id, "objectives.followup:b").state).toBe("reserved");
      expect(executions).toBe(1);
      // 호스트 상태가 비워져 Operation 이 흔적 없이 사라져도, 선 적이 있는 키는 다시 만들지 않는다.
      const keyedB = { ...launch, launchKey: "objectives.followup:b", newOperationId: "66666666-7777-4888-9999-aaaaaaaaaaaa" };
      expect(await settledId(restarted.control, restarted.control.request(caller, "r5", keyedB))).toBe(keyedB.newOperationId);
      harness.operations.replace([]);
      expect(restarted.control.launchKeyState(caller, THEATER.id, "objectives.followup:b").state).toBe("purged");
      expect(() => restarted.control.request(caller, "r6", keyedB)).toThrow("launch_key_deleted");
      expect(executions).toBe(2);
      restarted.control.dispose();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

function createHarness() {
  const clock = { value: 1_000 };
  const failSave = { value: false };
  const beforePurge: { value: ((operations: readonly OperationNode[]) => void) | null } = { value: null };
  const operations = createOperationStore({ now: () => clock.value });
  const theaters = new TheaterRegistry();
  theaters.restore([THEATER]);
  const events: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const coordinator = createDeferredDeletionCoordinator({
    operations,
    theaters,
    now: () => clock.value,
    randomId: () => `deletion-${clock.value}`,
    save: () => {
      if (failSave.value) throw new Error("save_failed");
    },
    beforePurge: (purged) => beforePurge.value?.(purged),
    publish: (channel, payload) => events.push({ channel, payload }),
    unregisterTheaterWorkspaces: vi.fn(),
    validateTheaterRestore: async () => {},
    registerTheaterWorkspace: async () => {},
    setTimer: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  return { beforePurge, clock, coordinator, events, failSave, operations, theaters };
}

function makeOperation(id: string) {
  return {
    id,
    theaterId: THEATER.id,
    type: "agent",
    pluginId: "terminal",
    title: id,
    payload: { cwd: THEATER.path },
    geometry: null,
  };
}

function makeExpiredTombstone(): DurableDeletionTombstone {
  return {
    deletionId: "expired",
    targetId: "expired-op",
    deletedAt: 1,
    expiresAt: 2,
    kind: "operation",
    operation: {
      ...makeOperation("expired-op"),
      ts: { createdAt: 1, updatedAt: 1 },
    },
  };
}
