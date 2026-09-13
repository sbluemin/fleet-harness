import { createEmbeddedMcpServer, defineTool } from "@dotobokuri/core-agent/claude";
import { z } from "zod";
import { createHash } from "node:crypto";
import { automationSchema, ConsoleControlError, readConsoleUseFlag, type ConsoleControl } from "./console-control.js";
import {
  createExecutorSessionManager,
  createMcpToolRegistry,
  createMcpToolSnapshotStore,
  createServedMcpEndpoint,
  type AgentToolSpec,
  type AgentToolCtx,
  type McpHttpTransport,
} from "@dotobokuri/core-agent";
import { FLEET_CONSOLE_USE_MCP_SERVER, type ConsoleCaller, type ConsoleUseMcpConnection, type ConsoleUseMcpHost, type ConsoleUseSnapshot } from "@fleet-console/sdk/mcp";
import type { OperationNode } from "@fleet-console/sdk/operations";

export interface ConsoleUseDeps {
  readonly control?: ConsoleControl;
  readonly transport?: McpHttpTransport;
  readonly theaters?: () => readonly { readonly id: string; readonly name: string }[];
  readonly operations?: () => readonly OperationNode[];
  /** 실험 「콘솔 사용」 옵트인. 없으면 꺼진 것으로 읽는다 — 옵트인의 기본은 꺼짐이다. */
  readonly experimentEnabled?: () => boolean;
  /**
   * 거부 문구의 언어 폴백. Operation이 한 번도 허용된 적 없으면 payload에 언어가 없으므로,
   * 콘솔 설정이 언어를 못박고 있을 때 그것을 쓴다. `auto`는 브라우저가 푸는 값이라 여기서는 null이다.
   */
  readonly language?: () => "en" | "ko" | null;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { items: value } : value, isError: false };
}

type ConsoleUseRefusal = "experiment_disabled" | "operation_not_authorized" | "caller_unresolved";

/**
 * 거부는 에러 코드 하나로 끝나지 않는다. 이 응답을 읽는 것은 사람이 아니라 호스트 에이전트이고,
 * 그 에이전트가 사용자에게 무엇을 부탁해야 하는지까지 여기서 말해 주지 않으면 스스로 재시도하거나
 * 다른 경로를 찾는다. `agentInstruction`은 에이전트에게 하는 말이고 `message`는 사용자에게 그대로
 * 옮길 문장이다 — 섞으면 에이전트가 자기 지침을 사용자에게 읽어 준다.
 */
const REFUSAL_REMEDY = {
  experiment_disabled: { actor: "user", surface: "settings", path: ["Settings", "Experiments", "Console use"] },
  operation_not_authorized: { actor: "user", surface: "operation_panel", path: ["Operation menu", "Console use"] },
  caller_unresolved: { actor: "none", surface: "none", path: [] },
} as const satisfies Record<ConsoleUseRefusal, { readonly actor: string; readonly surface: string; readonly path: readonly string[] }>;

const REFUSAL_INSTRUCTION: Record<ConsoleUseRefusal, string> = {
  experiment_disabled: "Console use is turned off for this Console, so the host refused this call. This is not a transient failure. Do not retry, do not look for another route into the Console, and do not answer from earlier Console results. Ask the user to turn on Settings > Experiments > Console use, then stop and wait for them. Once they do, repeat this exact call: it succeeds with no restart and no reconnection.",
  operation_not_authorized: "This Operation has not been authorized to use the Console, so the host refused this call. This is not a transient failure. Do not retry, do not look for another route into the Console, and do not answer from earlier Console results. Ask the user to turn on Console use in this Operation's own menu (the ··· button in its caption, or right-click in the sidebar), then stop and wait for them. Once they do, repeat this exact call: it succeeds with no restart and no reconnection.",
  caller_unresolved: "This session is not bound to a Console Operation, so these tools can never answer it. Do not retry and do not ask the user to change a setting — nothing they can turn on fixes this. Continue without the Console.",
};

