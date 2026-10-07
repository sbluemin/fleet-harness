import type {
  AdapterResponse,
  CanonicalInputItem,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
} from "../../../canonical/index.js";
import { estimateTokens } from "../../../transport/token-estimate.js";
import { wireLog } from "../../../transport/wire-log.js";

/**
 * Cursor 경유 grok-4.7의 "예고 후 종료" 재요청.
 *
 * grok-4.7은 Cursor에서 도구 결과 직후 추론 없이 "이제 X를 확인합니다" 한 줄만 내고 정상 완료하는 일이
 * 있다(2026-10-06 실사용 0.84%). 그 분기는 입력에 거의 결정적으로 묶인다: 같은 입력을 다시 보내면 18회 중
 * 13회 같은 모양으로 끝났고, 예고를 assistant 발화로 넣고 짧은 지시를 붙인 입력은 22/22 추론한 뒤 도구를
 * 불렀다(2026-10-07 실측). 그래서 그 응답은 클라이언트에 내보내기 전에 보류했다가, 그렇게 붙인 입력으로
 * 새 Run을 한 번 연다. 같은 Run에 이어 쓰는 길은 없다: 서버가 `turnEnded` 뒤 0–1ms 안에 스트림을 닫는다.
 *
 * Muse 어댑터에도 같은 회복이 있지만 공유하지 않는다. 재요청 수단(새 HTTP/2 Run)·해제 신호(서버 수행 작업,
 * 마지막 단계가 미래 행동 예고인지)·체크포인트 기준선이 Cursor 의미론이고, 이벤트 모양도 다르다. 이 동작은 canonical 이벤트
 * 수준에서 일어나므로 스트리밍·비스트리밍이 같은 결과를 받는다.
 */

const LABEL = "cursor.resample";

/**
 * 재요청에만 붙는 지시. 클라이언트 기록에는 남지 않는다. Muse 문구와 같은 글자다 — 22/22 회복이 이 문구로
 * 측정됐으므로 바꾸려면 다시 잰다. Cursor에는 developer 역할이 없어 user 메시지로 실린다.
 */
export const CURSOR_RESAMPLE_NUDGE =
  "You announced the next step but ended without calling a tool. Make that tool call now, without writing "
  + "anything first. If the task is actually complete, end without adding anything.";

/** 재요청 입력 끝에 붙는 항목: 첫 응답의 예고와 지시. */
export function cursorResampleNudgeItems(announcement: string): CanonicalInputItem[] {
  return [
    { type: "message", role: "assistant", content: announcement },
    { type: "message", role: "developer", content: CURSOR_RESAMPLE_NUDGE },
  ];
}

/**
 * 재요청을 켜는 wire 모델. 관측과 회복 실측이 있는 grok-4.7 계열(effort·`-fast`·500k 변형)만 둔다.
 * muse-spark-1.3은 Cursor에서 thinkingDelta를 보내지 않아(6/6) "무추론" 판정이 늘 참이 되고, 재발도
 * 0/4였다. 넓히려면 그 모델의 재현과 회복을 먼저 잰다.
 */
const CURSOR_RESAMPLE_WIRE_MODEL = /^grok-4\.7(?:-|$)/;

/** 이보다 작은 출력 상한은 짧은 판정형 부속 호출이다(보안 모니터: 64). */
const MIN_RESAMPLE_MAX_OUTPUT_TOKENS = 1024;

/**
 * 예고인 마지막 단계만 걸러 내는 보조 상한. 길이는 재요청 신호가 아니다. 80은 폐기했다: 2026-10-08 실측에서
 * 36–62토큰의 완료 보고가 다시 받히고, 354토큰 예고는 길이 때문에 놓쳤다. 800은 그 예고보다 넓고
 * 비정상적으로 긴 본문만 걸러 낸다. 재는 대상은 응답 전체가 아니라 마지막 단계다.
 */
const MAX_RESAMPLE_FINAL_STEP_TOKENS = 800;

/** 영어 1인칭 미래·의도. 아포스트로피는 ASCII와 굽은 따옴표 둘 다. */
const ENGLISH_FUTURE_ACTION =
  /\b(?:I['’]ll|I will|Let me|I['’]m going to|I am going to)\b/iu;

