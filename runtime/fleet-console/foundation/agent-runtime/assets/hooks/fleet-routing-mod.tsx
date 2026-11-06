
interface PaneElements {
  readonly Box: unknown;
  readonly Text: unknown;
}

interface Engine {
  readonly ui: {
    readonly notice: (toolUseId: string, text: string | undefined) => void;
    readonly open: (pane: { id: string; title?: string; rows?: number }) => Promise<void>;
    readonly panes: () => Promise<readonly { id: string; isPlaced: boolean }[]>;
    readonly status: (text: string | undefined) => void;
    readonly invalidate: (event: string) => void;
    readonly log: (text: string, options?: { to: "transcript" | "debug" }) => void;
    readonly resolve: (event: unknown) => PaneElements;
  };
  readonly env: {
    readonly get: (name: string) => Promise<string | undefined>;
  };
  readonly http: {
    readonly fetch: (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => Promise<{ ok: boolean; status: number; text: string }>;
  };
  readonly agent: {
    readonly register: (spec: { name: string; description: string; prompt: string }) => Promise<unknown>;
  };
  readonly command: {
    readonly register: (spec: { name: string; description: string; immediate?: true }) => Promise<unknown>;
  };
  readonly clock: {
    readonly every: (ms: number, fn: () => void) => { cancel: () => void };
  };
}

type Hook<E, R> = ($: Engine, e: E, next: (event: E) => Promise<R> | R) => Promise<R> | R;

type StreamHook<E, R> = ($: Engine, e: E, next: (event: E) => AsyncGenerator<unknown, R>) => AsyncGenerator<unknown, R>;

interface On {
  <E, R>(pattern: "turn.step", hook: StreamHook<E, R>): { readonly catch: (handler: StreamHook<E, R>) => void };
  <E, R>(pattern: string, hook: Hook<E, R>): { readonly catch: (handler: Hook<E, R>) => void };
  <E, R>(pattern: string, matcher: object, hook: Hook<E, R>): { readonly catch: (handler: Hook<E, R>) => void };
}

type Register = (on: On, options?: unknown) => unknown;

interface TurnStepInput {
  readonly turnId: string;
  readonly index: number;
  readonly model: string;
  readonly effort?: string;
  readonly messageCount: number;
  readonly agentId?: string;
}

const MAX_ROWS = 64;
const MAX_ASSIGNED = MAX_ROWS * 4;
const MAX_RUNNING = MAX_ROWS * 2;

function recordAssignment(agentId: string, decision: Decision): void {
  assigned.set(agentId, decision);
  if (assigned.size > MAX_ASSIGNED) {
    const oldest = assigned.keys().next().value;
    if (oldest !== undefined) assigned.delete(oldest);
  }
}

function pruneDoneRunning(): void {
  if (running.size <= MAX_RUNNING) return;
  for (const [id, row] of running.entries()) {
    if (row.state === "done" || row.state === "denied") {
      running.delete(id);
      if (running.size <= MAX_ROWS) break;
    }
  }
}

function isAnyAgentRunning(): boolean {
  for (const row of running.values()) {
    if (row.state === "running" || row.state === "asked" || row.state === "seated") return true;
  }
  return false;
}

interface SpawnInput {
  readonly tool_use_id: string;
  readonly description: string;
  readonly subagentType: string;
  readonly fork: boolean;
  readonly model?: string;
  readonly parentModel: string;