const REFUSAL_MESSAGE: Record<ConsoleUseRefusal, Record<"en" | "ko", string>> = {
  experiment_disabled: {
    en: "Console use is turned off. Turn on Settings > Experiments > Console use — it applies immediately, with no restart.",
    ko: "Console 사용이 꺼져 있습니다. 설정 > 실험 기능 > 콘솔 사용을 켜 주세요. 켜면 다시 연결하지 않아도 곧바로 이어집니다.",
  },
  operation_not_authorized: {
    en: "This Operation is not allowed to use the Console. Turn on Console use in this Operation's ··· menu — it applies immediately, with no restart.",
    ko: "이 Operation에 Console 사용이 허용되지 않았습니다. 이 Operation의 ··· 메뉴에서 「콘솔 사용」을 켜 주세요. 켜면 다시 연결하지 않아도 곧바로 이어집니다.",
  },
  caller_unresolved: {
    en: "This session is not bound to a Console Operation, so Console tools are unavailable to it.",
    ko: "이 세션은 Console Operation에 묶여 있지 않아 Console 도구를 쓸 수 없습니다.",
  },
};

function refuse(reason: ConsoleUseRefusal, operationId: string | null, language: "en" | "ko") {
  const actionable = reason !== "caller_unresolved";
  return {
    error: "console_use_not_authorized", reason,
    retryable: actionable, retryAfter: actionable ? "user_action" : "never",
    remedy: { ...REFUSAL_REMEDY[reason], ...(operationId ? { operationId } : {}) },
    agentInstruction: REFUSAL_INSTRUCTION[reason],
    message: REFUSAL_MESSAGE[reason][language],
    capabilities: { read: false, control: false },
  };
}

/**
 * 호출자 Operation 단위 판정. 실험 플래그와 그 Operation의 토글이 **둘 다** 참일 때만 통과하고,
 * 어느 쪽이 막았는지를 구분해 돌려준다 — 사용자가 어디를 켜야 하는지가 둘에서 다르기 때문이다.
 * 신원이 풀리지 않으면 거부한다(fail-closed).
 */
function denyConsoleUse(deps: ConsoleUseDeps, ctx: AgentToolCtx) {
  const label = ctx.sessionLabel ?? "";
  const id = label.startsWith("chat:") ? label.slice(5) : label;
  const fallback = deps.language?.() ?? "en";
  const operation = deps.operations?.().find((op) => op.id === id);
  if (!operation) return refuse("caller_unresolved", null, fallback);
  const flag = readConsoleUseFlag(operation.payload);
  const language = flag?.language ?? fallback;
  if (deps.experimentEnabled?.() !== true) return refuse("experiment_disabled", operation.id, language);
  if (!flag) return refuse("operation_not_authorized", operation.id, language);
  return null;
}