/** ㅆ 받침. 겠은 미래·의도이고 있·없은 존재라 과거로 세지 않는다. ㄹ 받침 뒤의 게는 `할게`다. */
const SSANG_SIOT_INDEX = 20;
const RIEUL_INDEX = 8;
const NOT_PAST_SSANG = new Set(["겠", "있", "없"]);

/**
 * 마지막 단계가 아직 하지 않은 행동의 예고일 때만 참이다. 완료·보고(과거, 결과 동사)가 같이 있으면
 * 애매하므로 예고가 아니다. 어느 쪽인지 모르면 다시 받지 않는다.
 */
function isFutureActionAnnouncement(text: string): boolean {
  const step = text.trim();
  if (step.length === 0) return false;
  return hasFutureAction(step) && !hasFinishedReport(step);
}

function hasFutureAction(text: string): boolean {
  if (ENGLISH_FUTURE_ACTION.test(text)) return true;
  if (/확인합니다|실행합니다|겠(?:습니다|어요|다)|려고(?:\s*합니다)?/u.test(text)) return true;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (jongseongIndex(text[index] ?? "") !== RIEUL_INDEX) continue;
    if (text[index + 1] === "게") return true;
  }
  return false;
}

function hasFinishedReport(text: string): boolean {
  if (/\b(?:checked|completed|finished|found|fixed|removed|updated|passed|failed|returned|confirmed|ran)\b/iu.test(text)) {
    return true;
  }
  if (/(?:았|었|였)(?:습니다|다|어요|죠)/u.test(text)) return true;
  for (const char of text) {
    if (jongseongIndex(char) !== SSANG_SIOT_INDEX || NOT_PAST_SSANG.has(char)) continue;
    return true;
  }
  return false;
}

function jongseongIndex(char: string): number | undefined {
  const code = char.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return undefined;
  return (code - 0xac00) % 28;
}

/** 턴을 넘기는 클라이언트 도구 호출. `whenArgumentTrue`가 있으면 그 인자가 `true`일 때만 해당한다. */
export interface CursorYieldToolCall {
  readonly name: string;
  readonly whenArgumentTrue?: string;
}

/** 하네스가 선언한 클라이언트 도구 의미. 도구 이름은 하네스 어휘라 라우터가 하네스별로 넘긴다. */
export interface CursorClientToolScope {
  readonly messagingToolNames?: readonly string[];
  readonly yieldToolCalls?: readonly CursorYieldToolCall[];
}

export type CursorResampleSkip =
  | "model"
  | "no_tools"
  | "small_max"
  | "not_after_tool_output"
  | "after_messaging_tool"
  | "after_yield_tool";

export interface CursorResampleArming {
  readonly armed: boolean;
  readonly skip?: CursorResampleSkip;
  /** 직전 도구 결과들에 대응하는 호출 이름. */
  readonly lastToolNames?: readonly string[];
}

type CanonicalFunctionCallItem = Extract<CanonicalInputItem, { type: "function_call" }>;
type CanonicalFunctionCallOutputItem = Extract<CanonicalInputItem, { type: "function_call_output" }>;

/**
 * 요청을 보내기 전에 정해지는 조건. `results`는 bridge가 이어 붙일 때 쓰는 것과 같은, 요청 끝의 도구 결과
 * 묶음이다. 그 결과들에 대응하는 호출 중 하나라도 보고(메시징)나 턴 넘기기(백그라운드 실행·예약 깨우기)면
 * 다시 받지 않는다: 그 자리의 짧은 텍스트 종료는 정상이고, "도구를 지금 부르라"는 지시는 보고 중복이나
 * 대기 대신 폴링·작업 중복 실행을 부른다. 범위 밖이면 응답을 보류하지 않으므로 지연도 없다.
 */
export function cursorResampleArming(
  request: CanonicalResponseRequest,
  results: readonly CanonicalFunctionCallOutputItem[] | undefined,
  wireModelId: string,
  scope: CursorClientToolScope,
): CursorResampleArming {
  if (!CURSOR_RESAMPLE_WIRE_MODEL.test(wireModelId)) return { armed: false, skip: "model" };
  if ((request.tools ?? []).length === 0 || request.tool_choice === "none") {
    return { armed: false, skip: "no_tools" };
  }
  if (request.max_output_tokens !== undefined && request.max_output_tokens < MIN_RESAMPLE_MAX_OUTPUT_TOKENS) {
    return { armed: false, skip: "small_max" };
  }
  if (results === undefined || results.length === 0) return { armed: false, skip: "not_after_tool_output" };
  const calls = results
    .map((result) => functionCallFor(request.input, result.call_id))
    .filter((call): call is CanonicalFunctionCallItem => call !== undefined);
  const named = calls.length === 0 ? {} : { lastToolNames: calls.map((call) => call.name) };
  const messaging = new Set(scope.messagingToolNames ?? []);
  if (calls.some((call) => messaging.has(call.name))) {
    return { armed: false, skip: "after_messaging_tool", ...named };
  }
  if (calls.some((call) => isYieldCall(call, scope.yieldToolCalls ?? []))) {
    return { armed: false, skip: "after_yield_tool", ...named };
  }
  return { armed: true, ...named };
}

