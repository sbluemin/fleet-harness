
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

interface SpawnInput {
  readonly tool_use_id: string;
  readonly description: string;

  readonly prompt?: string;
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

const MAX_PROMPT_CHARS = 64 * 1024;

function boundedPrompt(prompt: string | undefined): string | undefined {
  if (typeof prompt !== "string" || prompt === "") return undefined;
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
}

const EXECUTION_AGENT = "execute";
const EXECUTION_AGENT_TYPE = `fleet:${EXECUTION_AGENT}`;

const EXECUTION_CONTRACT = "__FLEET_EXECUTION_CONTRACT__";

let executionAgentReady = false;

const PANE_ID = "fleet-routing";
const PANE_TITLE = "Fleet Routing";
const COMMAND_NAME = "fleet-routing";
type RowState = "asked" | "seated" | "running" | "done" | "denied";

const GATEWAY_PREFIX = "claude-gateway--";

function modelLabel(model: string, effort?: string): string {
  if (!model.startsWith(GATEWAY_PREFIX)) return model;
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

const awaitingSpawn = new Map<string, Row>();

const running = new Map<string, Row>();

const assigned = new Map<string, Decision>();

let paneOpen = false;
let ticker: { cancel: () => void } | undefined;

let offHost = 0;

let onHost = 0;

let observed = 0;

const MAX_ROWS = 64;

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
    try {
      await $.command.register({
        name: COMMAND_NAME,
        description: "Show how Fleet routed this session's delegated runs",
        immediate: true,
      });
    } catch {
    }
    return next(e);
  });

  on("command.run", { command: COMMAND_NAME }, async ($, e, next) => {
    await openPane($, true);
    return { text: summaryLine() };
  });

  on("tool.call", { tool: "Agent" }, async ($, e, next) => {
    const call = e as { tool_use_id: string; description?: string; subagent_type?: string };
    const row = addRow({
      key: call.tool_use_id,
      surface: "agent",
      description: typeof call.description === "string" ? call.description : "subagent",
      asked: call.subagent_type ?? "inherit",
      state: "asked",
      startedAt: Date.now(),
    });
    awaitingSpawn.set(call.tool_use_id, row);
    await openPane($);
    redraw($);
    try {
      return await next(e);
    } finally {
      awaitingSpawn.delete(call.tool_use_id);
    }
  });

  on("tool.call", { tool: "Workflow" }, async ($, e, next) => {
    await openPane($);
    redraw($);
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    const row =
      awaitingSpawn.get(e.tool_use_id) ??
      addRow({
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
    redraw($);

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

        if (decision.model !== undefined) assigned.set(result.agentId, decision);
      }
      startTicker($);
    }
    redraw($);
    return result;
  }).catch(($, e, next) => {
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const agentId = e.agentId;

    if (agentId === undefined) return yield* next(e);
    const known = running.get(agentId);
    if (known !== undefined) {
      const seat = assigned.get(agentId);

      if (seat !== undefined) {
        return yield* next({
          ...e,
          model: seat.model,
          ...(seat.effort === undefined ? {} : { effort: seat.effort }),
        });
      }
      if (known.observed === undefined && e.model.startsWith(GATEWAY_PREFIX)) {
        known.carried = modelLabel(e.model, e.effort);
      }
      return yield* next(e);
    }

    const seat = await assignStage($, e.model);
    const row = addRow({
      key: `turn:${agentId}`,
      surface: "workflow",

      description: `run ${agentId.slice(0, 6)}`,
      carried: seat?.carried ?? modelLabel(e.model, e.effort),
      because: seat?.because ?? "its caller chose this model",
      state: "running",
      startedAt: Date.now(),
      agentId,
      ...(seat === undefined ? { observed: true as const } : {}),
    });
    running.set(agentId, row);
    if (seat === undefined) observed += 1;
    else {
      assigned.set(agentId, seat);
      offHost += 1;
    }
    startTicker($);
    void openPane($);
    redraw($);
    $.ui.log(
      `stage: agentId=${agentId} saw=${e.model} carried=${seat?.carried ?? "(unchanged)"}`,
      { to: "debug" },
    );
    return yield* next(
      seat === undefined
        ? e
        : { ...e, model: seat.model as string, ...(seat.effort === undefined ? {} : { effort: seat.effort }) },
    );
  });

  on("turn.complete", ($, e, next) => {
    const row = e.agentId === undefined ? undefined : running.get(e.agentId);
    if (row) {
      row.state = "done";
      row.endedAt = Date.now();

      const model = e.usage?.model;
      if (model !== undefined) row.carried = modelLabel(model);
      running.delete(e.agentId as string);
      assigned.delete(e.agentId as string);
      if (running.size === 0) stopTicker();
      redraw($);
    }
    return next(e);
  });

  on("ui.close", { id: PANE_ID }, ($, e, next) => {
    paneOpen = false;
    stopTicker();
    return next(e);
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, ($, e, next) => {
    const table = $.ui.resolve(e);
    return drawPane(table, e.props.bodyColumns);
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
      ...(boundedPrompt(e.prompt) === undefined ? {} : { prompt: boundedPrompt(e.prompt) }),
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

async function assignStage($: Engine, current: string): Promise<Decision | undefined> {
  try {
    const assignment = await requestAssignment($, {
      surface: "stage",
      requestedModel: current,
      unreachable: [...unreachable],
    });
    if (assignment.model === undefined) return undefined;
    return toDecision(assignment);
  } catch (error) {
    $.ui.log(`could not assign a model to a stage: ${String(error)}`, { to: "debug" });
    return undefined;
  }
}

function summaryLine(): string {
  if (ledger.length === 0) return "No delegated run yet this session.";
  const runs = `${ledger.length} ${ledger.length === 1 ? "run" : "runs"}`;

  const parts: string[] = [];
  if (offHost + onHost > 0) parts.push(`${offHost} routed, ${onHost} inherited`);
  if (observed > 0) parts.push(`${observed} not from the Agent tool`);
  const tally = parts.length === 0 ? "reading" : parts.join(" · ");
  return `${runs} · ${tally}`;
}

async function openPane($: Engine, asked = false): Promise<void> {
  if (!asked && paneOpen && (await isPlaced($))) return;
  try {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, rows: 12 });
    paneOpen = true;
  } catch {
  }
}

async function isPlaced($: Engine): Promise<boolean> {
  try {
    return (await $.ui.panes()).some((pane) => pane.id === PANE_ID && pane.isPlaced);
  } catch {
    return false;
  }
}

function redraw($: Engine): void {
  $.ui.status(statusLine());
  if (paneOpen) $.ui.invalidate("ui.render");
}

function statusLine(): string | undefined {
  const total = offHost + onHost;
  if (total === 0) return undefined;
  if (onHost === 0) return `${total} ${total === 1 ? "run" : "runs"} routed`;
  if (offHost === 0) return `${onHost} of ${total} on the session model`;
  return `${offHost} of ${total} routed`;
}

function startTicker($: Engine): void {
  if (ticker !== undefined) return;
  ticker = $.clock.every(1000, () => {
    if (paneOpen) $.ui.invalidate("ui.render");
  });
}

function stopTicker(): void {
  ticker?.cancel();
  ticker = undefined;
}

const GLYPH: Record<RowState, string> = {
  asked: "·",
  seated: "▸",
  running: "●",
  done: "✓",
  denied: "✕",
};

const COLOR: Record<RowState, string> = {
  asked: "gray",
  seated: "cyan",
  running: "cyan",
  done: "green",
  denied: "red",
};

function drawPane(t: PaneElements, bodyColumns: number): unknown {
  const { Box, Text } = t;
  const now = Date.now();
  const width = Math.max(28, bodyColumns);

  if (ledger.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No delegated run yet.</Text>
        <Text dimColor>Fleet picks a model when one starts.</Text>
      </Box>
    );
  }

  const timeWidth = 5;
  const body = Math.max(12, width - 2);
  const nameWidth = Math.max(8, Math.min(30, Math.floor((body - timeWidth - 3) * 0.45)));
  const carriedWidth = Math.max(8, Math.min(34, body - nameWidth - timeWidth - 3));

  const rows = ledger.slice(-12);
  return (
    <Box flexDirection="column" paddingX={1}>
      {rows.map((row) => (
        <Box flexDirection="column" key={row.key}>
          <Box>
            <Text color={COLOR[row.state]}>{`${GLYPH[row.state]} `}</Text>
            <Text>{pad(clip(row.description, nameWidth), nameWidth)}</Text>
            <Text>{" "}</Text>
            <Text color={row.carried === "session model" ? "yellow" : undefined} dimColor={row.state === "done"}>
              {pad(clip(row.carried ?? "seating…", carriedWidth), carriedWidth)}
            </Text>
            <Text dimColor>{padStart(elapsed(row, now), timeWidth)}</Text>
          </Box>
          {row.because === undefined ? null : (
            <Box>
              <Text dimColor>
                {`  ${clip(row.asked === undefined ? row.because : `${row.asked} → ${row.because}`, body - 2)}`}
              </Text>
            </Box>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="green" dimColor>{clip(summaryLine(), body)}</Text>
      </Box>
    </Box>
  );
}

function cellWidth(code: number): number {
  if (code === 0x200d) return 0;
  if (code >= 0x0300 && code <= 0x036f) return 0;
  if (code >= 0xfe00 && code <= 0xfe0f) return 0;
  const wide = (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}

function displayWidth(text: string): number {
  let total = 0;
  for (const character of text) total += cellWidth(character.codePointAt(0) ?? 0);
  return total;
}

function clip(text: string, width: number): string {
  if (width <= 1) return "";
  if (displayWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const character of text) {
    const next = used + cellWidth(character.codePointAt(0) ?? 0);
    if (next > width - 1) break;
    out += character;
    used = next;
  }
  return `${out}…`;
}

function pad(text: string, width: number): string {
  const used = displayWidth(text);
  return used >= width ? text : text + " ".repeat(width - used);
}

function padStart(text: string, width: number): string {
  const used = displayWidth(text);
  return used >= width ? text : " ".repeat(width - used) + text;
}
