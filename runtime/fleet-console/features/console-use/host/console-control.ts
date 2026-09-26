import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureSafeDirectory } from "@fleet-console/infra";
import { sanitizeLaunchPrompt } from "@fleet-console/agent-runtime/fleet";
import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ConsoleCaller, ConsoleActionInput, ConsoleActionResult, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleOperationObservation } from "@fleet-console/sdk/mcp";
import { z } from "zod";

import { LaunchKeyError, type LaunchKeyLedger, type LaunchKeyState } from "./launch-keys.js";

const callerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operation"), operationId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("plugin"), pluginId: z.string().min(1).max(128) }).strict(),
]);
const sameCaller = (a: ConsoleCaller, b: ConsoleCaller) => a.kind === "operation" && b.kind === "operation"
  ? a.operationId === b.operationId : a.kind === "plugin" && b.kind === "plugin" && a.pluginId === b.pluginId;
const activity = z.enum(["idle", "running", "awaiting", "background", "ended", "unknown"]);
const actionObjectSchema = z.object({
  kind: z.enum(["launch", "send", "interrupt", "resume"]),
  theaterId: z.string().min(1).max(128).optional(), operationId: z.string().min(1).max(128).optional(),
  text: z.string().min(1).max(32_000).optional(), model: z.string().max(200).optional(), effort: z.string().max(32).optional(),
  viewMode: z.enum(["chat", "terminal"]).optional(),
  display: z.string().min(1).max(32_000).optional(), displayFormat: z.enum(["markdown", "text"]).optional(),
  groupId: z.string().min(1).max(128).optional(), title: z.string().trim().min(1).max(120).optional(),
  sessionName: z.string().trim().min(1).max(64).regex(/^[^\r\n\t\u0000-\u001f]+$/).optional(),
  disableSubagents: z.boolean().optional(), disableUserQuestions: z.boolean().optional(), dormant: z.boolean().optional(),
  parentOperationId: z.string().min(1).max(128).optional(),
  launchKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  newOperationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
}).strict();
export const actionSchema = actionObjectSchema.superRefine((value, ctx) => {
  // launch 는 첫 프롬프트 없이도 선다 — 시스템 지침만 싣고 다른 세션의 메시지를 기다리는 담당 세션이 그렇다.
  if (value.kind === "launch" ? !value.theaterId || value.operationId : !value.operationId || value.theaterId || (value.kind === "send" && !value.text)) ctx.addIssue({ code: "custom", message: "invalid_action_target" });
  if (value.kind !== "launch" && (value.model || value.effort || value.viewMode || value.groupId || value.title || value.sessionName || value.disableSubagents || value.disableUserQuestions || value.dormant !== undefined || value.parentOperationId !== undefined || value.launchKey !== undefined || value.newOperationId !== undefined)) ctx.addIssue({ code: "custom", message: "invalid_launch_option" });
  if (value.newOperationId && !value.launchKey) ctx.addIssue({ code: "custom", message: "invalid_launch_option" });
  if (value.kind === "launch" && value.dormant && (value.text !== undefined || value.display !== undefined || value.displayFormat !== undefined)) ctx.addIssue({ code: "custom", message: "invalid_launch_option" });
  if (value.kind === "interrupt" && (value.text || value.display || value.displayFormat)) ctx.addIssue({ code: "custom", message: "invalid_interrupt" });
  if (value.kind === "resume" && (value.text !== undefined || value.display !== undefined || value.displayFormat !== undefined)) ctx.addIssue({ code: "custom", message: "invalid_resume" });
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
 * 자리·같은 모양이다. 전역 Console Use는 항상 열려 있고, 이 Operation 토글이 실제 권한이다.
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
/** 전달 뒤 턴이 끝났다는 소식이 끝내 오지 않은 동작을 진행 중 목록에서 내리는 시한. */
const INFLIGHT_LIMIT_MS = 24 * 60 * 60_000;

export interface ConsoleExecutionAdapter {
  observe(operationId: string): ConsoleOperationObservation | null;
  execute(input: ConsoleActionInput, assertCurrent: () => void, settled: (outcome: "completed" | "succeeded" | "failed" | "interrupted" | "unknown") => void, caller: ConsoleCaller): Promise<{ readonly operationId: string; readonly delivery: "queued" | "confirmed" | "requested" }>;
}
export interface ConsoleControlDeps {
  readonly directory: string;
  readonly operations: () => readonly OperationNode[];
  readonly theaters: () => readonly { readonly id: string; readonly name: string }[];
  readonly pluginAvailable?: (pluginId: string) => boolean;
  /** 멱등 기동 키 원장 — 없으면 키 붙은 기동은 capability_unavailable. */
  readonly launchKeys?: LaunchKeyLedger;
  readonly now?: () => number;
}
interface SavedState { version: 3; automations: ConsoleAutomation[] }
interface ControlEvent { readonly seq: number; readonly at: string; readonly kind: string; readonly operationId?: string; readonly activity?: ConsoleActivity; readonly automationId?: string }
/**
 * 진행 중인 동작 — 메모리에만 있다. 접수에서 턴의 종료(또는 전달 실패)까지만 살고 영속하지 않는다.
 * 같은 키의 기동 합류와 자동 정책의 「진행 중이면 건너뜀」이 이 목록만 본다.
 */
interface InFlight {
  readonly caller: ConsoleCaller;
  readonly input: ConsoleActionInput;
  readonly policyId?: string;
  readonly expiresAt: number;
  updatedAt: number;
  operationId?: string;
  result?: Promise<ConsoleActionResult>;
}

export function createConsoleControl(deps: ConsoleControlDeps) {
  const now = deps.now ?? Date.now;
  const stamp = () => new Date(now()).toISOString();
  const file = path.join(deps.directory, "state.json");
  let state: SavedState = { version: 3, automations: [] };
  let storageError = false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    // 동작 영수증(옛 파일의 actions)은 더 저장하지 않는다 — 읽지 않고 버린다. v1 은 소유자 필드 이름만 다르다.
    const migrate = ({ callerOperationId, ...row }: Record<string, unknown>) => ({ ...row, caller: { kind: "operation", operationId: callerOperationId } });
    if (![1, 2, 3].includes(raw?.version) || !Array.isArray(raw.automations)) throw new Error("invalid_state");
    const automations = (raw.version === 1 ? raw.automations.map(migrate) : raw.automations) as ConsoleAutomation[];
    if (automations.length > 100
      || automations.some((a) => !a || typeof a.id !== "string" || !callerSchema.safeParse(a.caller).success || !Number.isSafeInteger(a.runs) || a.runs < 0 || !["approval_required", "active", "paused", "expired", "exhausted"].includes(a.status) || !automationSchema.safeParse(a.input).success)) throw new Error("invalid_state");
    // 자동 정책은 기존 계약대로 재시작 뒤 일시 중지한다.
    state = { version: 3, automations: automations.map((a) => a.status === "active" || (a.status as string) === "approval_required" ? { ...a, status: "paused" } : a) };
    // 옛 형식이면 바로 다시 쓴다 — 읽지 않는 영수증이 다음 정책 변경 때까지 디스크에 남지 않게.
    if (raw.version !== 3) persist();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") storageError = true;
  }
  let adapter: ConsoleExecutionAdapter | null = null;
  let disposed = false;
  let ticking = false;
  const epoch = randomUUID();
  let sequence = 0;
  const events: ControlEvent[] = [];
  const inflight = new Map<string, InFlight>();
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
   * 플러그인 소유자는 Operation 토글이 없다. 살아 있는 도구 호출은 연결의 `enabled`(부관 grant)가
   * 막고 존재는 `pluginAvailable`이 지킨다. `console_automation`은 화면 자리에서 빠져 새 정책이
   * 살아 있는 도구로 서지 않으므로, 여기서 플러그인 grant를 다시 묻지 않는다.
   */
  function callerAuthorized(caller: ConsoleCaller) {
    if (caller.kind !== "operation") return true;
    const operation = node(caller.operationId);
    return !!operation && readConsoleUseFlag(operation.payload) !== null;
  }
  function observe(id: string) { return adapter?.observe(id) ?? null; }
  function validTarget(input: ConsoleActionInput, theaterId?: string) {
    if (input.kind === "launch") {
      if (!deps.theaters().some((t) => t.id === input.theaterId) || (theaterId && theaterId !== input.theaterId)) fail("unknown_theater");
    } else {
      const op = node(input.operationId!);
      if (!op || (theaterId && op.theaterId !== theaterId)) return fail("unknown_operation");
      const observation = observe(op.id);
      if (input.kind === "interrupt" && (observation?.activity === "idle" || observation?.activity === "ended")) fail("nothing_to_interrupt");
      if (input.kind === "resume" && observation?.lifecycle !== "dormant") fail("not_dormant");
      if (!observation?.supportedActions.includes(input.kind)) fail("capability_unavailable");
    }
  }
  /**
   * 키 붙은 기동 — 같은 키로는 Operation 이 많아야 하나 생긴다. 살아 있으면 새로 띄우지 않고 그 Operation 을 돌려주고, 사람이
   * 지웠으면(유예 중이든 purge 됐든) 다시 만들지 않는다. 같은 키의 기동이 진행 중이면 그 결과에 합류한다.
   * 아니면 키를 예약(용량 검사)하고 새 기동으로 진행한다 — 키는 Operation payload 에 실려 생성과 함께 영속된다.
   */
  function keyedLaunch(caller: ConsoleCaller, input: ConsoleActionInput): Promise<ConsoleActionResult> | null {
    if (caller.kind !== "plugin") fail("invalid_launch_option");
    const ledger = deps.launchKeys;
    if (!ledger) return fail("capability_unavailable");
    const owner = (caller as { pluginId: string }).pluginId;
    const found = launchKeyState(caller, input.theaterId!, input.launchKey!);
    if (found.state === "live") return Promise.resolve({ operationId: found.operationId! });
    if (found.state === "deleting" || found.state === "purged") fail("launch_key_deleted");
    if (found.state === "pending") return pendingKeyed(caller, input.launchKey!)!.result!;
    if (input.newOperationId && deps.operations().some((operation) => operation.id === input.newOperationId)) fail("operation_id_taken");
    try { ledger.reserve(owner, input.theaterId!, [input.launchKey!]); }
    catch (error) { if (error instanceof LaunchKeyError) fail(error.code); throw error; }
    return null;
  }
  function pendingKeyed(caller: ConsoleCaller, key: string) {
    return [...inflight.values()].find((a) => sameCaller(a.caller, caller) && a.input.launchKey === key && !a.operationId) ?? null;
  }
  /** 키의 지금 상태 — 살아 있음·유예·purge 가 진행 중 기동보다 먼저다(생성 직후 진행 중 목록에 id 가 붙기 전에도 live 로 읽힌다). */
  function launchKeyState(caller: ConsoleCaller, theaterId: string, key: string): { readonly state: LaunchKeyState | "pending"; readonly operationId?: string } {
    if (caller.kind !== "plugin") fail("invalid_launch_option");
    const ledger = deps.launchKeys;
    if (!ledger) return fail("capability_unavailable");
    if (!deps.theaters().some((t) => t.id === theaterId)) fail("unknown_theater");
    let found: ReturnType<LaunchKeyLedger["state"]>;
    try { found = ledger.state((caller as { pluginId: string }).pluginId, theaterId, key); }
    catch (error) { if (error instanceof LaunchKeyError) return fail(error.code); throw error; }
    if (found.state === "live" || found.state === "deleting" || found.state === "purged") return found;
    return pendingKeyed(caller, key) ? { state: "pending" } : found;
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
  /**
   * 동작을 접수하고 전달을 시작한다. 검증 실패는 즉시 던지고, 전달의 성패는 돌려준 Promise 가 말한다.
   * 결과는 어디에도 남지 않는다 — 같은 입력을 다시 보내면 다시 실행된다. 키 붙은 기동만 launch-keys 원장이 중복을 막는다.
   */
  function accept(caller: ConsoleCaller, raw: ConsoleActionInput, policyId?: string): Promise<ConsoleActionResult> {
    if (disposed) fail("console_unavailable");
    if (!callerAvailable(caller)) fail("caller_unavailable");
    if (!callerAuthorized(caller)) fail("console_use_not_authorized");
    const input = actionSchema.parse(raw);
    validTarget(input);
    if (input.newOperationId && caller.kind !== "plugin") fail("invalid_launch_option");
    if (input.launchKey !== undefined) {
      const joined = keyedLaunch(caller, input);
      if (joined) return joined;
    }
    const id = randomUUID();
    const entry: InFlight = { caller, input, ...(policyId ? { policyId } : {}), expiresAt: now() + 15 * 60_000, updatedAt: now() };
    inflight.set(id, entry);
    entry.result = Promise.resolve().then(() => dispatch(id, entry));
    return entry.result;
  }
  function request(caller: ConsoleCaller, input: ConsoleActionInput): Promise<ConsoleActionResult> {
    try { return accept(caller, input); }
    catch (error) { return Promise.reject(error instanceof ConsoleControlError ? error : new ConsoleControlError(code(error))); }
  }
  function pausePolicy(policyId: string, lastError: string) {
    // 정책이 그새 지워졌거나 저장이 막혔어도 동작의 결과는 그대로 호출자에게 간다.
    try { updateAutomation(policyId, { status: "paused", lastError }); } catch { /* persist 가 storageError 를 남긴다 */ }
  }
  async function dispatch(id: string, entry: InFlight): Promise<ConsoleActionResult> {
    const assertCurrent = () => {
      if (disposed) fail("control_paused");
      if (entry.expiresAt <= now()) fail("request_expired");
      if (!callerAvailable(entry.caller)) fail("caller_unavailable");
      if (!callerAuthorized(entry.caller)) fail("console_use_not_authorized");
      if (entry.policyId) {
        const policy = state.automations.find((a) => a.id === entry.policyId);
        if (!policy || policy.status !== "active" || Date.parse(policy.input.expiresAt) <= now()) fail("policy_paused");
      }
    };
    // 턴이 끝나면 진행 중 목록에서 내린다. 전달 전에 끝났다고 알려 오는 동작(재개·중단)도 있다.
    const settled = (outcome: "completed" | "succeeded" | "failed" | "interrupted" | "unknown") => {
      inflight.delete(id);
      if (entry.policyId && outcome !== "succeeded" && outcome !== "completed") pausePolicy(entry.policyId, outcome);
    };
    try {
      if (!adapter) fail("capability_unavailable");
      assertCurrent();
      validTarget(entry.input);
      const result = await adapter!.execute(entry.input, assertCurrent, settled, entry.caller);
      // 키 붙은 기동이 섰다 — 호스트 상태가 나중에 비워져도 그 키를 「만든 적 없음」으로 답하지 않게 원장에 남긴다.
      if (entry.input.launchKey && entry.caller.kind === "plugin") {
        try { deps.launchKeys?.recordCreated(entry.caller.pluginId, entry.input.launchKey, result.operationId); }
        catch { /* 예약으로 남는다 — Operation payload 의 키가 여전히 live 를 말한다. */ }
      }
      entry.operationId = result.operationId;
      entry.updatedAt = now();
      return { operationId: result.operationId, delivery: result.delivery };
    } catch (error) {
      inflight.delete(id);
      const failure = code(error);
      if (entry.policyId) pausePolicy(entry.policyId, failure);
      throw new ConsoleControlError(failure);
    }
  }
  const policyBusy = (policyId: string) => [...inflight.values()].some((a) => a.policyId === policyId);
  function automation(caller: ConsoleCaller, raw: ConsoleAutomationInput) {
    if (!callerAvailable(caller)) fail("caller_unavailable");
    if (!callerAuthorized(caller)) fail("console_use_not_authorized");
    const input = automationSchema.parse(raw);
    const expires = Date.parse(input.expiresAt);
    if (expires <= now() || expires > now() + 30 * 86_400_000) fail("invalid_expiry");
    if (!deps.theaters().some((t) => t.id === input.theaterId)) fail("unknown_theater");
    if (input.trigger.kind === "activity" && node(input.trigger.operationId)?.theaterId !== input.theaterId) fail("unknown_operation");
    if (input.action.kind !== "briefing") validTarget(input.action, input.theaterId);
    if (state.automations.length >= 100) {
      // 상한에서만 종료된 정책의 자리를 회수한다. 재개 가능한 paused 정책과 진행 중 동작의 정책은 보존한다.
      state.automations = state.automations.filter((policy) => {
        const finished = Date.parse(policy.input.expiresAt) <= now() || policy.runs >= policy.input.maxRuns;
        return !finished || policyBusy(policy.id);
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
        // 사이드바 순서·그룹 소속도 목록의 일부다 — 바뀌면 console_operations 의 waitMs 를 깨운다.
        const placement = op as OperationNode & { readonly groupId?: string | null; readonly order?: number };
        const fingerprint = hash([op.title, op.theaterId, placement.groupId ?? null, placement.order ?? null, obs?.activity, obs?.lifecycle, obs?.output.revision, obs?.output.outcome]);
        if (observed.get(op.id) !== fingerprint) publish({ kind: "operation", operationId: op.id, activity: obs?.activity ?? "unknown" });
        if (previousActivity.has(op.id) && previousActivity.get(op.id) !== obs?.activity && obs) changes.set(op.id, obs.activity);
        observed.set(op.id, fingerprint);
        previousActivity.set(op.id, obs?.activity ?? "unknown");
      }
      for (const id of observed.keys()) if (!alive.has(id)) { observed.delete(id); previousActivity.delete(id); publish({ kind: "removed", operationId: id }); }
      // 대상이 사라졌거나 끝났다는 소식이 끝내 오지 않은 동작은 진행 중에서 내린다 — 정책이 영영 건너뛰지 않게.
      for (const [id, action] of inflight) {
        if ((action.operationId && !node(action.operationId)) || now() - action.updatedAt > INFLIGHT_LIMIT_MS) inflight.delete(id);
      }
      for (const item of [...state.automations]) {
        if (item.status !== "active") continue;
        if (!callerAvailable(item.caller) || !deps.theaters().some((t) => t.id === item.input.theaterId)) { updateAutomation(item.id, { status: "paused", lastError: "scope_unavailable" }); continue; }
        // 소유자가 허용을 거둔 정책은 여기서 멈춘다 — 사라진 것이 아니라 권한이 걷힌 것이라 사유를 구분한다.
        if (!callerAuthorized(item.caller)) { updateAutomation(item.id, { status: "paused", lastError: "owner_not_authorized" }); continue; }
        if (policyBusy(item.id)) continue;
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
            // 전달 실패는 dispatch 가 정책을 멈추며 남긴다.
            accept(item.caller, item.input.action, item.id).catch(() => undefined);
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
    observe, request, automation, readEvents, briefing, tick,
    launchKeyState,
    reserveLaunchKeys(caller: ConsoleCaller, theaterId: string, keys: readonly string[]) {
      if (caller.kind !== "plugin") return fail("invalid_launch_option");
      if (!deps.launchKeys) return fail("capability_unavailable");
      if (!deps.theaters().some((t) => t.id === theaterId)) fail("unknown_theater");
      try { deps.launchKeys.reserve(caller.pluginId, theaterId, keys); }
      catch (error) { if (error instanceof LaunchKeyError) fail(error.code); throw error; }
    },
    launchKeyUsage(caller: ConsoleCaller) {
      if (caller.kind !== "plugin" || !deps.launchKeys) return fail("capability_unavailable");
      return deps.launchKeys.usage(caller.pluginId);
    },
    listAutomations(caller: ConsoleCaller) { return state.automations.filter((a) => sameCaller(a.caller, caller)); },
    pauseAutomation(id: string, caller: ConsoleCaller) { const item = state.automations.find((a) => a.id === id && sameCaller(a.caller, caller)); if (!item) fail("automation_not_found"); return updateAutomation(id, { status: "paused" }); },
    state(): ConsoleControlState { return { paused: disposed || storageError, automations: state.automations }; },
    resumeAutomation(id: string, caller: ConsoleCaller) {
      const item = state.automations.find((a) => a.id === id && sameCaller(a.caller, caller)); if (!item) return fail("automation_not_found");
      {
        if (disposed || storageError) fail("control_paused");
        if (Date.parse(item.input.expiresAt) <= now()) fail("request_expired");
        if (item.runs >= item.input.maxRuns) fail("budget_exhausted");
        if (item.input.action.kind !== "briefing") validTarget(item.input.action, item.input.theaterId);
      }
      return updateAutomation(id, { status: "active", ...(item.input.trigger.kind === "interval" ? { nextRunAt: new Date(now() + item.input.trigger.minutes * 60_000).toISOString() } : {}) });
    },
    dispose() { disposed = true; clearInterval(timer); for (const wake of waiters) wake(); adapter = null; },
  };
}
export type ConsoleControl = ReturnType<typeof createConsoleControl>;
