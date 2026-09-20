/**
 * fleet-routing-mod — 위임을 게이트웨이 모델로 배정하고, 무엇이 무엇으로 돌았는지 보여주는
 * Claude Code Mod.
 *
 * 두 가지 일을 한다.
 *
 *   1. 배정. 서브에이전트가 시작되기 직전(`agent.spawn`)에 그 실행의 모델을 정해 실어 준다.
 *      Agent 도구가 모델을 Claude 별칭으로만 받기 때문에 한때는 모델마다 Agent 정체성을
 *      등록하고 호스트가 그 이름을 부르게 했다. 그 방식은 호스트의 협조에 기댔고 — 이름을
 *      부르지 않으면 조용히 세션 모델을 상속했다 — 등록이 세션 시작에 고정돼 설정 변경이
 *      재시작 전까지 먹지 않았다. 지금은 호스트가 이름을 대지 않는다. 스폰 레코드의 `model`을
 *      직접 바꾸므로 도구의 enum과 무관하고, 후보는 배정할 때마다 Console에 묻는다.
 *
 *   2. 원장. 배정 하나하나를 `Fleet Routing` 판에 적는다. 판이 없으면 "무엇으로 돌았는가"를
 *      물어볼 방법이 모델에게 묻는 것밖에 없다.
 *
 * 주소와 자격은 런치가 환경변수로 넘긴다(FLEET_MOD_BASE_URL·FLEET_MOD_TOKEN). 둘이 없거나
 * 조회가 실패하면 아무것도 재작성하지 않고 관측만 한다 — 게이트웨이 없이 뜬 세션이 그 경우다.
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

/**
 * `agent.spawn`이 싣는 것 중 배정에 쓰는 것들. `model`·`subagentType`·`prompt`는 재작성할 수
 * 있고 `fork`·`provider`·`parentModel`은 스폰의 정체성이라 고정이다.
 */
interface SpawnInput {
  readonly tool_use_id: string;
  readonly description: string;
  readonly subagentType: string;
  readonly fork: boolean;
  readonly model?: string;
  readonly parentModel: string;
  /** 이 agent를 누가 제공하는가. 내장은 `{ plugin: "engine" }`. */
  readonly provider?: { readonly plugin: string };
}

/** 위임의 등급. 호스트가 적은 모델 별칭과 agent 종류에서 읽어 낸다. */
type Tier = "scan" | "work" | "deep";

/** 한 등급의 후보 하나. 앞에 있을수록 먼저 시도한다. */
interface Candidate {
  readonly model: string;
  readonly label: string;
}

interface RoutingTable {
  readonly prompt: string;
  readonly tiers: Readonly<Record<Tier, readonly Candidate[]>>;
}

const NO_TABLE: RoutingTable = { prompt: "", tiers: { scan: [], work: [], deep: [] } };

/**
 * 지금의 후보를 Console에 묻는다. **배정할 때마다** 묻는다 — 세션 시작에 한 번 읽어 두면
 * 그 순간의 노출에 갇혀서, 설정에서 모델을 켜거나 끈 변화가 CLI를 다시 띄우기 전에는 먹지
 * 않는다. 위임은 드물게 일어나고 주소는 같은 기계의 Console이라, 매번 묻는 값이 그 정확함보다
 * 싸지 않다.
 *
 * 실패는 전부 빈 표로 접는다. 후보를 못 읽는 것과 위임을 못 하는 것은 다르다 — 빈 표를 받은
 * 배정은 아무것도 바꾸지 않고 원래대로 흘려보낸다.
 */
async function fetchRoutingTable($: Engine): Promise<RoutingTable> {
  const base = await $.env.get("FLEET_MOD_BASE_URL");
  const token = await $.env.get("FLEET_MOD_TOKEN");
  if (!base || !token) return NO_TABLE;
  const response = await $.http.fetch(`${base.replace(/\/+$/, "")}/v1/fleet/routing`, {
    headers: { "x-fleet-mod-token": token },
  });
  if (!response.ok) throw new Error(`routing table unavailable (${response.status})`);
  const parsed: unknown = JSON.parse(response.text);
  if (parsed === null || typeof parsed !== "object") return NO_TABLE;
  const table = parsed as RoutingTable;
  if (table.tiers === null || typeof table.tiers !== "object") return NO_TABLE;
  for (const tier of ["scan", "work", "deep"] as const) {
    if (!Array.isArray(table.tiers[tier])) return NO_TABLE;
  }
  return table;
}

