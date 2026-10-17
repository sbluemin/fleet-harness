import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertClaudeGatewayInput } from "./input.js";
import type { ClaudeGatewayInput, ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewaySession } from "./contracts.js";
import { createClaudeExecutionEventDecoder, type ClaudeExecutionEvent, type ClaudeExecutionEventDecoder } from "./execution-events.js";
import type { ClaudeExecutionTurn } from "./execution-loop.js";

/** 상주 루프가 내는 사건 — 실행 사건에 더해, 도는 턴에 건넨 말의 행방. */
export type ClaudeResidentEvent =
  | ClaudeExecutionEvent
  | { readonly kind: "input-started"; readonly id: string }
  | { readonly kind: "input-cancelled"; readonly id: string };

export interface ClaudeResidentLoopOptions {
  /** 홈은 `persistent`여야 한다 — 폐기가 트랜스크립트를 지우면 resume할 것이 없다. */
  readonly createSdk: () => Promise<ClaudeGatewaySdk>;
  /** 자식 하나를 여는 실행 정책. `prompt`·`resume`·`sessionId`는 루프가 쓴다. */
  readonly buildSession: () => ClaudeExecutionTurn | Promise<ClaudeExecutionTurn>;
  /** 이 대화의 좌표 파일(세션 id와 모델). 호출자가 소유한 자리이며 루프만 쓴다. */
  readonly stateFile: string;
  readonly settlement: "result" | "result-required";
  readonly onEvent?: (event: ClaudeResidentEvent) => void;
}

export interface ClaudeResidentLoop {
  /** `start()` 뒤에 읽는다 — 남은 대화를 이어 받아 열릴 것인가. */
  readonly resumed: boolean;
  start(): Promise<void>;
  run(prompt: ClaudeGatewayInput): Promise<void>;
  /** 도는 턴에 말을 건넨다. 도는 턴이 없으면 false. */
  steer(prompt: ClaudeGatewayInput, id: string): boolean;
  cancel(): void;
  dispose(): Promise<void>;
}

interface ResidentState {
  readonly sessionId: string;
  readonly model: string;
}

interface Child {
  readonly session: ClaudeGatewaySession;
  /** 이 자식이 resume으로 열렸고 아직 아무 메시지도 내지 않았다 — 그대로 끝나면 resume이 깨진 것이다. */
  silentResume: boolean;
}

type ResultEvent = Extract<ClaudeExecutionEvent, { kind: "result" }>;

interface Turn {
  /** 이 턴을 실은 자식 — 접힌 자식의 늦은 끝이 다음 자식의 턴을 닫지 않게 짝짓는다. */
  readonly owner: Child;
  readonly decoder: ClaudeExecutionEventDecoder;
  /** 이 턴에 건넸고 아직 집히지 않은 말 — 자식 messageId → 호출자 id. */
  readonly hosted: Map<string, string>;
  /** 건넨 말이 집히기 전에 온 결말 — 그 말까지 같은 턴으로 이은 뒤 합쳐 낸다. */
  held: ResultEvent | null;
  heldTimer: ReturnType<typeof setTimeout> | null;
  settle(result: ResultEvent | null, failure?: unknown): void;
}

/** 건넨 말을 기다리며 결말을 쥐고 있는 상한. 넘기면 쥔 결말로 닫고, 늦게 집힌 말은 턴 밖의 사건으로 흐른다. */
const HELD_RESULT_MS = 60_000;

