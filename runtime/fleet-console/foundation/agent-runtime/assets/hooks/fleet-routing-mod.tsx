/**
 * fleet-routing-mod — 게이트웨이 정체성을 세션에 올리고, 위임이 무엇으로 돌았는지 보여주는
 * Claude Code Mod.
 *
 * 두 가지 일을 한다.
 *
 *   1. 등록. 세션이 시작되면 Console에 지금 노출된 게이트웨이 모델을 묻고, 모델×강도마다
 *      정체성 하나를 `$.agent.register`로 올린다. 한때는 같은 정의를 플러그인 `agents/*.md`
 *      파일로 구웠다. 플러그인 스냅숏은 내용 해시로 발행되는 공유 트리라, 노출 목록이 거기
 *      들어가면 모델을 하나 켤 때마다 새 트리가 발행된다. 스냅숏을 정적으로 두고 목록은
 *      호출 시점에 묻는 편이 그 결합을 끊는다.
 *
 *   2. 원장. 위임 하나하나가 무엇을 요청했고 무엇으로 돌았는지 `Fleet Routing` 판에 적는다.
 *      어느 모델을 쓸지는 호스트가 로스터를 읽고 정한다 — 이 모듈은 그 결정을 대신하지 않고,
 *      결정이 실제로 무엇이었는지 사후에 확인할 수 있게 만든다. 판이 없으면 "상속했는가"를
 *      물어볼 방법이 모델에게 묻는 것밖에 없다.
 *
 * 주소와 자격은 런치가 환경변수로 넘긴다(FLEET_MOD_BASE_URL·FLEET_MOD_TOKEN). 둘이 없거나
 * 조회가 실패하면 아무 정체성도 올리지 않고 관측만 한다 — 게이트웨이 없이 뜬 세션이 그 경우다.
 */
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
      init?: { method?: string; headers?: Record<string, string> },
    ) => Promise<{ ok: boolean; status: number; text: string }>;
  };
  readonly agent: {
    readonly register: (spec: {
      name: string;
      description: string;
      prompt: string;
      model?: string;
      effort?: string | number;
    }) => Promise<unknown>;
  };
  readonly command: {
    readonly register: (spec: { name: string; description: string; immediate?: true }) => Promise<unknown>;
  };
  readonly clock: {
    readonly every: (ms: number, fn: () => void) => { cancel: () => void };
  };
}

/** 한 훅. `next(e)`는 나머지 플러그인과 엔진 자신의 동작으로 이어진다. */
type Hook<E, R> = ($: Engine, e: E, next: (event: E) => Promise<R> | R) => Promise<R> | R;

/**
 * `turn.step`만 스트리밍이다. 훅은 async generator여야 하고, `yield* next(e)`가 아래 스트림을
 * 흘려보내면서 그 단계의 결과로 평가된다. 일반 함수로 걸면 모듈이 실리지 않는다.
 */
type StreamHook<E, R> = ($: Engine, e: E, next: (event: E) => AsyncGenerator<unknown, R>) => AsyncGenerator<unknown, R>;

interface On {
  <E, R>(pattern: "turn.step", hook: StreamHook<E, R>): { readonly catch: (handler: StreamHook<E, R>) => void };
  <E, R>(pattern: string, hook: Hook<E, R>): { readonly catch: (handler: Hook<E, R>) => void };
  <E, R>(pattern: string, matcher: object, hook: Hook<E, R>): { readonly catch: (handler: Hook<E, R>) => void };
}

type Register = (on: On, options?: unknown) => unknown;

/** 세션에 올릴 정체성 하나. */
interface AgentSpec {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly effort?: string;
}

interface AgentSpecs {
  /** 모든 정체성이 공유하는 실행 프롬프트. */
  readonly prompt: string;
  readonly agents: readonly AgentSpec[];
}

const NO_SPECS: AgentSpecs = { prompt: "", agents: [] };

/**
 * 이 세션이 올릴 정체성을 Console에 묻는다. 실패는 전부 빈 명세로 접는다 — 정체성을 못
 * 올리는 것은 세션을 못 여는 것과 다르고, 무엇이 왜 비었는지는 호출부가 로그로 남긴다.
 */