/**
 * 호스트가 보낸 것을 등급으로 읽는다.
 *
 * `model`은 **목적지가 아니라 등급 신호다.** Agent 도구가 말할 수 있는 모델은 Claude 별칭뿐이라
 * 목적지로 읽으면 어차피 전부 세션 계열로 간다. 호스트가 `haiku`라고 적은 것은 "Haiku를 써라"가
 * 아니라 "싼 것으로 충분하다"는 판단이고, 그 판단은 유효하다 — 어느 모델이 그 등급인지만
 * 호스트가 모를 뿐이다.
 *
 * 이름을 아예 대지 않은 경우(실측상 대부분)가 곧 상속이고, 없애려는 것이 그것이다.
 */
function tierOf(model: string | undefined, subagentType: string): Tier {
  const alias = (model ?? "").toLowerCase();
  if (alias.includes("haiku")) return "scan";
  if (alias.includes("opus") || alias.includes("fable")) return "deep";
  if (alias.includes("sonnet")) return "work";
  // 읽기 전용으로 넓게 훑는 실행. 긴 컨텍스트를 쓰고 추론 깊이는 덜 쓴다고 스스로 말한다.
  if (subagentType === "Explore") return "scan";
  return "work";
}

const PANE_ID = "fleet-routing";
const PANE_TITLE = "Fleet Routing";
const COMMAND_NAME = "fleet-routing";
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
/**
 * 이 세션에서 배정했다가 실패한 모델. 다음 배정은 건너뛴다 — 후보가 목록인 이유가 이것이고,
 * "지금 쓸 수 있는 첫 번째"의 `지금`을 이 집합이 판정한다.
 */
