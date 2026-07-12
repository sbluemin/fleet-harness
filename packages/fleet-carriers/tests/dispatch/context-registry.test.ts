import { describe, expect, it, vi } from "vitest";

import { createCarrierRuntime } from "../../src/index.js";
import * as dispatchToolSpec from "../../src/dispatch/tool-spec.js";
import {
  DispatchContextRegistry,
  isValidDispatchId,
  type DispatchBackendSession,
} from "../../src/dispatch/context-registry.js";

const binding = {
  carrierId: "ohio",
  cwd: "/tmp/project/../project",
  shape: "single" as const,
  backends: [{ cliType: "codex" as const }],
};
const session: DispatchBackendSession = { cliType: "codex", protocol: "codex-app-server", sessionId: "thread-1" };
const claudeSession: DispatchBackendSession = { cliType: "claude", protocol: "acp", sessionId: "session-1" };

describe("dispatch ID validation", () => {
  it("accepts only unchanged ASCII opaque tokens", () => {
    expect(isValidDispatchId("a._:-9")).toBe(true);
    expect(isValidDispatchId(" a")).toBe(false);
    expect(isValidDispatchId("a ")).toBe(false);
    expect(isValidDispatchId("é")).toBe(false);
    expect(isValidDispatchId("a".repeat(129))).toBe(false);
  });
});

describe("DispatchContextRegistry", () => {
  it("claims synchronously, commits atomically, and resumes only matching bindings", () => {
    const registry = new DispatchContextRegistry();
    const first = registry.claim("context-1", binding);
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    expect(registry.claim("context-1", binding)).toEqual({ accepted: false, error: "busy" });
    expect(registry.confirmReadiness(first.lease, [session]).cwd).toBe("/tmp/project");
    registry.commit(first.lease, [session]);

    const resumed = registry.claim("context-1", binding);
    expect(resumed.accepted).toBe(true);
    if (!resumed.accepted) return;
    expect(resumed.resumeSessions?.get("codex")).toBe("thread-1");
    registry.confirmReadiness(resumed.lease, [session]);
    registry.commit(resumed.lease, [session]);
    expect(registry.claim("context-1", { ...binding, shape: "taskforce" })).toEqual({ accepted: false, error: "binding mismatch" });
  });

  it("releases failed first turns but retains committed sessions after resume failure", () => {
    const registry = new DispatchContextRegistry();
    const fresh = registry.claim("context-2", binding);
    expect(fresh.accepted).toBe(true);
    if (!fresh.accepted) return;
    registry.release(fresh.lease);
    expect(registry.claim("context-2", binding).accepted).toBe(true);

    const committed = registry.claim("context-3", binding);
    expect(committed.accepted).toBe(true);
    if (!committed.accepted) return;
    registry.confirmReadiness(committed.lease, [session]);
    registry.commit(committed.lease, [session]);
    const resumed = registry.claim("context-3", binding);
    expect(resumed.accepted).toBe(true);
    if (!resumed.accepted) return;
    registry.release(resumed.lease);
    expect(registry.claim("context-3", binding).accepted).toBe(true);
  });

  it("requires complete Task Force backend readiness before committing", () => {
    const registry = new DispatchContextRegistry();
    const claim = registry.claim("context-4", {
      ...binding,
      shape: "taskforce",
      backends: [{ cliType: "codex" }, { cliType: "claude" }],
    });
    expect(claim.accepted).toBe(true);
    if (!claim.accepted) return;
    expect(() => registry.confirmReadiness(claim.lease, [session])).toThrow(/do not match/);
    registry.release(claim.lease);
    expect(registry.size).toBe(0);

    const complete = registry.claim("context-4", {
      ...binding,
      shape: "taskforce",
      backends: [{ cliType: "claude" }, { cliType: "codex" }],
    });
    expect(complete.accepted).toBe(true);
    if (!complete.accepted) return;
    registry.confirmReadiness(complete.lease, [session, claudeSession]);
    registry.commit(complete.lease, [session, claudeSession]);
    const resumed = registry.claim("context-4", {
      ...binding,
      shape: "taskforce",
      backends: [{ cliType: "codex" }, { cliType: "claude" }],
    });
    expect(resumed.accepted).toBe(true);
    if (resumed.accepted) expect([...resumed.resumeSessions!.entries()].sort()).toEqual([
      ["claude", "session-1"],
      ["codex", "thread-1"],
    ]);
  });

  it("is isolated per runtime and cleanup closes admission before cancelling tracked work", async () => {
    const first = createCarrierRuntime();
    const second = createCarrierRuntime();
    expect(first.dispatchContexts).not.toBe(second.dispatchContexts);
    const tool = first.buildDispatchToolSpec({} as Parameters<typeof first.buildDispatchToolSpec>[0]);
    const cancelled: string[] = [];
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    first.trackInFlight({ cancel: () => { cancelled.push("first"); finish(); }, completion });
    await first.cleanup();
    expect(cancelled).toEqual(["first"]);
    expect(first.admission.accepting).toBe(false);
    expect(() => first.admission.assertOpen()).toThrow(/closed to new dispatches/);
    expect(() => first.buildDispatchToolSpec({} as Parameters<typeof first.buildDispatchToolSpec>[0])).toThrow(/closed to new dispatches/);
    expect(() => first.dispatch.buildToolSpecs({} as Parameters<typeof first.buildDispatchToolSpec>[0])).toThrow(/closed to new dispatches/);
    expect(() => first.trackInFlight({ cancel() {}, completion: Promise.resolve() })).toThrow(/closed to new dispatches/);
    expect(() => tool.execute({} as never, {} as never)).toThrow(/closed to new dispatches/);
    expect(first.dispatchContexts.claim("context-5", binding)).toEqual({ accepted: false, error: "disposed" });
    expect(() => first.dispatchContexts.commit({ dispatchId: "context-5" }, [session])).not.toThrow();
    expect(second.dispatchContexts.claim("context-5", binding).accepted).toBe(true);
    expect(second.admission.accepting).toBe(true);
  });

  it("injects each runtime's own registry, admission guard, and tracker into its bound builder", () => {
    const first = createCarrierRuntime();
    const second = createCarrierRuntime();
    const spy = vi.spyOn(dispatchToolSpec, "buildCarrierDispatchToolSpec");
    try {
      first.buildDispatchToolSpec({} as Parameters<typeof first.buildDispatchToolSpec>[0]);
      second.buildDispatchToolSpec({} as Parameters<typeof second.buildDispatchToolSpec>[0]);

      const firstArgs: readonly unknown[] = spy.mock.calls[0] ?? [];
      const secondArgs: readonly unknown[] = spy.mock.calls[1] ?? [];
      expect(first.dispatchServices).not.toBe(second.dispatchServices);
      expect(firstArgs[2]).toBe(first.dispatchServices);
      expect(secondArgs[2]).toBe(second.dispatchServices);
      expect(first.dispatchServices.dispatchContexts).toBe(first.dispatchContexts);
      expect(second.dispatchServices.dispatchContexts).toBe(second.dispatchContexts);
      expect(first.dispatchServices.admission).toBe(first.admission);
      expect(second.dispatchServices.admission).toBe(second.admission);
      expect(first.dispatchServices.trackInFlight).toBe(first.trackInFlight);
      expect(second.dispatchServices.trackInFlight).toBe(second.trackInFlight);
    } finally {
      spy.mockRestore();
    }
  });
});