function consoleSpecs(deps: ConsoleUseDeps, snapshot: () => ConsoleUseSnapshot | null, allowControl: boolean, pluginId?: string): AgentToolSpec[] {
  if (!deps.theaters || !deps.operations) return [];
  const theaters = deps.theaters;
  const operations = deps.operations;
  const control = deps.control;
  const caller = (ctx: AgentToolCtx): ConsoleCaller | null => {
    // 플러그인 소유자는 호스트가 바인딩한다. 모델 인자·브라우저 초점·토큰 라벨로 가장하지 않는다.
    if (!allowControl) return null;
    if (pluginId) return { kind: "plugin", pluginId };
    const label = ctx.sessionLabel ?? "";
    const id = label.startsWith("chat:") ? label.slice(5) : label;
    return operations().some((op) => op.id === id) ? { kind: "operation", operationId: id } : null;
  };
  const requireCaller = (ctx: AgentToolCtx) => {
    const id = caller(ctx);
    if (!allowControl || !control || !id) throw new ConsoleControlError("permission_required");
    return id;
  };
  const rows = () => {
    const current = snapshot();
    const activities = new Map(current?.operations.map((op) => [op.id, op.activity]) ?? []);
    const names = new Map(theaters().map((theater) => [theater.id, theater.name]));
    const values = operations().map((op) => {
      const observation = control?.observe(op.id);
      const snapshotActivity = activities.get(op.id);
      const stale = !observation && !!current?.takenAt && (!Number.isFinite(Date.parse(current.takenAt)) || Date.now() - Date.parse(current.takenAt) > 60_000);
      return {
        id: op.id, title: op.title, theaterId: op.theaterId, theater: names.get(op.theaterId) ?? op.theaterId,
        kind: op.type, activity: observation?.activity ?? (stale ? "unknown" : snapshotActivity ?? "unknown"),
        createdAt: new Date(op.ts.createdAt).toISOString(), revision: control?.revision(op.id) ?? String(op.ts.updatedAt),
        observation: { source: observation ? "host" : snapshotActivity ? "snapshot" : "unavailable", observedAt: observation?.observedAt ?? current?.takenAt ?? null, stale },
        attention: observation?.attention ?? { kind: snapshotActivity === "awaiting" ? "input" : "unknown" },
      };
    });
    return { snapshotAt: current?.takenAt ?? null, values };
  };
  const define = <S extends z.ZodType>(id: string, description: string, schema: S, run: (args: z.output<S>, ctx: AgentToolCtx) => unknown | Promise<unknown>): AgentToolSpec => ({
    id, tag: id, title: id, description, promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [],
    parameters: z.toJSONSchema(schema),
    execute: async (args, ctx) => {
      try { return text(await run(schema.parse(args), ctx)); }
      catch (error) {
        const code = error instanceof ConsoleControlError ? error.code : error instanceof z.ZodError ? "invalid_arguments" : "console_unavailable";
        return { ...text({ error: code, retryable: false, nextAction: code === "nothing_to_interrupt" ? "No foreground turn is running. Do not wait or retry. Interrupt does not close or delete the Operation; use the Console close control for that." : code === "cursor_expired" ? "Read a new snapshot and restart without a cursor." : code === "permission_required" ? "Use a host-authorized Console connection; reading never grants control." : "Inspect current state. Do not repeat a write with a new requestId." }), isError: true };
      }
    },
  });
  const empty = z.object({}).strict();
  const ids = z.string().min(1).max(128);
  const specs = [
    define("console_context", "Read caller identity, observation coverage, and available Console capabilities. Caller is not the browser focus. No paths or provider session identities.", empty, (_args, ctx) => {
      const all = rows().values;
      const callerId = caller(ctx);
      return { schemaVersion: 1, caller: callerId?.kind === "operation" ? { ...callerId, theaterId: operations().find((op) => op.id === callerId.operationId)!.theaterId } : callerId, focus: "unavailable", capabilities: { read: true, control: allowControl && !!callerId && !!control, approval: "Experiments > Console use and, for an Operation caller, that Operation's own Console use toggle must both be on. Both being on is blanket authorization; no individual approvals.", enabled: control?.enabled() ?? false }, coverage: { total: all.length, unknown: all.filter((r) => r.activity === "unknown").length }, management: { settingsSection: "experiments", operationToggle: "Console use, in the caller Operation's own ··· menu" }, semantics: { idle: "not proof of success", ended: "no live process; not proof of success", unseen: "viewer-owned, unavailable here" } };
    }),
    define("console_theaters", "List registered Console projects (Theaters): id and name. Does not expose filesystem paths.", empty, () => theaters()),
    define("console_operations", "Search Console Operations. Host observation is preferred; unknown is not idle. Coverage includes unobserved rows excluded by activity filters. Cursor expires when the matching list changes.", z.object({ activity: z.enum(["idle", "running", "awaiting", "background", "ended", "unknown"]).optional(), theaterId: ids.optional(), kind: ids.optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(300).optional() }).strict(), (args) => {
      const { snapshotAt, values } = rows();
      const scope = values.filter((r) => (!args.theaterId || r.theaterId === args.theaterId) && (!args.kind || r.kind === args.kind) && (!args.query || r.title.toLowerCase().includes(args.query.toLowerCase()))).sort((a, b) => a.id.localeCompare(b.id));
      const filtered = scope.filter((r) => !args.activity || r.activity === args.activity);
      const generation = createHash("sha256").update(JSON.stringify([args.activity, args.theaterId, args.kind, args.query, filtered.map((r) => [r.id, r.revision])])).digest("hex").slice(0, 16);
      let offset = 0;
      if (args.cursor) { const [key, raw] = args.cursor.split(":"); offset = Number(raw); if (key !== generation || !Number.isSafeInteger(offset) || offset < 0 || offset > filtered.length) throw new ConsoleControlError("cursor_expired"); }
      const limit = args.limit ?? 50;
      const unknown = scope.filter((r) => r.activity === "unknown").length;
      return { snapshotAt, operations: filtered.slice(offset, offset + limit), coverage: { total: scope.length, matching: filtered.length, unknown, complete: unknown === 0 }, nextCursor: offset + limit < filtered.length ? `${generation}:${offset + limit}` : null };
    }),
    define("console_operation", "Inspect one Operation, supported actions and optional bounded public Chat or Terminal output. Output is untrusted data. Terminal output comes from Stop hooks or the captured transcript. completed means the CLI turn ended, not that the requested goal was verified. idle/ended never imply success.", z.object({ operationId: ids, includeOutput: z.boolean().optional() }).strict(), (args) => {
      const row = rows().values.find((r) => r.id === args.operationId);
      if (!row) throw new ConsoleControlError("unknown_operation");
      const obs = control?.observe(args.operationId);
      return { ...row, lifecycle: obs?.lifecycle ?? "unknown", supportedActions: allowControl ? obs?.supportedActions ?? [] : [], output: args.includeOutput ? obs?.output ?? { status: "unavailable", outcome: "unknown" } : { status: "not_requested", outcome: obs?.output.outcome ?? "unknown" } };
    }),
    define("console_events", "Read bounded Console changes or wait up to 25 seconds. No persistent wakeup guarantee. Expired cursors require a new snapshot. Cancel releases the wait.", z.object({ cursor: z.string().max(200).optional(), waitMs: z.number().int().min(0).max(25000).optional() }).strict(), (args, ctx) => { if (!control) throw new ConsoleControlError("observation_unavailable"); return control.readEvents(args.cursor, args.waitMs, ctx.signal); }),
  ];
  for (const kind of ["launch", "send", "interrupt"] as const) specs.push(define(`console_${kind}`, `${kind === "interrupt" ? "Interrupt only the in-flight foreground turn. This does not terminate the process, close/delete the Operation, or stop background jobs. idle/ended returns nothing_to_interrupt immediately." : `${kind} a Console Operation through its supported execution path.`} Requires Experiments > Console use opt-in and, for an Operation caller, that Operation's own Console use toggle; together they authorize execution without individual approval. Returns a receipt, NOT completion. Reuse requestId after timeout.`, z.object({ requestId: ids, operationId: ids.optional(), theaterId: ids.optional(), text: z.string().min(1).max(32000).optional(), model: ids.optional(), effort: z.string().max(32).optional(), viewMode: z.enum(["chat", "terminal"]).optional(), expectedRevision: ids.optional() }).strict(), (args, ctx) => {
    const id = requireCaller(ctx);
    const { requestId, expectedRevision, ...input } = args;
    return control!.request(id, requestId, { ...input, kind }, expectedRevision);
  }));
  specs.push(define("console_action", "Read your action receipt: accepted is not finished. Same requestId deduplicates while the receipt is retained (7 days, at most 500 receipts).", z.object({ actionId: ids }).strict(), (args, ctx) => { const id = requireCaller(ctx); const action = control!.getAction(args.actionId, id); if (!action) throw new ConsoleControlError("action_not_found"); return action; }));
  specs.push(define("console_automation", "Create a bounded automation, list yours, pause or resume one. Console use opt-in plus the caller Operation's own toggle is blanket authorization; no individual approval. A policy is paused, not run, whenever its owner's authorization is gone at fire time. Exact target/action, expiry and attempt budget are fixed; restart pauses policies. Briefing performs no model call. No automatic approval of another agent's questions.", z.object({ mode: z.enum(["propose", "list", "pause", "resume"]), automationId: ids.optional(), policy: automationSchema.optional() }).strict(), (args, ctx) => { const id = requireCaller(ctx); if (args.mode === "list") return control!.listAutomations(id); if (args.mode === "pause" && args.automationId) return control!.pauseAutomation(args.automationId, id); if (args.mode === "resume" && args.automationId) return control!.resumeAutomation(args.automationId, id); if (args.mode === "propose" && args.policy) return control!.automation(id, args.policy); throw new ConsoleControlError("invalid_arguments"); }));
  return specs;
}