  readonly provider?: { readonly plugin: string };
}

interface Assignment {
  readonly model?: string;
  readonly effort?: string;
  readonly label: string;
  readonly because: string;
}

async function requestAssignment($: Engine, request: Record<string, unknown>): Promise<Assignment> {
  const base = await $.env.get("FLEET_MOD_BASE_URL");
  const token = await $.env.get("FLEET_MOD_TOKEN");
  if (!base || !token) {
    return { label: "session model", because: "no gateway is attached to this session" };
  }
  const response = await $.http.fetch(`${base.replace(/\/+$/, "")}/v1/fleet/routing/assign`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-mod-token": token },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`routing assignment unavailable (${response.status})`);
  const parsed: unknown = JSON.parse(response.text);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("routing assignment was not an object");
  }
  const assignment = parsed as Assignment;
  if (typeof assignment.label !== "string" || typeof assignment.because !== "string") {
    throw new Error("routing assignment carried no label");
  }
  return assignment;
}

const EXECUTION_AGENT = "execute";
const EXECUTION_AGENT_TYPE = `fleet:${EXECUTION_AGENT}`;

const EXECUTION_CONTRACT = "__FLEET_EXECUTION_CONTRACT__";

let executionAgentReady = false;

type RowState = "asked" | "seated" | "running" | "done" | "denied";

const GATEWAY_PREFIX = "claude-gateway--";

function modelLabel(model: string, effort?: string): string {
  if (!model.startsWith(GATEWAY_PREFIX)) return effort === undefined ? model : `${model} @${effort}`;
  const scoped = model.slice(GATEWAY_PREFIX.length).replace("--", "/");
  return effort === undefined ? scoped : `${scoped} @${effort}`;
}

interface Row {
  readonly key: string;

  readonly surface: "agent" | "workflow";

  description: string;

  asked?: string;

  carried?: string;

  because?: string;
  state: RowState;
  startedAt: number;
  endedAt?: number;
  agentId?: string;

  observed?: true;
}

const ledger: Row[] = [];

const unreachable = new Set<string>();

const running = new Map<string, Row>();

const assigned = new Map<string, Decision>();

let offHost = 0;

let onHost = 0;

let observed = 0;

function addRow(row: Row): Row {
  ledger.push(row);
  if (ledger.length > MAX_ROWS) ledger.splice(0, ledger.length - MAX_ROWS);
  return row;
}

function elapsed(row: Row, now: number): string {
  const ms = (row.endedAt ?? now) - row.startedAt;
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    try {
      await $.agent.register({
        name: EXECUTION_AGENT,
        description: "Fleet execution agent. Fleet assigns its model; naming it is never required.",
        prompt: EXECUTION_CONTRACT,
      });
      executionAgentReady = true;
    } catch (error) {
      $.ui.log(`could not register the execution agent: ${String(error)}`, { to: "debug" });
    }
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    // 행은 실제로 띄울 때 선다. Agent 호출이 PreToolUse에서 거절되면 이 이벤트가 오지 않으므로 판에 남는 것이 없다.
    const row = addRow({
      key: `${e.tool_use_id}:${ledger.length}`,
      surface: "agent",
      description: e.description || "subagent",
      asked: e.subagentType || "inherit",
      state: "asked",
      startedAt: Date.now(),
    });

    row.description = e.description || row.description;
    row.asked = e.fork ? "fork" : e.subagentType || "inherit";

    const decision = await assignSpawn($, e);
    row.state = "seated";
    row.carried = decision.carried;
    row.because = decision.because;
    if (decision.model === undefined) onHost += 1;
    else offHost += 1;
    $.ui.notice(e.tool_use_id, `Fleet: ${decision.carried} — ${decision.because}`);

    $.ui.log(
      `dispatch: asked=${e.model ?? "(none)"}/${row.asked} carried=${decision.carried}`,
      { to: "debug" },
    );
    const result = await next(
      decision.model === undefined
        ? e
        : {
            ...e,
            model: decision.model,

            ...(executionAgentReady && e.subagentType !== EXECUTION_AGENT_TYPE
              ? { subagentType: EXECUTION_AGENT_TYPE }
              : {}),
          },
    );

    if (result.deny !== undefined) {
      row.state = "denied";
      row.because = result.deny;
      row.endedAt = Date.now();

      if (decision.model !== undefined) unreachable.add(decision.model);
    } else {
      row.state = "running";
      if (result.agentId !== undefined) {
        row.agentId = result.agentId;
        running.set(result.agentId, row);
        recordAssignment(result.agentId, decision);
        pruneDoneRunning();
      }
    }
    return result;
  }).catch(($, e, next) => {
    return next(e);
  });

  on("turn.step", async function* ($, e: TurnStepInput, next) {
    const agentId = e.agentId;

    if (agentId === undefined) return yield* next(e);

    const seat = assigned.get(agentId);
    if (seat !== undefined) {
      const known = running.get(agentId);
      if (known !== undefined && (known.state === "done" || known.endedAt !== undefined)) {
        known.state = "running";
        known.endedAt = undefined;
      }
      if (seat.model === undefined) {
        return yield* next(e);
      }
      return yield* next({
        ...e,
        model: seat.model,
        ...(seat.effort === undefined ? {} : { effort: seat.effort }),
      });
    }

    const stageDecision = await assignStage($, e.model, e.effort);
    const decision: Decision = stageDecision ?? {
      carried: modelLabel(e.model, e.effort),
      because: "its caller chose this model",
    };
    recordAssignment(agentId, decision);

    const row = addRow({
      key: `turn:${agentId}`,
      surface: "workflow",

      description: `run ${agentId.slice(0, 6)}`,
      carried: decision.carried,
      because: decision.because,
      state: "running",
      startedAt: Date.now(),
      agentId,
      ...(stageDecision === undefined ? { observed: true as const } : {}),
    });
    running.set(agentId, row);
    pruneDoneRunning();

    if (stageDecision === undefined) observed += 1;
    else {
      offHost += 1;
    }
    $.ui.log(
      `stage: agentId=${agentId} saw=${e.model} carried=${decision.carried}`,
      { to: "debug" },
    );
    return yield* next(
      decision.model === undefined
        ? e
        : { ...e, model: decision.model, ...(decision.effort === undefined ? {} : { effort: decision.effort }) },
    );
  });

  on("turn.complete", ($, e, next) => {
    const row = e.agentId === undefined ? undefined : running.get(e.agentId);
    if (row) {
      row.state = "done";
      row.endedAt = Date.now();

      const model = e.usage?.model;
      if (model !== undefined) row.carried = modelLabel(model);
    }
    return next(e);
  });

};