const unreachable = new Set<string>();
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
  // 세션이 준비되면 판을 여는 커맨드를 등록한다. 후보 조회는 여기서 하지 않는다 — 세션
  // 시작에 읽어 두면 그 순간의 노출에 갇히고, 그 고정이 바로 등록 방식의 결함이었다.
  on("session.start", async ($, e, next) => {
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
   * 위임 하나의 모델이 정해지는 자리. 스폰 레코드의 `model`은 Agent 도구의 파라미터와 달리
   * 열린 문자열이라, 여기서 게이트웨이 모델 id를 직접 실어 줄 수 있다 — 도구의 enum은
   * 호스트가 적을 수 있는 철자만 제한하지 실제로 무엇이 도는지를 정하지 않는다.
   *
   * 어느 분기에서도 반드시 next로 흘려보낸다 — 여기서 답해 버리면 subagent가 시작되지 않는다.
   * Workflow 스테이지는 이 훅을 지나지 않는다(측정: 스테이지 4개에 스폰 0건). 그쪽은 내장
   * workflow-subagent로 돌아 아래 turn.step이 관측 행으로 받는다.
   */
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

    const decision = await decide($, e);
    row.state = "seated";
    row.carried = decision.carried;
    row.because = decision.because;
    if (decision.model === undefined) onHost += 1;
    else offHost += 1;
    $.ui.notice(e.tool_use_id, `Fleet: ${decision.carried} — ${decision.because}`);
    // 사람이 보는 자리는 판이고, 이 줄은 사후 진단용이라 디버그 로그에만 남긴다.
    $.ui.log(
      `dispatch: asked=${e.model ?? "(none)"}/${row.asked} tier=${decision.tier} carried=${decision.carried}`,
      { to: "debug" },
    );
    redraw($);

    const result = await next(decision.model === undefined ? e : { ...e, model: decision.model });

    if (result.deny !== undefined) {
      row.state = "denied";
      row.because = result.deny;
      row.endedAt = Date.now();
      // 배정한 모델이 거절됐다면 그 모델은 이 세션에서 닿지 않는다. 다음 위임은 다음 후보로
      // 간다 — 같은 막힌 모델을 계속 고르면 후보가 목록인 의미가 없다.
      if (decision.model !== undefined) unreachable.add(decision.model);
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
    // 배정이 실패해도 디스패치는 산다. 원본 그대로 흘려보낸다.
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

interface Decision {
  /** 실어 줄 모델 id. `undefined`면 아무것도 바꾸지 않는다. */
  readonly model?: string;
  /** 읽은 등급. 배정하지 않은 실행에서는 그 이유가 등급 자리에 온다. */
  readonly tier: string;
  /** 이 실행이 무엇으로 도는지, 사람이 읽는 이름. */
  readonly carried: string;
  /** 왜 그것이 됐는지 한 줄. */
  readonly because: string;
}

/** 아무것도 바꾸지 않는 판정. 세션 모델을 그대로 탄다. */
function passThrough(tier: string, because: string): Decision {
  return { tier, carried: "session model", because };
}

/**
 * 디스패치 하나를 어느 모델로 보낼지 정한다.
 *
 * 손대지 않는 세 가지를 먼저 걸러낸다. fork는 부모의 문맥과 모델을 물려받고 `model`이 아예
 * 무시된다. 다른 플러그인이 등록한 agent는 그 정의가 모델을 소유하므로 남의 결정을 덮지
 * 않는다. 이미 게이트웨이 모델이 실려 있으면 누군가 이미 정한 것이다.
 */
async function decide($: Engine, e: SpawnInput): Promise<Decision> {
  if (e.fork) return passThrough("fork", "a fork inherits the parent's context and model");
  if (e.provider !== undefined && e.provider.plugin !== "engine") {
    return { tier: "foreign", carried: `${e.subagentType} (own definition)`, because: "this agent's definition chooses its model" };
  }
  if (e.model !== undefined && e.model.startsWith(GATEWAY_PREFIX)) {
    return { model: e.model, tier: "pinned", carried: modelLabel(e.model), because: "already carried a gateway model" };
  }

  let table: RoutingTable = NO_TABLE;
  try {
    table = await fetchRoutingTable($);
  } catch (error) {
    $.ui.log(`could not read the routing table: ${String(error)}`, { to: "debug" });
    return passThrough("unread", "the routing table could not be read");
  }

  const tier = tierOf(e.model, e.subagentType);
  const candidates = table.tiers[tier] ?? [];
  const seat = candidates.find((candidate) => !unreachable.has(candidate.model));
  if (seat === undefined) {
    // 후보가 아예 없다는 것은 위임 모델이 노출되지 않았다는 뜻이다. 사용자가 모델을 전부
    // 호스트 전용으로 뒀다면 "위임은 내장 모델로 하라"는 명시적 선택이고, 뒤집지 않는다.
    return passThrough(tier, candidates.length === 0 ? "no gateway model is exposed for delegation" : "every candidate is unreachable this session");
  }
  return {
    model: seat.model,
    tier,
    carried: seat.label,
    because: `${describeAsk(e.model, e.subagentType)} → ${tier}`,
  };
}

/** 호스트가 실제로 무엇을 말했는지, 판에 적을 만큼 짧게. */
function describeAsk(model: string | undefined, subagentType: string): string {
  if (model !== undefined) return model;
  return subagentType === "Explore" ? "Explore" : "no model named";
}

function summaryLine(): string {
  if (ledger.length === 0) return "No delegated run yet this session.";
  const runs = `${ledger.length} ${ledger.length === 1 ? "run" : "runs"}`;
  // "세션 모델을 피했다"가 아니라 "상속했는가"가 세는 축이다. 세션 자신이 게이트웨이 모델로
  // 도는 경우 배정이 같은 모델을 고를 수도 있어서, 전자로 적으면 거짓이 된다.
  // 관측만 한 실행은 따로 센다. 배정한 실행과 같은 칸에 넣으면 Fleet이 라우팅한 범위를
  // 실제보다 넓게 읽히게 한다.
  const parts: string[] = [];
  if (offHost + onHost > 0) parts.push(`${offHost} routed, ${onHost} inherited`);
  if (observed > 0) parts.push(`${observed} not from the Agent tool`);
  const tally = parts.length === 0 ? "reading" : parts.join(" · ");
  return `${runs} · ${tally}`;
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
        <Text dimColor>Fleet picks a model when one starts.</Text>
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