function functionCallFor(
  input: readonly CanonicalInputItem[],
  callId: string,
): CanonicalFunctionCallItem | undefined {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type === "function_call" && item.call_id === callId) return item;
  }
  return undefined;
}

function isYieldCall(call: CanonicalFunctionCallItem, rules: readonly CursorYieldToolCall[]): boolean {
  return rules.some((rule) => {
    if (rule.name !== call.name) return false;
    if (rule.whenArgumentTrue === undefined) return true;
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      return isRecord(parsed) && parsed[rule.whenArgumentTrue] === true;
    } catch {
      return false;
    }
  });
}

/** live Run이 첫 응답 segment에 대해 알려 주는, canonical 이벤트에 나타나지 않는 사실. */
export interface CursorSegmentSignals {
  /** 서버가 이 응답 중 실제로 수행한 작업(승인한 웹 검색 등). 정책상 거절한 native 실행은 아니다. */
  readonly serverWork: boolean;
  /** 마지막 단계(마지막 native 실행 응답 뒤)의 텍스트. */
  readonly finalStepText: string;
}

export interface CursorResampleContext {
  readonly signal?: AbortSignal;
  readonly startedAt: number;
  readonly wireModelId: string;
  /** 첫 응답이 끝난 뒤 그 segment의 신호를 읽는다. */
  readonly firstSignals: () => CursorSegmentSignals;
  /** 예고와 지시를 붙인 요청으로 새 Run을 연다. 열지 못하면 던진다. */
  readonly reopen: (announcement: string) => Promise<AdapterResponse>;
}

type CompletedEvent = Extract<CanonicalResponseEvent, { type: "response.completed" }>;

/**
 * 첫 응답 하나에만 적용하는 상태 기계. `response.created`는 바로 내보내므로 클라이언트는 평소처럼 첫
 * 바이트를 받는다. 나머지는 보류하다가 추론이나 도구 호출이 보이면 보류분을 내보내고 그대로 흘린다.
 * 보류한 채 정상 완료에 닿으면 재요청 여부를 정한다. 보류 동안 다운스트림은 keepalive 주석으로 유휴
 * 감시를 넘긴다.
 */
export async function* withCursorResample(
  first: AsyncIterable<CanonicalResponseEvent>,
  context: CursorResampleContext,
): AsyncGenerator<CanonicalResponseEvent> {
  const iterator = first[Symbol.asyncIterator]();
  const held: CanonicalResponseEvent[] = [];
  let decided = false;
  let text = "";
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        yield* held;
        return;
      }
      const event = next.value;
      if (decided || event.type === "response.created") {
        yield event;
        continue;
      }
      const shown = showsWork(event);
      if (shown !== undefined || event.type === "response.failed" || event.type === "error") {
        decided = true;
        wireLog(`${LABEL}.decision`, { triggered: false, reason: shown ?? "failed" });
        yield* held.splice(0);
        yield event;
        continue;
      }
      if (event.type === "response.completed") {
        decided = true;
        const signals = context.firstSignals();
        const finalStepTokens = estimateTokens(signals.finalStepText.trim(), context.wireModelId);
        const verdict = resampleVerdict(event, text, signals, finalStepTokens);
        wireLog(`${LABEL}.decision`, {
          triggered: verdict === undefined,
          ...(verdict === undefined ? {} : { reason: verdict }),
          firstOutputTokens: event.response.usage?.output_tokens ?? null,
          firstInputTokens: event.response.usage?.input_tokens ?? null,
          textChars: text.length,
          finalStepTokens,
          serverWork: signals.serverWork,
        });
        if (verdict !== undefined) {
          yield* held.splice(0);
          yield event;
          continue;
        }
        const firstMs = Date.now() - context.startedAt;
        // 반복을 끝까지 읽어야 첫 Run의 전송이 닫힌다. 새 Run은 그 뒤에 연다.
        await drainRest(iterator, context.signal);
        yield* resample(held, event, text, firstMs, context);
        return;
      }
      if (event.type === "response.output_text.delta") text += event.delta;
      held.push(event);
    }
  } finally {
    await iterator.return?.();
  }
}

