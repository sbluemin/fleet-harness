import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureSafeDirectory } from "@dotobokuri/core-infra";
import { sanitizeLaunchPrompt } from "@dotobokuri/fleet-admiral";
import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ConsoleCaller, ConsoleActionInput, ConsoleActionReceipt, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleOperationObservation } from "@fleet-console/sdk/mcp";
import { z } from "zod";

const callerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operation"), operationId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("plugin"), pluginId: z.string().min(1).max(128) }).strict(),
]);
const sameCaller = (a: ConsoleCaller, b: ConsoleCaller) => a.kind === "operation" && b.kind === "operation"
  ? a.operationId === b.operationId : a.kind === "plugin" && b.kind === "plugin" && a.pluginId === b.pluginId;
const activity = z.enum(["idle", "running", "awaiting", "background", "ended", "unknown"]);
const actionObjectSchema = z.object({
  kind: z.enum(["launch", "send", "interrupt"]),
  theaterId: z.string().min(1).max(128).optional(), operationId: z.string().min(1).max(128).optional(),
  text: z.string().min(1).max(32_000).optional(), model: z.string().max(200).optional(), effort: z.string().max(32).optional(),
  viewMode: z.enum(["chat", "terminal"]).optional(),
}).strict();
export const actionSchema = actionObjectSchema.superRefine((value, ctx) => {
  if (value.kind === "launch" ? !value.theaterId || !value.text || value.operationId : !value.operationId || value.theaterId || (value.kind === "send" && !value.text)) ctx.addIssue({ code: "custom", message: "invalid_action_target" });
  if (value.kind !== "launch" && (value.model || value.effort || value.viewMode)) ctx.addIssue({ code: "custom", message: "invalid_launch_option" });
  if (value.kind === "interrupt" && value.text) ctx.addIssue({ code: "custom", message: "invalid_interrupt" });
  if (value.text !== undefined && !sanitizeLaunchPrompt(value.text)) ctx.addIssue({ code: "custom", message: "empty_prompt" });
});
export const automationSchema = z.object({
  name: z.string().trim().min(1).max(100), theaterId: z.string().min(1).max(128),
  trigger: z.discriminatedUnion("kind", [z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(1440) }).strict(), z.object({ kind: z.literal("activity"), operationId: z.string().min(1).max(128), activity }).strict()]),
  action: z.union([actionSchema, z.object({ kind: z.literal("briefing") }).strict()]),
  expiresAt: z.iso.datetime(), maxRuns: z.number().int().min(1).max(100),
}).strict();

export class ConsoleControlError extends Error {
  constructor(readonly code: string) { super(code); }
}

/**
 * Operation 단위 콘솔 사용 허용 표식 — 서버가 쓰고 게이트가 읽는다. `payload.watch`와 같은
 * 자리·같은 모양이다. 실험 옵트인을 꺼도 이 기록은 남는다: 두 축이 다르고, 허용이 둘의 AND라
 * 남은 기록만으로는 아무 권한도 서지 않는다.
 */