/**
 * 자식 하나를 턴 사이에도 살려 두는 Claude 실행 루프 — `createClaudeExecutionLoop`의 상주판이다.
 *
 * 턴마다 자식을 세우는 루프는 도는 턴에 말을 넣을 통로가 없고(single-turn 자식은 첫 result에 입력을 닫는다), 세션 id를
 * 메모리에만 들고 있어 프로세스가 바뀌면 대화를 잃는다. 이 루프는 `openSession`의 자식을 살려 두고 `priority:"next"`로
 * 도는 턴에 말을 건네며(`steer`), 세션 id를 좌표 파일에 못박아 다음 인스턴스가 같은 자리에서 resume한다.
 *
 * 좌표는 자식을 띄우기 **전에** 쓴다(채팅이 세션 id를 못박는 방식과 같다) — 띄운 뒤에 쓰면 그 사이에 죽은 프로세스가
 * 트랜스크립트만 남기고 좌표를 잃는다. 모델이 바뀌었거나 트랜스크립트가 없거나 resume이 말 한마디 없이 끝나면 새 대화로 연다.
 * 중지는 자식을 접는 것이다 — 다음 턴이 같은 대화를 다시 resume하므로 중지 결말을 따로 정산할 것이 없다.
 */
export function createClaudeResidentLoop(options: ClaudeResidentLoopOptions): ClaudeResidentLoop {
  let sdk: ClaudeGatewaySdk | null = null;
  let startFlight: Promise<void> | null = null;
  let disposed = false;
  let model = "";
  let state: ResidentState | null = null;
  let resumed = false;
  /** 마지막 resume이 깨졌다 — 다음 자식은 새 대화로 연다. */
  let resumeBroken = false;
  let child: Child | null = null;
  let opening: Promise<Child> | null = null;
  let current: Turn | null = null;
  let queueTail: Promise<void> = Promise.resolve();
  // 자식이 낸 result의 비용은 그 자식의 누적이다 — 턴의 몫은 직전 누적과의 차이다. 자식이 바뀌면 0부터 다시 센다.
  let childCost = 0;
  // 턴 밖에 흐른 사건(쥔 결말이 상한을 넘은 뒤 늦게 집힌 말)의 짝짓기.
  const strayDecoder = createClaudeExecutionEventDecoder();
  const strayHosted = new Map<string, string>();

  const emit = (event: ClaudeResidentEvent): void => {
    try { options.onEvent?.(event); } catch { /* 관찰자 실패는 자식의 수명을 바꾸지 않는다 */ }
  };

  async function start(): Promise<void> {
    if (disposed) throw new Error("Session disposed");
    startFlight ??= (async () => {
      const created = await options.createSdk();
      if (disposed) { await created.dispose().catch(() => undefined); throw new Error("Session disposed"); }
      sdk = created;
      model = (await options.buildSession()).model;
      state = await readState(options.stateFile);
      resumed = state !== null && state.model === model && await transcriptExists(created.configDir, state.sessionId);
      if (!resumed) state = null;
    })();
    try { await startFlight; }
    catch (error) { if (!disposed) startFlight = null; throw error; }
  }

  async function openChild(): Promise<Child> {
    const owned = sdk;
    if (!owned || disposed) throw new Error("Session disposed");
    const built = await options.buildSession();
    assertLoopOwnedKeysAbsent(built);
    model = built.model;
    const reuse = state !== null && state.model === built.model && !resumeBroken;
    if (!reuse) {
      state = { sessionId: randomUUID(), model: built.model };
      await writeState(options.stateFile, state);
    }
    resumeBroken = false;
    const coordinate = reuse ? { resume: state!.sessionId } : { sessionId: state!.sessionId };
    const session = await owned.openSession({ ...built, ...coordinate });
    if (disposed) { session.close(); throw new Error("Session disposed"); }
    const opened: Child = { session, silentResume: reuse };
    childCost = 0;
    child = opened;
    void read(opened);
    return opened;
  }

  async function ensureChild(): Promise<Child> {
    if (child) return child;
    opening ??= openChild().finally(() => { opening = null; });
    return opening;
  }

  async function read(owner: Child): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const message of owner.session) {
        // 접힌 자식이 늦게 흘린 것은 지금 자식의 턴에 섞지 않는다.
        if (child !== owner) break;
        owner.silentResume = false;
        handle(message);
      }
    } catch (error) { failure = error; }
    // 자식이 끝났다 — 접힌 것(중지·폐기)이든 스스로 죽은 것이든 다음 턴은 새 자식을 띄워 같은 대화를 resume한다.
    if (child === owner) child = null;
    if (owner.silentResume) resumeBroken = true;
    const turn = current;
    if (turn && turn.owner === owner && !disposed) {
      cancelHosted(turn.hosted);
      if (turn.held) turn.settle(turn.held);
      else if (options.settlement === "result-required") turn.settle({ kind: "result", isError: true, source: "incomplete" });
      else turn.settle(null, failure ?? new Error("agent_session_ended"));
    }
  }

  function handle(message: ClaudeGatewayMessage): void {
    if (message.type === "command_lifecycle") { lifecycle(message); return; }
    const turn = current;
    const decoder = turn?.decoder ?? strayDecoder;
    for (const event of decoder.decode(message)) {
      if (event.kind !== "result") { emit(event); continue; }
      const result = perTurnCost(event);
      if (!turn) { emit(result); continue; }
      const merged = turn.held ? mergeResults(turn.held, result) : result;
      if (turn.hosted.size > 0) {
        // 건넨 말이 아직 집히지 않았는데 턴이 닫히려 한다 — 자식은 그 말로 곧 이어 간다. 결말을 쥐고 그것까지 같은 턴으로 잇는다.
        turn.held = merged;
        if (turn.heldTimer === null) {
          turn.heldTimer = setTimeout(() => { for (const [messageId, id] of turn.hosted) strayHosted.set(messageId, id); turn.hosted.clear(); if (turn.held) turn.settle(turn.held); }, HELD_RESULT_MS);
          turn.heldTimer.unref?.();
        }
        continue;
      }
      turn.settle(merged);
    }
  }

  function lifecycle(message: ClaudeGatewayMessage): void {
    const messageId = message["command_uuid"];
    const phase = message["state"];
    if (typeof messageId !== "string" || typeof phase !== "string") return;
    const turn = current;
    const hosted = turn?.hosted.has(messageId) ? turn.hosted : strayHosted.has(messageId) ? strayHosted : null;
    const id = hosted?.get(messageId);
    if (!hosted || id === undefined) return;
    if (phase === "started") {
      hosted.delete(messageId);
      emit({ kind: "input-started", id });
      return;
    }
    if (phase === "cancelled") {
      hosted.delete(messageId);
      emit({ kind: "input-cancelled", id });
      if (turn && hosted === turn.hosted && turn.held && turn.hosted.size === 0) turn.settle(turn.held);
    }
  }

  function perTurnCost(event: ResultEvent): ResultEvent {
    const cost = event.usage?.costUsd;
    if (cost === undefined || !event.usage) return event;
    const share = Math.max(0, cost - childCost);
    childCost = Math.max(childCost, cost);
    return { ...event, usage: { ...event.usage, costUsd: share } };
  }

  function cancelHosted(hosted: Map<string, string>): void {
    for (const id of hosted.values()) emit({ kind: "input-cancelled", id });
    hosted.clear();
  }

  function run(prompt: ClaudeGatewayInput): Promise<void> {
    if (disposed) return Promise.reject(new Error("Session disposed"));
    if (!sdk) return Promise.reject(new Error("Session not started"));
    try { assertClaudeGatewayInput(prompt); }
    catch (error) { return Promise.reject(error); }
    const work = queueTail.then(() => runTurn(prompt));
    queueTail = work.catch(() => undefined);
    return work;
  }

  async function runTurn(prompt: ClaudeGatewayInput): Promise<void> {
    if (disposed) return;
    const owner = await ensureChild();
    if (disposed) return;
    let resolveTurn!: () => void;
    let rejectTurn!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    let pending: ResultEvent | null = null;
    let settled = false;
    const turn: Turn = {
      owner,
      decoder: createClaudeExecutionEventDecoder(),
      hosted: new Map(),
      held: null,
      heldTimer: null,
      settle(result, failure) {
        if (settled) return;
        settled = true;
        if (turn.heldTimer !== null) clearTimeout(turn.heldTimer);
        if (current === turn) current = null;
        if (failure !== undefined) { rejectTurn(failure); return; }
        pending = result;
        resolveTurn();
      },
    };
    current = turn;
    try { owner.session.send(prompt); }
    catch (error) { turn.settle(null, error); }
    await done;
    // 결말 관찰자는 정산 뒤에 부른다 — 관찰자가 던져도 다음 턴이 이 턴의 상태를 물려받지 않는다.
    if (pending !== null && !disposed) options.onEvent?.(pending);
  }

  function steer(prompt: ClaudeGatewayInput, id: string): boolean {
    const turn = current;
    const owner = child;
    if (disposed || !turn || !owner || turn.owner !== owner || turn.held) return false;
    try { assertClaudeGatewayInput(prompt); } catch { return false; }
    const messageId = randomUUID();
    turn.hosted.set(messageId, id);
    try { owner.session.send(prompt, { messageId }); }
    catch { turn.hosted.delete(messageId); return false; }
    return true;
  }

  function cancel(): void {
    const turn = current;
    if (!turn) return;
    // 자식을 접는다. 집히지 않은 말은 모델에 닿지 못했다 — 호출자에게 돌려준다. 다음 턴은 같은 대화를 resume한다.
    const owner = child;
    child = null;
    cancelHosted(turn.hosted);
    turn.settle(null);
    owner?.session.close();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const turn = current;
    if (turn) { cancelHosted(turn.hosted); turn.settle(null); }
    child?.session.close();
    child = null;
    await opening?.then((opened) => { opened.session.close(); }, () => undefined);
    await startFlight?.catch(() => undefined);
    const owned = sdk;
    sdk = null;
    await owned?.dispose().catch(() => undefined);
  }

  return {
    get resumed() { return resumed; },
    start, run, steer, cancel, dispose,
  };
}