/** 추론이나 도구 호출이 보였으면 그 사유. 보이는 순간 재요청 대상이 아니다. */
function showsWork(event: CanonicalResponseEvent): "reasoning_present" | "function_call" | undefined {
  switch (event.type) {
    case "response.reasoning_summary_text.delta":
      return "reasoning_present";
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done":
      return "function_call";
    case "response.output_item.added":
    case "response.output_item.done":
      if (event.item.type === "reasoning") return "reasoning_present";
      if (event.item.type === "function_call" || event.item.type === "web_search_call") return "function_call";
      return undefined;
    default:
      return undefined;
  }
}

/** 재요청하지 않을 사유, 또는 재요청이면 `undefined`. */
function resampleVerdict(
  event: CompletedEvent,
  text: string,
  signals: CursorSegmentSignals,
  finalStepTokens: number,
): "incomplete" | "empty_text" | "server_work" | "not_announcement" | "long_final_step" | undefined {
  if (event.response.incomplete !== undefined) return "incomplete";
  // 빈 응답은 다른 결함이다. Claude Code가 스스로 재개 넛지를 붙인다.
  if (text.trim().length === 0) return "empty_text";
  // 서버가 이 응답 안에서 웹 검색 등을 실제로 했다면 그 뒤의 텍스트는 결과 보고다.
  if (signals.serverWork) return "server_work";
  if (!isFutureActionAnnouncement(signals.finalStepText)) return "not_announcement";
  if (finalStepTokens > MAX_RESAMPLE_FINAL_STEP_TOKENS) return "long_final_step";
  return undefined;
}

async function drainRest(iterator: AsyncIterator<CanonicalResponseEvent>, signal: AbortSignal | undefined): Promise<void> {
  try {
    while (!(await iterator.next()).done) {
      // completed 뒤에는 이벤트가 없다. 반복을 끝내 전송을 닫는다.
    }
  } catch {
    // 첫 응답은 이미 완결이다.
  }
  if (signal?.aborted) throw signal.reason;
}

type Outcome =
  | "tool_recovered"
  | "reasoning_final"
  | "text_again"
  | "error_after_commit"
  | "aborted"
  | "fallback_open_error"
  | "fallback_stream_error"
  | "fallback_empty"
  | `fallback_http_${number}`;

/**
 * 예고와 지시를 붙여 한 번 다시 받는다(재재요청은 없다). 두 번째 응답은 도구 호출이 보일 때까지 보류한다.
 * 보이면 회복이다: 첫 예고를 먼저 내보내고, 두 번째 응답에서 첫 호출 앞의 텍스트는 버린 채 잇는다 —
 * 두 번째는 대부분(19/22) 같은 예고를 한 번 더 쓰므로, 그대로 이으면 사용자가 예고를 두 번 본다. 추론은
 * 남긴다. 다운스트림은 항목 id로 블록을 가르므로 두 Run의 항목이 한 메시지에 섞여도 된다.
 *
 * 두 번째가 도구 없이 끝나거나 출력 전에 실패하면 보관한 첫 응답을 원래 종료 이벤트 그대로 내보낸다 —
 * 정상 최종 답이 걸린 경우(지시를 받고도 3/3 도구 없이 끝났다)도 이 길로 지금의 동작에 돌아간다.
 * 클라이언트가 끊었으면 받을 사람이 없으므로 아무것도 내보내지 않는다.
 */