export function readConsoleUseFlag(payload: Record<string, unknown> | undefined): { readonly enabled: true; readonly language: "en" | "ko" } | null {
  const value = payload?.consoleUse;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.enabled !== true) return null;
  return { enabled: true, language: record.language === "ko" ? "ko" : "en" };
}
const fail = (code: string): never => { throw new ConsoleControlError(code); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const RETENTION_DAYS = 7;
const ACTION_LIMIT = 500;
const pendingStatuses = new Set(["accepted", "running"]);

export interface ConsoleExecutionAdapter {
  observe(operationId: string): ConsoleOperationObservation | null;
  execute(input: ConsoleActionInput, assertCurrent: () => void, settled: (outcome: "completed" | "succeeded" | "failed" | "interrupted" | "unknown") => void): Promise<{ readonly operationId: string; readonly delivery: "queued" | "confirmed" | "requested" }>;
}
export interface ConsoleControlDeps {
  readonly enabled: () => boolean;
  readonly directory: string;
  readonly operations: () => readonly OperationNode[];
  readonly theaters: () => readonly { readonly id: string; readonly name: string }[];
  readonly pluginAvailable?: (pluginId: string) => boolean;
  readonly now?: () => number;
}
interface SavedState { version: 2; actions: ConsoleActionReceipt[]; automations: ConsoleAutomation[] }
interface ControlEvent { readonly seq: number; readonly at: string; readonly kind: string; readonly operationId?: string; readonly activity?: ConsoleActivity; readonly actionId?: string; readonly automationId?: string }

export function createConsoleControl(deps: ConsoleControlDeps) {
  const now = deps.now ?? Date.now;
  const stamp = () => new Date(now()).toISOString();
  const file = path.join(deps.directory, "state.json");
  let state: SavedState = { version: 2, actions: [], automations: [] };
  let storageError = false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    // 기존 Operation 소유 기록은 그대로 승계한다. 부관은 별도 플러그인 소유자로 저장한다.
    const migrate = ({ callerOperationId, ...row }: Record<string, unknown>) => ({ ...row, caller: { kind: "operation", operationId: callerOperationId } });
    const saved = (raw.version === 1 ? { ...raw, version: 2, actions: raw.actions.map(migrate), automations: raw.automations.map(migrate) } : raw) as SavedState;
    if (saved.version !== 2 || !Array.isArray(saved.actions) || !Array.isArray(saved.automations)
      || saved.actions.length > ACTION_LIMIT || saved.automations.length > 100
      || saved.actions.some((a) => !a || typeof a.id !== "string" || typeof a.requestId !== "string" || !callerSchema.safeParse(a.caller).success || typeof a.expectedRevision !== "string" || !Number.isFinite(Date.parse(a.createdAt)) || !Number.isFinite(Date.parse(a.expiresAt)) || !["approval_required", "accepted", "running", "finished", "rejected", "failed", "outcome_unknown"].includes(a.status) || !actionSchema.safeParse(a.input).success)
      || saved.automations.some((a) => !a || typeof a.id !== "string" || !callerSchema.safeParse(a.caller).success || !Number.isSafeInteger(a.runs) || a.runs < 0 || !["approval_required", "active", "paused", "expired", "exhausted"].includes(a.status) || !automationSchema.safeParse(a.input).success)) throw new Error("invalid_state");
    // 쓰기 직전에 죽었다면 재실행하지 않는다. 자동 정책은 기존 계약대로 재시작 뒤 일시 중지한다.
    state = { ...saved, actions: saved.actions.map((a) => pendingStatuses.has(a.status) ? { ...a, status: "outcome_unknown", error: "host_restarted" } : (a.status as string) === "approval_required" ? { ...a, status: "rejected", error: "approval_flow_removed" } : a), automations: saved.automations.map((a) => a.status === "active" || (a.status as string) === "approval_required" ? { ...a, status: "paused" } : a) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") storageError = true;
  }
  let adapter: ConsoleExecutionAdapter | null = null;
  let disposed = false;
  let ticking = false;
  const epoch = randomUUID();
  let sequence = 0;
  const events: ControlEvent[] = [];
  const waiters = new Set<() => void>();
  const observed = new Map<string, string>();
  const previousActivity = new Map<string, ConsoleActivity>();
  const timer = setInterval(() => { void tick().catch(() => { storageError = true; }); }, 1_000);
  timer.unref();

  function persist() {
    if (storageError) fail("storage_unavailable");
    ensureSafeDirectory(deps.directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } catch { storageError = true; fail("storage_unavailable"); }
  }
  function publish(event: Omit<ControlEvent, "seq" | "at">) {
    events.push({ ...event, seq: ++sequence, at: stamp() });
    if (events.length > 1000) events.splice(0, events.length - 1000);
    for (const wake of waiters) wake();
  }
  function node(id: string) { return deps.operations().find((op) => op.id === id); }
  function callerAvailable(caller: ConsoleCaller) { return caller.kind === "operation" ? !!node(caller.operationId) : deps.pluginAvailable?.(caller.pluginId) === true; }
  /**
   * 소유자가 아직 콘솔 사용을 허용받고 있는가. 존재(`callerAvailable`)와 다른 축이다 — 살아 있는
   * Operation이 허용만 거둔 경우가 있고, 그때 사용자가 할 일도 다르다.
   *
   * 이 판정이 여기에도 서야 하는 이유는 자동 운영이다: 정책은 소유자를 대신해 **나중에** 실행되므로,
   * 도구 호출 경로에만 게이트를 두면 이미 예약된 정책이 그 게이트를 우회해 돌아 버린다.
   * 플러그인 소유자는 Operation을 갖지 않으며 실험 옵트인(`deps.enabled`)이 그 자리를 지킨다.
   */
  function callerAuthorized(caller: ConsoleCaller) {
    if (caller.kind !== "operation") return true;
    const operation = node(caller.operationId);
    return !!operation && readConsoleUseFlag(operation.payload) !== null;
  }
  function observe(id: string) { return adapter?.observe(id) ?? null; }
  function revision(id: string) {
    const op = node(id);
    if (!op) return null;
    const obs = observe(id);
    // 본문·경로·provider id는 해시 입력에만 남고 응답에는 절대 싣지 않는다.
    return hash([op.id, op.theaterId, op.type, op.pluginId, op.payload, obs?.lifecycle, obs?.activity]);
  }
  function targetRevision(input: ConsoleActionInput) {
    if (input.kind === "launch") return deps.theaters().some((t) => t.id === input.theaterId) ? hash(["launch", input.theaterId]) : null;
    return revision(input.operationId!);
  }
  function validTarget(input: ConsoleActionInput, theaterId?: string) {
    if (input.kind === "launch") {
      if (!deps.theaters().some((t) => t.id === input.theaterId) || (theaterId && theaterId !== input.theaterId)) fail("unknown_theater");
    } else {
      const op = node(input.operationId!);
      if (!op || (theaterId && op.theaterId !== theaterId)) return fail("unknown_operation");
      const observation = observe(op.id);
      if (input.kind === "interrupt" && (observation?.activity === "idle" || observation?.activity === "ended")) fail("nothing_to_interrupt");
      if (!observation?.supportedActions.includes(input.kind)) fail("capability_unavailable");
    }
  }
  function updateAction(id: string, patch: Partial<ConsoleActionReceipt>) {
    const index = state.actions.findIndex((a) => a.id === id);
    if (index < 0) return fail("action_not_found");
    const next = { ...state.actions[index]!, ...patch, updatedAt: stamp() };
    state.actions[index] = next;
    persist();
    publish({ kind: "action", actionId: id, ...(next.operationId ? { operationId: next.operationId } : {}) });
    return next;
  }
  function updateAutomation(id: string, patch: Partial<ConsoleAutomation>) {
    const index = state.automations.findIndex((a) => a.id === id);
    if (index < 0) return fail("automation_not_found");
    const next = { ...state.automations[index]!, ...patch };
    state.automations[index] = next;
    persist();
    publish({ kind: "automation", automationId: id });
    return next;
  }
  function request(caller: ConsoleCaller, requestId: string, raw: ConsoleActionInput, expectedRevision?: string, policyId?: string) {
    if (disposed) fail("console_unavailable");
    if (storageError) fail("storage_unavailable");
    if (!callerAvailable(caller)) fail("caller_unavailable");
    if (!callerAuthorized(caller)) fail("console_use_not_authorized");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) fail("invalid_request_id");
    const input = actionSchema.parse(raw);
    const duplicate = state.actions.find((a) => sameCaller(a.caller, caller) && a.requestId === requestId);
    if (duplicate) {
      if (hash(duplicate.input) !== hash(input)) fail("request_conflict");
      return duplicate;
    }
    if (!deps.enabled()) fail("console_control_disabled");
    validTarget(input);
    const current = targetRevision(input)!;
    if (expectedRevision && expectedRevision !== current) fail("conflict");
    state.actions = state.actions.filter((a) => now() - Date.parse(a.createdAt) < RETENTION_DAYS * 86_400_000 || pendingStatuses.has(a.status));
    if (state.actions.length >= ACTION_LIMIT) fail("action_capacity");
    const receipt: ConsoleActionReceipt = { id: randomUUID(), requestId, caller, input, status: "accepted", expectedRevision: current, createdAt: stamp(), updatedAt: stamp(), expiresAt: new Date(now() + 15 * 60_000).toISOString(), ...(policyId ? { policyId } : {}) };
    state.actions.push(receipt);
    persist();
    publish({ kind: "action", actionId: receipt.id });
    queueMicrotask(() => { void run(receipt.id).catch(() => { storageError = true; }); });
    return receipt;
  }
  async function run(id: string) {
    const entry = state.actions.find((a) => a.id === id);
    if (!entry || entry.status !== "accepted") return fail("action_not_pending");
    if (!adapter) return fail("capability_unavailable");
    const assertCurrent = () => {
      if (disposed || !deps.enabled() || storageError) fail("control_paused");
      if (Date.parse(entry.expiresAt) <= now()) fail("request_expired");
      if (!callerAvailable(entry.caller)) fail("caller_unavailable");
      if (!callerAuthorized(entry.caller)) fail("console_use_not_authorized");
      if (entry.policyId) {
        const policy = state.automations.find((a) => a.id === entry.policyId);
        if (!policy || policy.status !== "active" || Date.parse(policy.input.expiresAt) <= now()) fail("policy_paused");
      }
      if (targetRevision(entry.input) !== entry.expectedRevision) fail("conflict");
    };
    try { assertCurrent(); validTarget(entry.input); }
    catch (error) { return updateAction(id, { status: "failed", error: code(error) }); }
    updateAction(id, { status: "accepted" });
    // 호출 응답은 접수만 확인한다. 실행의 실패·종료는 같은 receipt로 다시 읽는다.
    void adapter.execute(entry.input, assertCurrent, (outcome) => {
      updateAction(id, outcome === "unknown" ? { status: "outcome_unknown" } : { status: "finished", outcome });
      if (entry.policyId && outcome !== "succeeded" && outcome !== "completed") updateAutomation(entry.policyId, { status: "paused", lastError: outcome });
    }).then((result) => {
      const current = state.actions.find((a) => a.id === id)!;
      updateAction(id, { status: current.status === "accepted" ? "running" : current.status, operationId: result.operationId, delivery: result.delivery });
    }, (error) => {
      updateAction(id, { status: "failed", error: code(error) });
      if (entry.policyId) updateAutomation(entry.policyId, { status: "paused", lastError: code(error) });
    }).catch(() => { storageError = true; });
    return state.actions.find((a) => a.id === id)!;
  }
  function automation(caller: ConsoleCaller, raw: ConsoleAutomationInput) {
    if (!callerAvailable(caller)) fail("caller_unavailable");
    if (!callerAuthorized(caller)) fail("console_use_not_authorized");
    if (!deps.enabled()) fail("console_control_disabled");
    const input = automationSchema.parse(raw);
    const expires = Date.parse(input.expiresAt);
    if (expires <= now() || expires > now() + 30 * 86_400_000) fail("invalid_expiry");
    if (!deps.theaters().some((t) => t.id === input.theaterId)) fail("unknown_theater");
    if (input.trigger.kind === "activity" && node(input.trigger.operationId)?.theaterId !== input.theaterId) fail("unknown_operation");
    if (input.action.kind !== "briefing") validTarget(input.action, input.theaterId);
    if (state.automations.length >= 100) {
      // 상한에서만 종료된 정책의 자리를 회수한다. 재개 가능한 paused 정책과 실행 중 영수증은 보존한다.
      state.automations = state.automations.filter((policy) => {
        const finished = Date.parse(policy.input.expiresAt) <= now() || policy.runs >= policy.input.maxRuns;
        return !finished || state.actions.some((action) => action.policyId === policy.id && pendingStatuses.has(action.status));
      });
    }
    if (state.automations.length >= 100) fail("automation_capacity");
    const row: ConsoleAutomation = { id: randomUUID(), caller, input, status: "active", runs: 0, createdAt: stamp(), ...(input.trigger.kind === "interval" ? { nextRunAt: new Date(now() + input.trigger.minutes * 60_000).toISOString() } : {}) };
    state.automations.push(row); persist(); publish({ kind: "automation", automationId: row.id }); return row;
  }
  function briefing(theaterId: string) {
    const ops = deps.operations().filter((op) => op.theaterId === theaterId);
    const counts: Record<string, number> = {};
    for (const op of ops) { const key = observe(op.id)?.activity ?? "unknown"; counts[key] = (counts[key] ?? 0) + 1; }
    return { at: stamp(), total: ops.length, unknown: counts.unknown ?? 0, counts };
  }
  async function tick() {
    if (disposed || ticking || !adapter || storageError) return;
    ticking = true;
    try {
      const changes = new Map<string, ConsoleActivity>();
      const alive = new Set<string>();
      for (const op of deps.operations()) {
        alive.add(op.id);
        const obs = observe(op.id);
        const fingerprint = hash([op.title, op.theaterId, obs?.activity, obs?.lifecycle, obs?.output.revision, obs?.output.outcome]);
        if (observed.get(op.id) !== fingerprint) publish({ kind: "operation", operationId: op.id, activity: obs?.activity ?? "unknown" });
        if (previousActivity.has(op.id) && previousActivity.get(op.id) !== obs?.activity && obs) changes.set(op.id, obs.activity);
        observed.set(op.id, fingerprint);
        previousActivity.set(op.id, obs?.activity ?? "unknown");
      }
      for (const id of observed.keys()) if (!alive.has(id)) { observed.delete(id); previousActivity.delete(id); publish({ kind: "removed", operationId: id }); }
      for (const action of [...state.actions]) {
        if (action.status !== "running" || !action.operationId) continue;
        if (!node(action.operationId)) updateAction(action.id, { status: "outcome_unknown", error: "target_removed" });
        else if (now() - Date.parse(action.updatedAt) > 24 * 60 * 60_000) updateAction(action.id, { status: "outcome_unknown", error: "observation_timeout" });
      }
      if (!deps.enabled()) return;
      for (const item of [...state.automations]) {
        if (item.status !== "active") continue;
        if (!callerAvailable(item.caller) || !deps.theaters().some((t) => t.id === item.input.theaterId)) { updateAutomation(item.id, { status: "paused", lastError: "scope_unavailable" }); continue; }
        // 소유자가 허용을 거둔 정책은 여기서 멈춘다 — 사라진 것이 아니라 권한이 걷힌 것이라 사유를 구분한다.
        if (!callerAuthorized(item.caller)) { updateAutomation(item.id, { status: "paused", lastError: "owner_not_authorized" }); continue; }
        if (state.actions.some((a) => a.policyId === item.id && pendingStatuses.has(a.status))) continue;
        if (Date.parse(item.input.expiresAt) <= now()) { updateAutomation(item.id, { status: "expired" }); continue; }
        if (item.runs >= item.input.maxRuns) { updateAutomation(item.id, { status: "exhausted" }); continue; }
        const trigger = item.input.trigger;
        const due = trigger.kind === "interval" ? Date.parse(item.nextRunAt ?? item.createdAt) <= now() : changes.get(trigger.operationId) === trigger.activity;
        if (!due) continue;
        // 예산은 부작용 전에 영속 차감한다. 실패도 시도 횟수를 소비한다.
        updateAutomation(item.id, { runs: item.runs + 1, lastRunAt: stamp(), ...(trigger.kind === "interval" ? { nextRunAt: new Date(now() + trigger.minutes * 60_000).toISOString() } : {}) });
        try {
          if (item.input.action.kind === "briefing") updateAutomation(item.id, { briefing: briefing(item.input.theaterId), lastError: undefined });
          else {
            validTarget(item.input.action, item.input.theaterId);
            request(item.caller, `automation:${item.id}:${item.runs + 1}`, item.input.action, undefined, item.id);
          }
        } catch (error) { updateAutomation(item.id, { status: "paused", lastError: code(error) }); }
      }
    } finally { ticking = false; }
  }
  async function readEvents(cursor?: string, waitMs = 0, signal?: AbortSignal) {
    let after = sequence;
    if (cursor) {
      const [generation, raw] = cursor.split(":"); after = Number(raw);
      if (generation !== epoch || !Number.isSafeInteger(after) || after < (events[0]?.seq ?? 1) - 1 || after > sequence) fail("cursor_expired");
    }
    if (sequence === after && waitMs > 0 && !disposed) await new Promise<void>((resolve) => {
      const wake = () => { clearTimeout(timeout); waiters.delete(wake); signal?.removeEventListener("abort", wake); resolve(); };
      const timeout = setTimeout(wake, Math.min(waitMs, 25_000));
      waiters.add(wake); signal?.addEventListener("abort", wake, { once: true }); if (signal?.aborted) wake();
    });
    if (disposed) fail("console_unavailable");
    if (signal?.aborted) fail("cancelled");
    if (after < (events[0]?.seq ?? 1) - 1) fail("cursor_expired");
    return { cursor: `${epoch}:${sequence}`, events: events.filter((e) => e.seq > after), complete: true, retention: "1000 events; host lifetime" };
  }
  function code(error: unknown) { return error instanceof ConsoleControlError ? error.code : error instanceof z.ZodError ? "invalid_arguments" : "execution_unavailable"; }
  return {
    attach(value: ConsoleExecutionAdapter) { if (adapter) throw new Error("Console execution already attached"); adapter = value; return () => { if (adapter === value) adapter = null; }; },
    observe, revision, request, automation, readEvents, briefing, tick,
    getAction(id: string, caller?: ConsoleCaller) { return state.actions.find((a) => a.id === id && (!caller || sameCaller(a.caller, caller))) ?? null; },
    listAutomations(caller: ConsoleCaller) { return state.automations.filter((a) => sameCaller(a.caller, caller)); },
    pauseAutomation(id: string, caller: ConsoleCaller) { const item = state.automations.find((a) => a.id === id && sameCaller(a.caller, caller)); if (!item) fail("automation_not_found"); return updateAutomation(id, { status: "paused" }); },
    state(): ConsoleControlState { return { paused: !deps.enabled(), actions: state.actions, automations: state.automations, retention: { actionDays: RETENTION_DAYS, actionLimit: ACTION_LIMIT, deduplication: "retained_receipts" } }; },
    resumeAutomation(id: string, caller: ConsoleCaller) {
      const item = state.automations.find((a) => a.id === id && sameCaller(a.caller, caller)); if (!item) return fail("automation_not_found");
      {
        if (!deps.enabled()) fail("console_control_disabled");
        if (Date.parse(item.input.expiresAt) <= now()) fail("request_expired");
        if (item.runs >= item.input.maxRuns) fail("budget_exhausted");
        if (item.input.action.kind !== "briefing") validTarget(item.input.action, item.input.theaterId);
      }
      return updateAutomation(id, { status: "active", ...(item.input.trigger.kind === "interval" ? { nextRunAt: new Date(now() + item.input.trigger.minutes * 60_000).toISOString() } : {}) });
    },
    enabled: deps.enabled,
    dispose() { disposed = true; clearInterval(timer); for (const wake of waiters) wake(); adapter = null; },
  };
}
export type ConsoleControl = ReturnType<typeof createConsoleControl>;