/** 남긴 대화를 지운다 — 좌표 파일과 그 홈을 함께. 호출자는 그 대화의 루프를 먼저 폐기한다. */
export async function forgetClaudeResidentState(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function mergeResults(first: ResultEvent, next: ResultEvent): ResultEvent {
  const a = first.usage;
  const b = next.usage;
  const usage = a && b
    ? { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
        ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
        ...(b.contextTokens !== undefined ? { contextTokens: b.contextTokens } : a.contextTokens !== undefined ? { contextTokens: a.contextTokens } : {}) }
    : b ?? a;
  return { ...next, ...(usage ? { usage } : {}) };
}

async function readState(file: string): Promise<ResidentState | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ResidentState>;
    return typeof parsed.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(parsed.sessionId) && typeof parsed.model === "string"
      ? { sessionId: parsed.sessionId, model: parsed.model }
      : null;
  } catch { return null; }
}

async function writeState(file: string, state: ResidentState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.tmp`;
  await writeFile(staging, JSON.stringify(state), { mode: 0o600 });
  await rename(staging, file);
}

/** 그 세션의 트랜스크립트가 홈에 있는가 — Claude Code는 `projects/<cwd 표기>/<id>.jsonl`에 쓴다. 표기 규칙에 기대지 않고 찾는다. */
async function transcriptExists(configDir: string, sessionId: string): Promise<boolean> {
  const projects = path.join(configDir, "projects");
  let entries: string[];
  try { entries = await readdir(projects); } catch { return false; }
  for (const entry of entries) {
    try { if ((await stat(path.join(projects, entry, `${sessionId}.jsonl`))).isFile()) return true; } catch { /* 다음 */ }
  }
  return false;
}

function assertLoopOwnedKeysAbsent(built: ClaudeExecutionTurn): void {
  const record = built as unknown as Record<string, unknown>;
  for (const key of ["prompt", "resume", "sessionId", "forkSession"]) {
    if (Object.hasOwn(record, key)) throw new TypeError(`buildSession must not set ${key}; it is loop-owned.`);
  }
}
