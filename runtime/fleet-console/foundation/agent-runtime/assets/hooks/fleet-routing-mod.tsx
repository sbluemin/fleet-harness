/**
 * fleet-routing-mod — 게이트웨이 좌석 배정을 코드로 수행하고 그 과정을 보여주는 Claude Code Mod.
 *
 * 이 모듈은 호스트 프롬프트가 설득으로만 쥐고 있던 두 가지를 가져온다.
 *
 *   1. 배정. 호스트는 역할 이름(`fleet:recon`)만 고르고, 어느 모델이 그 역할을 태울지는
 *      런치 시점에 확정된 좌석표가 정한다. 이름을 고르지 않은 디스패치 — Agent 도구의
 *      `subagent_type` 생략, Workflow 스테이지의 `agentType` 생략 — 는 세션 모델을 상속하는데,
 *      그 경로를 기본 좌석으로 끌어온다. 상속은 호스트가 도는 allowance를 한 번 더 태우면서
 *      로스터가 줄 수 있는 것을 아무것도 가져오지 않는다.
 *
 *   2. 해명. 배정이 코드가 되면 "무엇이 무엇을 태웠는가"를 모델에게 물어볼 필요가 없다.
 *      `Fleet Routing` 판이 디스패치마다 요청·좌석·모델·상태를 그대로 적는다.
 *
 * 좌석표는 스냅숏 조립 때 주입된다(SEAT_TABLE_JSON). 주입이 없거나 깨지면 좌석이 비고,
 * 모듈은 아무것도 재배정하지 않은 채 관측만 한다 — 판은 그대로 뜨므로, 라우팅이 꺼져 있다는
 * 사실 자체가 화면에 남는다.
 *
 * 재작성 규칙은 추론하지 않는다. prompt나 description에서 역할을 유추하는 순간 결정론이
 * 깨지고, 철자를 파서로 판정하다 멀쩡한 디스패치를 막던 옛 게이트의 실패로 돌아간다.
 * 여기서 하는 일은 레지스트리 조회와 표 참조뿐이다.
 */
import type { ElementTable, EngineInterface, Register } from "claude-code";

/** 한 좌석: 역할 하나와 그 역할을 태울 정체성. */
interface Seat {
  /** 호스트가 부르는 역할 이름의 스코프 없는 부분(`recon`). */
  readonly role: string;
  /** 디스패치에 실제로 실릴 등록된 Agent 이름(`fleet:cursor-grok-4-6-fast-medium`). */
  readonly agentType: string;
  /** 판에 적을 사람이 읽는 이름(`cursor/grok-4.6-fast @medium`). */
  readonly label: string;
  /** 이름이 등록되지 않았을 때 쓰는 모델 id. 강도는 따라오지 않는다. */
  readonly modelId: string;
  /** 이 좌석이 그 역할을 얻은 이유 한 줄. */
  readonly because: string;
}

interface SeatTable {
  /** 좌석표를 만든 로스터의 revision. 판의 각주로만 쓴다. */
  readonly revision: string;
  /** 역할 이름 → 좌석. */
  readonly seats: Readonly<Record<string, Seat>>;
  /** 이름 없는 디스패치가 앉을 좌석의 역할 이름. 없으면 상속을 막지 않는다. */
  readonly inherited?: string;
}

const EMPTY_SEATS: SeatTable = { revision: "unseated", seats: {} };

/** 스냅숏 조립이 이 문자열 리터럴을 세션의 좌석표 JSON으로 바꾼다. */
const SEAT_TABLE_JSON = "@@FLEET_SEATS@@";

const SEAT_TABLE: SeatTable = readSeatTable();

function readSeatTable(): SeatTable {
  try {
    const parsed: unknown = JSON.parse(SEAT_TABLE_JSON);
    if (parsed === null || typeof parsed !== "object") return EMPTY_SEATS;
    const table = parsed as SeatTable;
    return table.seats && typeof table.seats === "object" ? table : EMPTY_SEATS;
  } catch {
    // 주입 전 자산 그대로거나 좌석표가 깨졌다. 재배정 없이 관측만 한다.
    return EMPTY_SEATS;
  }
}