/** 각 연결은 자체 MCP endpoint·토큰·도구 바인딩을 소유한다. 플러그인 도구는 등록하지 않는다. */
export function createConsoleUseMcpHost(deps: ConsoleUseDeps): ConsoleUseMcpHost & { forPlugin(pluginId: string): ConsoleUseMcpHost; dispose(): Promise<void> } {
  const connections = new Set<ConsoleUseMcpConnection>();
  let disposed = false;
  const connect = (options: Parameters<ConsoleUseMcpHost["connect"]>[0], pluginId?: string): ConsoleUseMcpConnection => {
      if (disposed) throw new Error("Console MCP host is disposed");
      const requested = new Set(options.tools);
      const specs = consoleSpecs(deps, options.snapshot ?? (() => null), options.allowControl === true, pluginId).filter((spec) => requested.has(spec.id as typeof options.tools[number]));
      if (!specs.length || specs.length !== requested.size) throw new Error("Unavailable Console MCP tools");
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      let closed = false;
      const controller = new AbortController();
      const schemas = new Map(specs.map((spec) => [spec.id, z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject]));
      for (const spec of specs) registry.registerAgentTool({
        ...spec,
        execute: async (args, ctx) => {
          if (closed || options.enabled?.() === false) return Promise.resolve({ ...text({ error: "console_read_disabled", hint: "Console access is disabled. Do not answer from earlier Console results." }), isError: true });
          // 읽기까지 포함해 전부 여기서 막는다. 도구는 세션이 열릴 때 실리지만 허용은 매 호출에 다시
          // 묻는다 — 그래야 토글이 재연결 없이 다음 호출부터 듣는다.
          const denied = options.operationCallers === true ? denyConsoleUse(deps, ctx) : null;
          if (denied) return Promise.resolve({ ...text(denied), isError: true });
          const parsed = schemas.get(spec.id)!.safeParse(args);
          if (!parsed.success) return Promise.resolve({ ...text({ error: "invalid_arguments" }), isError: true });
          const result = await spec.execute(parsed.data, { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal });
          if (closed || options.enabled?.() === false) return { ...text({ error: "console_read_disabled" }), isError: true };
          // 호출 중에 꺼졌으면 이미 모은 결과도 내보내지 않는다 — 거부의 의미가 시간에 따라 새면 안 된다.
          const revoked = options.operationCallers === true ? denyConsoleUse(deps, ctx) : null;
          if (revoked) return { ...text(revoked), isError: true };
          return result;
        },
      });
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_CONSOLE_USE_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_CONSOLE_USE_MCP_SERVER, runtime: { registry, snapshotStore, server } }] });
      let closing: Promise<void> | undefined;
      const embeddedServer = createEmbeddedMcpServer({
        name: FLEET_CONSOLE_USE_MCP_SERVER,
        tools: registry.getAllAgentTools().map((spec) => defineTool(
          spec.id,
          spec.description,
          schemas.get(spec.id)!.shape,
          async (args) => await spec.execute(args, { cwd: "", signal: controller.signal }) as { content: readonly Readonly<Record<string, unknown>>[]; isError?: boolean },
        )),
      });
      const connection: ConsoleUseMcpConnection = {
        embeddedServer,
        getEndpoint: async () => {
          if (closed) throw new Error("Console MCP connection is disposed");
          return manager.getEndpoint();
        },
        issueSessionToken: (request) => {
          if (closed) throw new Error("Console MCP connection is disposed");
          return manager.issueSessionToken(request);
        },
        releaseSessionToken: (label) => manager.releaseSessionToken(label),
        cleanup: () => manager.cleanup(),
        dispose: () => {
          if (closing) return closing;
          closed = true;
          controller.abort();
          manager.cleanup();
          connections.delete(connection);
          closing = server.stop();
          return closing;
        },
      };
      connections.add(connection);
      return connection;
  };
  return {
    connect: (options) => connect(options),
    forPlugin: (pluginId) => ({ connect: (options) => connect(options, pluginId) }),
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...connections].map((connection) => connection.dispose()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Console MCP cleanup failed");
    },
  };
}