async function fetchAgentSpecs($: Engine): Promise<AgentSpecs> {
  const base = await $.env.get("FLEET_MOD_BASE_URL");
  const token = await $.env.get("FLEET_MOD_TOKEN");
  if (!base || !token) return NO_SPECS;
  const response = await $.http.fetch(`${base.replace(/\/+$/, "")}/v1/fleet/agents`, {
    headers: { "x-fleet-mod-token": token },
  });
  if (!response.ok) throw new Error(`identities unavailable (${response.status})`);
  const parsed: unknown = JSON.parse(response.text);
  if (parsed === null || typeof parsed !== "object") return NO_SPECS;
  const specs = parsed as AgentSpecs;
  return Array.isArray(specs.agents) ? specs : NO_SPECS;
}

const PANE_ID = "fleet-routing";
const PANE_TITLE = "Fleet Routing";
const COMMAND_NAME = "fleet-routing";
/** 이 이름들이 오면 세션 모델을 상속한다는 뜻이다. */
const INHERITING_TYPES = new Set(["", "general-purpose", "task", "Explore", "Plan"]);

type RowState = "asked" | "seated" | "running" | "done" | "denied";

/** 게이트웨이 모델 id의 접두사. 이 표식이 붙은 모델만 Fleet이 중계한다. */
const GATEWAY_PREFIX = "claude-gateway--";

/** `claude-gateway--cursor--grok-4.6-fast` → `cursor/grok-4.6-fast`. 게이트웨이가 아니면 그대로. */
function modelLabel(model: string, effort?: string): string {
  if (!model.startsWith(GATEWAY_PREFIX)) return model;
  const scoped = model.slice(GATEWAY_PREFIX.length).replace("--", "/");
  return effort === undefined ? scoped : `${scoped} @${effort}`;
}

interface Row {
  readonly key: string;
  /** Agent 도구 호출인지 Workflow 스테이지인지. */
  readonly surface: "agent" | "workflow";
  /** 호스트가 붙인 짧은 설명. */
  description: string;
  /** 호스트가 부른 이름. 생략했으면 `inherit`. 부른 이름 자체가 없는 실행에서는 비운다. */
  asked?: string;
  /** 실제로 실린 정체성의 사람이 읽는 이름. */
  carried?: string;
  /** 좌석 배정 근거 한 줄. */
  because?: string;
  state: RowState;
  startedAt: number;
  endedAt?: number;
  agentId?: string;
  /** Fleet이 좌석을 준 실행이 아니라 turn 이벤트로 발견한 실행. */
  observed?: true;
}

/** 이 세션에서 본 디스패치. 새 것이 뒤에 붙는다. */
const ledger: Row[] = [];
/** 이 세션에 실제로 올라간 정체성 이름. 등록이 거절되면 여기 들어오지 않는다. */
const registered = new Set<string>();
/** Agent 도구 호출 중 아직 spawn이 오지 않은 것: tool_use_id → 행. */
const awaitingSpawn = new Map<string, Row>();
/** 살아 있는 subagent: agentId → 행. */
const running = new Map<string, Row>();