const PANE_ID = "fleet-routing";
const PANE_TITLE = "Fleet Routing";
const COMMAND_NAME = "fleet-routing";
/** 이 이름들이 오면 세션 모델을 상속한다는 뜻이다. */
const INHERITING_TYPES = new Set(["", "general-purpose", "task", "Explore", "Plan"]);

type RowState = "asked" | "seated" | "running" | "done" | "denied";

interface Row {
  readonly key: string;
  /** Agent 도구 호출인지 Workflow 스테이지인지. */
  readonly surface: "agent" | "workflow";
  /** 호스트가 붙인 짧은 설명. */
  description: string;
  /** 호스트가 부른 이름. 생략했으면 `inherit`. */
  asked: string;
  /** 실제로 실린 정체성의 사람이 읽는 이름. */
  carried?: string;
  /** 좌석 배정 근거 한 줄. */
  because?: string;
  state: RowState;
  startedAt: number;
  endedAt?: number;
  agentId?: string;
}

/** 이 세션에서 본 디스패치. 새 것이 뒤에 붙는다. */
const ledger: Row[] = [];
/** `agent.offer`가 실제로 내준 이름들. 재배정 대상은 여기 있는 것만 고른다. */
const offered = new Set<string>();
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

/**
 * 한 디스패치의 좌석을 고른다. 추론은 없다 — 호스트가 부른 이름을 표에서 찾거나,
 * 아무 이름도 부르지 않았으면 상속 좌석을 쓴다.
 */
function seatFor(subagentType: string): Seat | undefined {
  const seats = SEAT_TABLE.seats;
  const bare = subagentType.startsWith("fleet:") ? subagentType.slice("fleet:".length) : subagentType;
  const named = seats[bare];
  if (named) return named;
  if (!INHERITING_TYPES.has(subagentType)) return undefined;
  const fallback = SEAT_TABLE.inherited;
  return fallback === undefined ? undefined : seats[fallback];
}