interface Decision {
  readonly model?: string;

  readonly effort?: string;

  readonly carried: string;

  readonly because: string;
}

function toDecision(assignment: Assignment): Decision {
  return {
    ...(assignment.model === undefined ? {} : { model: assignment.model }),
    ...(assignment.effort === undefined ? {} : { effort: assignment.effort }),
    carried: assignment.label,
    because: assignment.because,
  };
}

async function assignSpawn($: Engine, e: SpawnInput): Promise<Decision> {
  try {
    const assignment = await requestAssignment($, {
      surface: "agent",
      description: e.description,
      ...(e.model === undefined ? {} : { requestedModel: e.model }),

      requestedEffort: null,
      subagentType: e.subagentType,
      fork: e.fork,
      ...(e.provider === undefined ? {} : { providerPlugin: e.provider.plugin }),
      unreachable: [...unreachable],
    });
    return toDecision(assignment);
  } catch (error) {
    $.ui.log(`could not assign a model: ${String(error)}`, { to: "debug" });
    return { carried: "session model", because: "Console could not be reached for an assignment" };
  }
}

async function assignStage($: Engine, current: string, effort?: string): Promise<Decision | undefined> {
  try {
    const assignment = await requestAssignment($, {
      surface: "stage",
      requestedModel: current,
      ...(effort === undefined ? {} : { requestedEffort: effort }),
      unreachable: [...unreachable],
    });
    if (assignment.model === undefined) return undefined;
    return toDecision(assignment);
  } catch (error) {
    $.ui.log(`could not assign a model to a stage: ${String(error)}`, { to: "debug" });
    return undefined;
  }
}