async function* resample(
  held: readonly CanonicalResponseEvent[],
  firstCompleted: CompletedEvent,
  announcement: string,
  firstMs: number,
  context: CursorResampleContext,
): AsyncGenerator<CanonicalResponseEvent> {
  const startedAt = Date.now();
  let resumedAt: number | undefined;
  let ttfbAt: number | undefined;
  const toolNames = new Map<string, string>();
  let sawReasoning = false;
  let secondText = "";
  let droppedTextChars = 0;
  let openError: string | undefined;
  let secondCompleted: CompletedEvent | undefined;

  const report = (outcome: Outcome): void => {
    const usage = secondCompleted?.response.usage;
    wireLog(`${LABEL}.outcome`, {
      outcome,
      firstMs,
      resampleTtfbMs: ttfbAt === undefined ? null : ttfbAt - startedAt,
      resampleMs: Date.now() - startedAt,
      addedLatencyMs: resumedAt === undefined ? null : resumedAt - startedAt,
      secondOutputTokens: usage?.output_tokens ?? null,
      secondReasoning: sawReasoning,
      secondFunctionCalls: toolNames.size,
      secondToolNames: [...toolNames.values()],
      // 문구는 기록하지 않는다(본문은 wire 이벤트에 있다).
      secondTextChars: secondText.length,
      droppedTextChars,
      ...(openError === undefined ? {} : { openError }),
    });
  };
  const aborted = (): never => {
    report("aborted");
    throw context.signal?.reason;
  };
  function* fallback(outcome: Outcome): Generator<CanonicalResponseEvent> {
    resumedAt = Date.now();
    report(outcome);
    yield* held;
    yield firstCompleted;
  }

  if (context.signal?.aborted) aborted();
  let second: AdapterResponse;
  try {
    second = await context.reopen(announcement);
  } catch (error) {
    if (context.signal?.aborted) aborted();
    // 사유만 남긴다(메시지는 남기지 않는다): 컨텍스트 창 거절, adapter 종료, dial 실패를 가른다.
    openError = errorLabel(error);
    yield* fallback("fallback_open_error");
    return;
  }
  if (!second.ok) {
    yield* fallback(`fallback_http_${second.status}`);
    return;
  }

  const iterator = second.events[Symbol.asyncIterator]();
  const secondHeld: CanonicalResponseEvent[] = [];
  let committed = false;
  let terminal: Outcome | undefined;
  const track = (event: CanonicalResponseEvent): void => {
    if (showsWork(event) === "reasoning_present") sawReasoning = true;
    if ((event.type === "response.output_item.added" || event.type === "response.output_item.done")
      && event.item.type === "function_call") toolNames.set(event.item.id, event.item.name);
    if (event.type === "response.output_text.delta") secondText += event.delta;
  };
  try {
    while (true) {
      let next: IteratorResult<CanonicalResponseEvent>;
      try {
        next = await iterator.next();
      } catch (error) {
        if (context.signal?.aborted) aborted();
        if (committed) {
          report("error_after_commit");
          throw error;
        }
        yield* fallback("fallback_stream_error");
        return;
      }
      if (next.done) {
        if (!committed) {
          yield* fallback("fallback_stream_error");
          return;
        }
        report(terminal ?? "error_after_commit");
        return;
      }
      const event = next.value;
      // 첫 응답의 created가 이미 나갔다.
      if (event.type === "response.created") continue;
      track(event);
      ttfbAt ??= Date.now();
      if (!committed) {
        if (event.type === "response.failed" || event.type === "error") {
          yield* fallback("fallback_stream_error");
          return;
        }
        if (event.type === "response.completed") {
          secondCompleted = event;
          await drainRest(iterator, context.signal);
          yield* fallback(secondHeld.length === 0
            ? "fallback_empty"
            : sawReasoning
              ? "reasoning_final"
              : "text_again");
          return;
        }
        if (showsWork(event) !== "function_call") {
          secondHeld.push(event);
          continue;
        }
        committed = true;
        resumedAt = Date.now();
        yield* held;
        for (const pending of secondHeld.splice(0)) {
          if (pending.type === "response.output_text.delta") {
            droppedTextChars += pending.delta.length;
            continue;
          }
          yield pending;
        }
      }
      if (event.type === "response.completed") {
        secondCompleted = event;
        // 커밋은 도구 호출에서만 일어나므로 끝까지 온 두 번째는 회복이다. Cursor는 오류 뒤에도
        // completed를 보내므로, 이미 정한 오류는 덮어쓰지 않는다.
        terminal ??= "tool_recovered";
      } else if (event.type === "response.failed" || event.type === "error") {
        terminal = "error_after_commit";
      }
      yield event;
    }
  } finally {
    await iterator.return?.();
  }
}

function errorLabel(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && error.code.length > 0) return error.code;
  if (error instanceof Error) return error.name;
  return typeof error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