export const register: Register = (on) => {
  // 세션이 준비되면 판을 여는 커맨드를 올린다. 판 자체는 첫 디스패치에 뜬다.
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
    await openPane($);
    return { text: summaryLine() };
  });

  // 내준 이름을 적어 둔다. 재배정은 여기 있는 이름으로만 한다 —
  // 이 호출이 디스패치할 수 없는 이름을 돌려주면 엔진이 spawn 자체를 거절한다.
  on("agent.offer", ($, e, next) => {
    offered.add(e.agent);
    return next(e);
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

  // Workflow는 스테이지를 자기 안에서 돌린다. 접수증이 돌아온 순간을 한 줄로 남기고,
  // 스테이지 각각은 아래 agent.spawn이 자기 행으로 받는다.
  on("tool.call", { tool: "Workflow" }, async ($, e, next) => {
    await openPane($);
    redraw($);
    return next(e);
  });

  /**
   * 라우팅이 실제로 일어나는 자리. Agent 도구와 Workflow 스테이지가 모두 이 문을 지난다.
   * 어느 분기에서도 반드시 next로 흘려보낸다 — 여기서 답해 버리면 subagent가 시작되지 않는다.
   */
  on("agent.spawn", async ($, e, next) => {
    const row =
      awaitingSpawn.get(e.tool_use_id) ??
      addRow({
        key: `${e.tool_use_id}:${ledger.length}`,
        surface: "workflow",
        description: e.description || "workflow stage",
        asked: e.subagentType || "inherit",
        state: "asked",
        startedAt: Date.now(),
      });

    row.description = e.description || row.description;
    row.asked = e.fork ? "fork" : e.subagentType || "inherit";

    const decision = decide(e.subagentType, e.fork);
    row.state = "seated";
    row.carried = decision.carried;
    row.because = decision.because;
    // 호스트가 직접 고른 게이트웨이 정체성도 세션 모델을 아낀 디스패치다.
    // 재배정 여부가 아니라 "세션 모델을 탔는가"가 집계의 축이다.
    if (decision.inheritsHost) onHost += 1;
    else offHost += 1;
    $.ui.notice(e.tool_use_id, `Fleet: ${decision.carried} — ${decision.because}`);
    // 결정을 디버그 로그에만 남긴다. 사람이 보는 자리는 판이고, 이 줄은 사후 진단용이라
    // 트랜스크립트(기본 목적지)에 실으면 디스패치마다 한 줄씩 대화를 어지럽힌다.
    $.ui.log(
      `seat: asked=${row.asked} carried=${decision.carried} retyped=${decision.retyped}` +
        ` subagentType=${decision.input?.subagentType ?? "(kept)"} model=${decision.input?.model ?? "(kept)"}`,
      { to: "debug" },
    );
    redraw($);

    const result = await next(decision.input === undefined ? e : { ...e, ...decision.input });

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

  // subagent가 끝나면 그 행을 닫는다.
  on("turn.complete", ($, e, next) => {
    const row = e.agentId === undefined ? undefined : running.get(e.agentId);
    if (row) {
      row.state = "done";
      row.endedAt = Date.now();
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
  /** next에 실을 덮어쓸 필드. 없으면 원본 그대로. */
  readonly input?: { subagentType?: string; model?: string };
  readonly carried: string;
  readonly because: string;
  readonly retyped: boolean;
  readonly inheritsHost: boolean;
}

function decide(subagentType: string, fork: boolean): Decision {
  if (fork) {
    return {
      carried: "session model",
      because: "a fork inherits the parent's context and model",
      retyped: false,
      inheritsHost: true,
    };
  }
  if (subagentType.startsWith("fleet:") && SEAT_TABLE.seats[subagentType.slice("fleet:".length)] === undefined) {
    // 호스트가 구체 정체성을 직접 지목했다. 명시적 선택은 존중한다.
    return {
      carried: subagentType.slice("fleet:".length),
      because: "named by the host",
      retyped: false,
      inheritsHost: false,
    };
  }
  const seat = seatFor(subagentType);
  if (seat === undefined) {
    const because =
      Object.keys(SEAT_TABLE.seats).length === 0
        ? "no seat table in this snapshot"
        : "no seat for this name";
    // 좌석이 없는 이름 중 상속 경로만 세션 모델로 간다. 그 외에는 그 에이전트가
    // 자기 정의의 모델로 도는 것이므로, 세션 모델이라고 적으면 거짓이 된다.
    const inheritsHost = INHERITING_TYPES.has(subagentType);
    return {
      carried: inheritsHost ? "session model" : `${subagentType} (own definition)`,
      because,
      retyped: false,
      inheritsHost,
    };
  }
  if (offered.has(seat.agentType)) {
    return {
      input: { subagentType: seat.agentType, model: undefined },
      carried: seat.label,
      because: `${seat.role} · ${seat.because}`,
      retyped: true,
      inheritsHost: false,
    };
  }
  // 이름이 이 세션에 등록되지 않았다. 모델만 실어 보낸다 — 강도는 따라오지 않는다.
  return {
    input: { model: seat.modelId },
    carried: `${seat.label} (model only)`,
    because: `${seat.role} · name not registered this session`,
    retyped: true,
    inheritsHost: false,
  };
}

function summaryLine(): string {
  if (ledger.length === 0) return "No delegated run yet this session.";
  const decided = offHost + onHost;
  const runs = `${ledger.length} ${ledger.length === 1 ? "run" : "runs"}`;
  const kept = decided === 0 ? "seating" : `${offHost} of ${decided} kept off the session model`;
  return `${runs} · ${kept} · seats from roster ${SEAT_TABLE.revision}`;
}

async function openPane($: EngineInterface): Promise<void> {
  if (paneOpen) return;
  try {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, rows: 12 });
    paneOpen = true;
  } catch {
    // 판이 열리지 않아도 알림줄과 상태줄은 남는다.
  }
}

function redraw($: EngineInterface): void {
  $.ui.status(ledger.length === 0 ? undefined : summaryLine());
  if (paneOpen) $.ui.invalidate("ui.render");
}

function startTicker($: EngineInterface): void {
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

function drawPane(t: ElementTable, bodyColumns: number): unknown {
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
              <Text dimColor>{`  ${clip(`${row.asked} → ${row.because}`, width - 4)}`}</Text>
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