let paneOpen = false;
let ticker: { cancel: () => void } | undefined;
/** 세션 모델을 타지 않은 디스패치 수. */
let offHost = 0;
/** 세션 모델을 상속한 디스패치 수. */
let onHost = 0;
/** Fleet이 배정하지 않았지만 게이트웨이 모델로 돈 실행 수(워크플로우 스테이지 등). */
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
  // 세션이 준비되면 정체성을 올리고 판을 여는 커맨드를 등록한다. 이 훅은 첫 프롬프트 전에
  // 기다려지므로, 여기서 올린 정체성은 첫 턴의 목록에 들어간다.
  on("session.start", async ($, e, next) => {
    let specs: AgentSpecs = NO_SPECS;
    try {
      specs = await fetchAgentSpecs($);
    } catch (error) {
      $.ui.log(`could not read the exposed identities: ${String(error)}`, { to: "debug" });
    }
    for (const agent of specs.agents) {
      try {
        await $.agent.register({
          name: agent.name,
          description: agent.description,
          prompt: specs.prompt,
          model: agent.model,
          ...(agent.effort === undefined ? {} : { effort: agent.effort }),
        });
        registered.add(`fleet:${agent.name}`);
      } catch (error) {
        // 하나가 거절돼도 나머지는 올린다. 정체성 하나가 빠진 세션이 정체성이 전혀 없는
        // 세션보다 낫고, 무엇이 빠졌는지는 아래 한 줄이 남긴다.
        $.ui.log(`agent.register refused ${agent.name}: ${String(error)}`, { to: "debug" });
      }
    }
    $.ui.log(`registered ${registered.size} of ${specs.agents.length} gateway identities`, { to: "debug" });
    try {
      await $.command.register({
        name: COMMAND_NAME,
        description: "Show how Fleet routed this session's delegated runs",
        immediate: true,
      });
    } catch {
      // 커맨드가 없어도 판은 디스패치에서 뜬다.
    }
    return next(e);
  });

  on("command.run", { command: COMMAND_NAME }, async ($, e, next) => {
    await openPane($, true);
    return { text: summaryLine() };
  });

  // 호스트가 Agent 도구를 집은 순간. spawn보다 먼저 와서, 판이 빈 자리를 먼저 그린다.
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

  // Workflow는 스테이지를 자기 안에서 돌리고, 그 스테이지는 agent.spawn을 지나지 않는다.
  // 여기서는 판을 띄워 두기만 하고, 스테이지 각각은 turn.step이 관측 행으로 받는다.
  on("tool.call", { tool: "Workflow" }, async ($, e, next) => {
    await openPane($);
    redraw($);
    return next(e);
  });

  /**
   * Agent 도구의 디스패치를 기록하는 자리. Workflow 스테이지는 지나지 않는다 — 그쪽은
   * 내장 workflow-subagent로 돌아 아래 turn.step이 관측 행으로 받는다.
   * 어느 분기에서도 반드시 next로 흘려보낸다 — 여기서 답해 버리면 subagent가 시작되지 않는다.
   */
  on("agent.spawn", async ($, e, next) => {
    const row =
      awaitingSpawn.get(e.tool_use_id) ??
      addRow({
        key: `${e.tool_use_id}:${ledger.length}`,
        surface: "workflow",
        description: e.description || "subagent",
        asked: e.subagentType || "inherit",
        state: "asked",
        startedAt: Date.now(),
      });

    row.description = e.description || row.description;
    row.asked = e.fork ? "fork" : e.subagentType || "inherit";

    const reading = read(e.subagentType, e.fork);
    row.state = "seated";
    row.carried = reading.carried;
    row.because = reading.because;
    // 세는 축은 "세션 모델을 탔는가" 하나다. 호스트가 게이트웨이 정체성을 지목했으면
    // 세션 할당을 아낀 것이고, 이름을 대지 않았으면 태운 것이다.
    if (reading.inheritsHost) onHost += 1;
    else offHost += 1;
    $.ui.notice(e.tool_use_id, `Fleet: ${reading.carried} — ${reading.because}`);
    // 사람이 보는 자리는 판이고, 이 줄은 사후 진단용이라 디버그 로그에만 남긴다.
    $.ui.log(`dispatch: asked=${row.asked} carried=${reading.carried}`, { to: "debug" });
    redraw($);

    // 아무것도 바꾸지 않고 흘려보낸다.
    const result = await next(e);

    if (result.deny !== undefined) {
      row.state = "denied";
      row.because = result.deny;
      row.endedAt = Date.now();
    } else {
      row.state = "running";
      if (result.agentId !== undefined) {
        row.agentId = result.agentId;
        running.set(result.agentId, row);
      }
      startTicker($);
    }
    redraw($);
    return result;
  }).catch(($, e, next) => {
    // 좌석 배정이 실패해도 디스패치는 산다. 원본 그대로 흘려보낸다.
    return next(e);
  });

  /**
   * 모델 요청 하나마다 발화한다. `agent.spawn`이 닿지 않는 실행 — 다이나믹 Workflow의
   * 스테이지가 그렇다 — 을 여기서 발견한다. 그 실행은 재배정할 수 없지만, 게이트웨이
   * 모델을 쓴 이상 원장에는 있어야 한다. 원장이 "Fleet이 배정한 것"만 담으면 실제로 무엇이
   * 무엇으로 돌았는지 묻는 사람에게 절반만 답하는 셈이다.
   */
  on("turn.step", async function* ($, e, next) {
    const agentId = e.agentId;
    // agentId가 없으면 메인 루프, 곧 호스트 자신의 턴이다. 위임이 아니므로 세지 않는다.
    if (agentId === undefined) return yield* next(e);
    const known = running.get(agentId);
    if (known !== undefined) {
      // 좌석을 준 실행. 실제로 어느 모델이 답했는지로 이름을 확정한다.
      if (known.observed === undefined && e.model.startsWith(GATEWAY_PREFIX)) {
        known.carried = modelLabel(e.model, e.effort);
      }
      return yield* next(e);
    }
    // 모델 id 철자로 기록 여부를 가르지 않는다. 게이트웨이 표식이 붙는지는 표시 형식의
    // 문제일 뿐이고, 그 추측에 기록을 걸면 철자가 어긋나는 순간 실행이 조용히 사라진다.
    // 위임된 실행(agentId가 있는 루프)은 무엇으로 돌든 원장에 남는다.
    const row = addRow({
      key: `turn:${agentId}`,
      surface: "workflow",
      // 워크플로우 스테이지가 대부분이지만 엔진 자신의 fork(압축·메모리)도 같은 모양으로
      // 온다. 구별할 방법이 없으므로 아는 것만 적는다 — 이 루프의 주소.
      description: `run ${agentId.slice(0, 6)}`,
      carried: modelLabel(e.model, e.effort),
      because: "its caller chose this model",
      state: "running",
      startedAt: Date.now(),
      agentId,
      observed: true,
    });
    running.set(agentId, row);
    observed += 1;
    startTicker($);
    void openPane($);
    redraw($);
    return yield* next(e);
  });

  // subagent가 끝나면 그 행을 닫는다.
  on("turn.complete", ($, e, next) => {
    const row = e.agentId === undefined ? undefined : running.get(e.agentId);
    if (row) {
      row.state = "done";
      row.endedAt = Date.now();
      // 마지막 응답의 모델이 실제로 무엇이었는지가 여기서 확정된다.
      const model = e.usage?.model;
      if (model !== undefined) row.carried = modelLabel(model);
      running.delete(e.agentId as string);
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

interface Reading {
  /** 이 실행이 무엇으로 돌았는지, 사람이 읽는 이름. */
  readonly carried: string;
  /** 왜 그것이 됐는지 한 줄. */
  readonly because: string;
  /** 세션 자신의 모델을 물려받았는가. */
  readonly inheritsHost: boolean;
}

/**
 * 디스패치 하나를 읽는다. **아무것도 바꾸지 않는다** — 어느 모델로 보낼지는 호스트가
 * 로스터를 읽고 정하고, 이 모듈은 그 결정이 무엇이었는지만 기록한다.
 *
 * 한때는 여기서 좌석표를 보고 `subagentType`을 갈아 끼웠다. 그 방식은 호스트의 판단을
 * 대신하면서도 세션 시작에 고정된 표만 볼 수 있어, 쿼터가 움직이는 축을 놓쳤다.
 */
function read(subagentType: string, fork: boolean): Reading {
  if (fork) {
    return {
      carried: "session model",
      because: "a fork inherits the parent's context and model",
      inheritsHost: true,
    };
  }
  if (subagentType.startsWith("fleet:")) {
    const name = subagentType.slice("fleet:".length);
    return {
      carried: name,
      because: registered.has(subagentType) ? "named by the host" : "named by the host, but not registered this session",
      inheritsHost: false,
    };
  }
  if (INHERITING_TYPES.has(subagentType)) {
    return {
      carried: "session model",
      because: "no identity named, so the session's own model runs it",
      inheritsHost: true,
    };
  }
  return {
    carried: `${subagentType} (own definition)`,
    because: "this agent's definition chooses its model",
    inheritsHost: false,
  };
}

function summaryLine(): string {
  if (ledger.length === 0) return "No delegated run yet this session.";
  const runs = `${ledger.length} ${ledger.length === 1 ? "run" : "runs"}`;
  // "세션 모델을 피했다"가 아니라 "상속했는가"가 세는 축이다. 세션 자신이 게이트웨이 모델로
  // 도는 경우 좌석이 같은 모델을 고를 수도 있어서, 전자로 적으면 거짓이 된다.
  // 관측만 한 실행은 따로 센다. 좌석을 준 실행과 같은 칸에 넣으면 Fleet이 라우팅한 범위를
  // 실제보다 넓게 읽히게 한다.
  const parts: string[] = [];
  if (offHost + onHost > 0) parts.push(`${offHost} named, ${onHost} inherited`);
  if (observed > 0) parts.push(`${observed} not from the Agent tool`);
  const tally = parts.length === 0 ? "reading" : parts.join(" · ");
  return `${runs} · ${tally} · ${registered.size} identities`;
}

/**
 * 판을 연다.
 *
 * `asked`는 사람이 직접 부른 열기다. 엔진은 요청 없는 열기를 144칸 미만에서 자리 잡지 않고
 * 보류하지만 요청된 열기는 110칸까지 받아 주고, 그 판정을 **열 때마다 새로** 한다. 그래서
 * 모듈 플래그로 두 번째 열기를 건너뛰면 좁은 터미널에서 판이 영원히 안 나온다 — 첫 자동
 * 열기가 플래그만 세우고 그려지지는 않은 채로 끝나기 때문이다.
 *
 * 자동 경로도 플래그가 아니라 엔진의 기록(`isPlaced`)을 믿는다. 모듈이 다시 실렸거나 창이
 * 넓어진 뒤라면 다시 열어야 자리를 잡는다.
 */
async function openPane($: Engine, asked = false): Promise<void> {
  if (!asked && paneOpen && (await isPlaced($))) return;
  try {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, rows: 12 });
    paneOpen = true;
  } catch {
    // 판이 열리지 않아도 알림줄은 남는다.
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
  // 프롬프트 아래 고정 줄을 엔진은 경고 표식과 함께 그린다. 그러니 경고할 일이 있을 때만
  // 건다 — 중립적인 사실에 붙은 경고 표식은 읽는 사람을 잘못 이끈다. 세션 모델을 물려받은
  // 위임이 생겼을 때가 그 한 경우다.
  $.ui.status(onHost === 0 ? undefined : `fleet: ${onHost} of ${offHost + onHost} inherited the session model`);
  if (paneOpen) $.ui.invalidate("ui.render");
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
  // 상태 글리프·여백·시간을 뺀 나머지를 요청과 정체성이 나눠 쓴다.
  const timeWidth = 6;
  const nameWidth = Math.max(10, Math.min(28, Math.floor((width - timeWidth - 4) * 0.42)));
  const carriedWidth = Math.max(10, width - timeWidth - nameWidth - 6);

  if (ledger.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No delegated run yet.</Text>
        <Text dimColor>Fleet seats each run when one starts.</Text>
      </Box>
    );
  }

  const rows = ledger.slice(-12);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{pad("WHAT", nameWidth + 2)}</Text>
        <Text bold>{pad("CARRIED BY", carriedWidth)}</Text>
        <Text bold>{pad("", timeWidth)}</Text>
      </Box>
      {rows.map((row) => (
        <Box flexDirection="column" key={row.key}>
          <Box>
            <Text color={COLOR[row.state]}>{`${GLYPH[row.state]} `}</Text>
            <Text>{pad(clip(row.description, nameWidth), nameWidth)}</Text>
            <Text dimColor>{"  "}</Text>
            <Text color={row.carried === "session model" ? "yellow" : undefined} dimColor={row.state === "done"}>
              {pad(clip(row.carried ?? "seating…", carriedWidth), carriedWidth)}
            </Text>
            <Text dimColor>{padStart(elapsed(row, now), timeWidth)}</Text>
          </Box>
          {row.because === undefined ? null : (
            <Box>
              <Text dimColor>
                {`  ${clip(row.asked === undefined ? row.because : `${row.asked} → ${row.because}`, width - 4)}`}
              </Text>
            </Box>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{clip(summaryLine(), width - 2)}</Text>
      </Box>
    </Box>
  );
}

function clip(text: string, width: number): string {
  if (width <= 1) return "";
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}
