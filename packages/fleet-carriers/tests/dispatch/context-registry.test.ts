import { describe, expect, it, vi } from "vitest";

import { createCarrierRuntime } from "../../src/index.js";
import * as dispatchToolSpec from "../../src/dispatch/tool-spec.js";
import {
  DispatchContextRegistry,
  createContextId,
  isValidContextId,
  type DispatchBackendSession,
} from "../../src/dispatch/context-registry.js";

const binding = {
  carrierId: "alpha",
  cwd: "/tmp/project/../project",
  shape: "single" as const,
  backends: [{ cliType: "codex" as const }],
};
const session: DispatchBackendSession = { cliType: "codex", protocol: "codex-app-server", sessionId: "thread-1" };
const claudeSession: DispatchBackendSession = { cliType: "claude", protocol: "acp", sessionId: "session-1" };

describe("context ID validation", () => {
  it("accepts only unchanged ASCII opaque tokens", () => {
    expect(isValidContextId("a._:-9")).toBe(true);
    expect(isValidContextId(" a")).toBe(false);
    expect(isValidContextId("a ")).toBe(false);
    expect(isValidContextId("é")).toBe(false);
    expect(isValidContextId("a".repeat(129))).toBe(false);
    expect(createContextId()).toMatch(/^ctx:[0-9a-f-]{36}$/);
  });
});

describe("DispatchContextRegistry", () => {
  it("keeps the bound dispatch schema dynamic when carriers register after tool construction", async () => {
    const runtime = createCarrierRuntime();
    const tool = runtime.buildDispatchToolSpec({} as Parameters<typeof runtime.buildDispatchToolSpec>[0]);
    const carrierIds = () => (
      tool.parameters as { properties: { carrier_id: { enum: readonly string[] } } }
    ).properties.carrier_id.enum;

    expect(carrierIds()).not.toContain("genesis");
    runtime.registerCarrierDefaults();
    expect(carrierIds()).toContain("genesis");

    await runtime.cleanup();
  });

  it("declares resume_context_id as a non-empty optional string", async () => {
    const runtime = createCarrierRuntime();
    const tool = runtime.buildDispatchToolSpec({} as Parameters<typeof runtime.buildDispatchToolSpec>[0]);
    const resumeContextId = (
      tool.parameters as {
        properties: { resume_context_id: { description?: string; minLength?: number } };
      }
    ).properties.resume_context_id;

    expect(resumeContextId.minLength).toBe(1);
    expect(resumeContextId.description).toContain("never pass an empty string");

    await runtime.cleanup();
  });

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

  it("expires old contexts and evicts the least recently committed context", () => {
    const registry = new DispatchContextRegistry(2, 10);
    for (const [contextId, now] of [["context-a", 0], ["context-b", 1], ["context-c", 2]] as const) {
      const claim = registry.claim(contextId, binding, now);
      expect(claim.accepted).toBe(true);
      if (!claim.accepted) continue;
      registry.confirmReadiness(claim.lease, [session]);
      registry.commit(claim.lease, [session], now);
    }
    const evicted = registry.claim("context-a", binding, 3);
    expect(evicted.accepted).toBe(true);
    if (evicted.accepted) expect(evicted.resumeSessions).toBeUndefined();
    registry.release({ contextId: "context-a" });
    const expired = registry.claim("context-b", binding, 11);
    expect(expired.accepted).toBe(true);
    if (expired.accepted) expect(expired.resumeSessions).toBeUndefined();
    registry.release({ contextId: "context-b" });
    expect(registry.claim("context-b", binding, 11, true)).toEqual({ accepted: false, error: "not found" });
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
    expect(() => first.dispatchContexts.commit({ contextId: "context-5" }, [session])).not.toThrow();
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
