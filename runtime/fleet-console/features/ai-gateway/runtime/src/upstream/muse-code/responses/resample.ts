import type { AdapterResponse, CanonicalResponseEvent } from "../../../canonical/index.js";
import { UpstreamIdleTimeoutError } from "../../../transport/upstream-sse.js";
import { wireLog } from "../../../transport/wire-log.js";

/**
 * Muse의 무추론 단답 재요청.
 *
 * Muse는 `reasoning.effort`를 받아도 추론을 건너뛰는 분기에 들어가고, 그 분기에서 도구 결과 직후
 * "이제 X를 확인합니다" 같은 예고 한 줄만 내고 정상 완료한다(H15). 그 분기는 입력에 거의 결정적으로
 * 묶인다: 같은 요청을 다시 보내면 2/8만 도구를 불렀고(#1458 실측 2/5, 2026-10-05 0/3, 대부분 같은
 * 문장), 예고 뒤에 짧은 지시("진행해")가 붙은 입력은 3/3 바로 추론하고 도구를 불렀다. 그래서 도구
 * 결과 직후의 무추론·무도구 텍스트 응답은 클라이언트에 내보내기 전에, 그 예고를 assistant 발화로 넣고
 * 짧은 developer 지시를 붙인 요청으로 한 번 다시 받는다.
 *
 * 이 동작은 canonical 이벤트 수준에서 일어나므로 스트리밍·비스트리밍이 같은 결과를 받는다. 공급자
 * 의미론이라 Muse 어댑터 안에만 있고, 다른 공급자에는 닿지 않는다.
 */

const LABEL = "muse-code-responses.resample";

/**
 * 재요청에만 붙는 지시. 클라이언트 기록에는 남지 않는다. 사람이 쓴 한 마디로도 회복됐으므로 짧게
 * 두고, 실제로 끝난 작업이면 최종 답을 내도록 탈출구를 둔다.
 */
export const RESAMPLE_NUDGE =
  "You announced the next step but ended without calling a tool. Make that tool call now, without writing "
  + "anything first. If the task is actually complete, end without adding anything.";

/** 재요청 입력 끝에 붙는 항목: 첫 응답의 예고와 지시. 둘 다 Muse가 받는 문자열 content 메시지다. */
export function resampleNudgeItems(announcement: string): Record<string, unknown>[] {
  return [
    { type: "message", role: "assistant", content: announcement },
    { type: "message", role: "developer", content: RESAMPLE_NUDGE },
  ];
}
/** 이보다 작은 출력 상한은 짧은 판정형 부속 호출이다(보안 모니터: 64). */
const MIN_RESAMPLE_MAX_OUTPUT_TOKENS = 1024;

export type ResampleSkip = "no_tools" | "small_max" | "not_after_tool_output" | "after_messaging_tool";

export interface ResampleArming {
  readonly armed: boolean;
  readonly skip?: ResampleSkip;
  /** 마지막 도구 결과에 대응하는 도구 이름. */
  readonly lastToolName?: string;
}

interface WireRequestShape {
  readonly tools?: readonly unknown[];
  readonly max_output_tokens?: number;
  readonly input: readonly unknown[];
}

/**
 * 요청을 보내기 전에 정해지는 조건. 도구가 없으면 회복할 대상이 없고(`tool_choice: none`은 이 어댑터가
 * 도구를 싣지 않는 것으로 표현한다), 작은 출력 상한은 부속 호출이며, H15는 거의 전부(99.6%) 도구 결과
 * 직후에 난다. 사용자 텍스트 직후의 빠른 단답은 정상이므로 다시 만들지 않는다. 범위 밖이면 응답을
 * 보류하지 않으므로 지연도 없다.
 */
export function resampleArming(
  payload: WireRequestShape,
  messagingToolNames: ReadonlySet<string>,
): ResampleArming {
  if (payload.tools === undefined || payload.tools.length === 0) return { armed: false, skip: "no_tools" };
  if (payload.max_output_tokens !== undefined && payload.max_output_tokens < MIN_RESAMPLE_MAX_OUTPUT_TOKENS) {
    return { armed: false, skip: "small_max" };
  }
  const last = lastNonDeveloperItem(payload.input);
  if (!isRecord(last) || last.type !== "function_call_output") return { armed: false, skip: "not_after_tool_output" };
  const lastToolName = toolNameForCall(payload.input, last.call_id);
  const named = lastToolName === undefined ? {} : { lastToolName };
  if (!resampleInScope(lastToolName, messagingToolNames)) return { armed: false, skip: "after_messaging_tool", ...named };
  return { armed: true, ...named };
}

/** 끝에 붙는 developer 알림(`<total_tokens>` 등)은 건너뛰고 본다. */
function lastNonDeveloperItem(input: readonly unknown[]): unknown {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (isRecord(item) && item.type === "message" && item.role === "developer") continue;
    return item;
  }
  return undefined;
}

function toolNameForCall(input: readonly unknown[], callId: unknown): string | undefined {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (isRecord(item) && item.type === "function_call" && item.call_id === callId && typeof item.name === "string") {
      return item.name;
    }
  }
  return undefined;
}

/**
 * 정책 범위: 직후 보고 중복 방지. 무추론 단답의 대부분(81%)은 보고(메시징 도구)를 보낸 뒤의 정상
 * 마무리이고, 그 자리에서 다시 받은 모델은 보고를 다시 보낼 수 있다. 다른 세션으로 가는 중복 메시지는
 * 사용자에게 보이는 부작용이므로 보고 직후는 다시 받지 않는다. 판정은 도구 이름만 보고, 응답 문구는
 * 해석하지 않는다.
 */
export function resampleInScope(
  lastToolName: string | undefined,
  messagingToolNames: ReadonlySet<string>,
): boolean {
  return lastToolName === undefined || !messagingToolNames.has(lastToolName);
}

export interface MuseCodeResampleContext {
  readonly signal?: AbortSignal;
  readonly startedAt: number;
  /**
   * 첫 응답의 예고(`announcement`)와 지시를 입력 끝에 붙여 다시 보낸다({@link resampleNudgeItems}).
   * 응답을 받지 못하면 던진다.
   */
  readonly reopen: (announcement: string) => Promise<AdapterResponse>;
}

type CompletedEvent = Extract<CanonicalResponseEvent, { type: "response.completed" }>;

/**
 * 첫 응답 하나에만 적용하는 상태 기계. `response.created`는 바로 내보내므로 클라이언트는 평소처럼 첫
 * 바이트를 받는다. 첫 message 항목부터는 보류하다가, 추론이나 도구 호출이 보이면 보류분을 내보내고 그대로
 * 흘린다. 보류한 채 정상 완료에 닿으면 재요청 여부를 정한다. 보류 동안 다운스트림은 keepalive 주석으로
 * 유휴 감시를 넘긴다.
 */
export async function* withMuseCodeResample(
  first: AsyncIterable<CanonicalResponseEvent>,
  context: MuseCodeResampleContext,
): AsyncGenerator<CanonicalResponseEvent> {
  const iterator = first[Symbol.asyncIterator]();
  const held: CanonicalResponseEvent[] = [];
  let decided = false;
  let deltaText = "";
  let doneText = "";
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        // 종료 이벤트 없이 끝난 스트림은 소비자의 기존 처리("ended before completed")에 맡긴다.
        yield* held;
        return;
      }
      const event = next.value;
      if (decided) {
        yield event;
        continue;
      }
      if (event.type === "response.created") {
        yield event;
        continue;
      }
      const shown = showsWork(event);
      if (shown !== undefined) {
        decided = true;
        wireLog(`${LABEL}.decision`, { triggered: false, reason: shown });
        yield* held.splice(0);
        yield event;
        continue;
      }
      if (event.type === "response.failed" || event.type === "error") {
        decided = true;
        wireLog(`${LABEL}.decision`, { triggered: false, reason: "failed" });
        yield* held.splice(0);
        yield event;
        continue;
      }
      if (event.type === "response.completed") {
        decided = true;
        const text = deltaText.length > 0 ? deltaText : doneText;
        const verdict = resampleVerdict(event, text);
        const usage = event.response.usage;
        wireLog(`${LABEL}.decision`, {
          triggered: verdict === undefined,
          ...(verdict === undefined ? {} : { reason: verdict }),
          firstOutputTokens: usage?.output_tokens ?? null,
          firstReasoningTokens: usage?.reasoning_output_tokens ?? null,
          firstInputTokens: usage?.input_tokens ?? null,
          textChars: text.length,
        });
        if (verdict !== undefined) {
          yield* held.splice(0);
          yield event;
          continue;
        }
        const firstMs = Date.now() - context.startedAt;
        // 구독 사용량 관측(`response.subscription_usage`)은 completed 뒤에 오므로 첫 스트림을 끝까지 읽는다.
        await drainRest(iterator, context.signal);
        yield* resample(held, event, text, firstMs, context);
        return;
      }
      if (event.type === "response.output_text.delta") deltaText += event.delta;
      if (event.type === "response.output_text.done") doneText += event.text;
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
): "incomplete" | "reasoning_present" | "empty_text" | undefined {
  // 업스트림이 미완료를 선언한 응답은 F10 경로(max_tokens 등)로 그대로 내보낸다.
  if (event.response.incomplete !== undefined) return "incomplete";
  // blob이 빈 reasoning 항목은 canonical로 나오지 않는다. 그래도 추론 토큰이 있으면 모델은 추론했다.
  if ((event.response.usage?.reasoning_output_tokens ?? 0) > 0) return "reasoning_present";
  // 빈 응답은 다른 결함이다. 다시 받아도 고쳐진다는 근거가 없다.
  if (text.trim().length === 0) return "empty_text";
  return undefined;
}

async function drainRest(iterator: AsyncIterator<CanonicalResponseEvent>, signal: AbortSignal | undefined): Promise<void> {
  try {
    while (!(await iterator.next()).done) {
      // completed 뒤에 남는 것은 사용량 관측뿐이고 이벤트를 내지 않는다.
    }
  } catch {
    // 첫 응답은 이미 완결이다. 꼬리를 읽지 못해도 잃는 것은 사용량 관측 하나다.
  }
  if (signal?.aborted) throw signal.reason;
}

type Outcome =
  | "tool_recovered"
  | "reasoning_final"
  | "text_again"
  | "incomplete"
  | "error_after_commit"
  | "aborted"
  | "fallback_fetch_error"
  | "fallback_stream_error"
  | "fallback_idle"
  | "fallback_empty"
  | "fallback_incomplete"
  | `fallback_http_${number}`;

/**
 * 예고와 지시를 붙여 한 번 다시 받는다(재재요청은 없다). 첫 예고는 재요청 진입 즉시 먼저
 * 내보낸다 — 두 번째 응답이 오래 침묵해도 클라이언트는 예고를 바로 본다. 그래도 회복 판정은
 * 그대로다: 두 번째 응답에서 도구 호출이 보여야 회복이고, 그때 두 번째 응답을 잇는다.
 * 그러면 Muse가 추론할 때 스스로 내는 `[예고, 추론, 도구 호출]` 순서가 되고, 클라이언트 기록은
 * 모델이 본 문맥(자기가 한 예고)과 어긋나지 않는다. 다운스트림은 항목 id로 블록을 가르므로
 * 두 응답의 항목이 한 메시지에 섞여도 된다.
 *
 * 추론만으로는 회복이 아니다. 첫 응답이 실제 최종 보고였던 턴에서 두 번째는 추론한 뒤 같은 보고를
 * 짧게 되풀이했다(2026-10-05 실측) — 그 답을 붙이면 보고가 두 번 보인다. 그래서 두 번째가 도구 없이
 * 끝나거나 출력 전에 실패하면 보관한 첫 응답을 원래 종료 이벤트와 usage 그대로 내보낸다 — 오류가
 * 아니라 지금의 동작으로 돌아가는 것이다. 클라이언트가 끊었으면 받을 사람이 없으므로 아무것도 내보내지
 * 않는다.
 */
async function* resample(
  held: readonly CanonicalResponseEvent[],
  firstCompleted: CompletedEvent,
  announcement: string,
  firstMs: number,
  context: MuseCodeResampleContext,
): AsyncGenerator<CanonicalResponseEvent> {
  const startedAt = Date.now();
  let resumedAt: number | undefined;
  let ttfbAt: number | undefined;
  const toolNames = new Map<string, string>();
  let sawReasoning = false;
  let secondText = "";
  let secondCompleted: CompletedEvent | undefined;

  const report = (outcome: Outcome): void => {
    const usage = secondCompleted?.response.usage;
    wireLog(`${LABEL}.outcome`, {
      outcome,
      mode: "nudge",
      firstMs,
      resampleTtfbMs: ttfbAt === undefined ? null : ttfbAt - startedAt,
      resampleMs: Date.now() - startedAt,
      addedLatencyMs: resumedAt === undefined ? null : resumedAt - startedAt,
      secondOutputTokens: usage?.output_tokens ?? null,
      secondReasoningTokens: usage?.reasoning_output_tokens ?? null,
      secondFunctionCalls: toolNames.size,
      secondToolNames: [...toolNames.values()],
      // 두 번째가 예고를 되풀이했는지 보려는 길이. 문구는 기록하지 않는다(본문은 wire 이벤트에 있다).
      secondTextChars: secondText.length,
    });
  };
  const aborted = (): never => {
    report("aborted");
    throw context.signal?.reason;
  };
  let previewEmitted = false;
  /**
   * 첫 예고(held)를 최대 한 번만 내놓는다. 재요청 진입 직후 즉시 방출하고, fallback과 commit은
   * 이 가드를 거쳐 이미 나간 예고를 다시 내보내지 않는다. 방출 시각이 addedLatencyMs다.
   */
  function takePreview(): readonly CanonicalResponseEvent[] {
    if (previewEmitted) return [];
    previewEmitted = true;
    resumedAt ??= Date.now();
    return held;
  }
  function* fallback(outcome: Outcome): Generator<CanonicalResponseEvent> {
    report(outcome);
    yield* takePreview();
    yield firstCompleted;
  }

  if (context.signal?.aborted) aborted();
  // 재요청 fetch를 기다리기 전에 첫 예고를 즉시 내보낸다. 커밋 조건·둘째 파기·usage 귀속은
  // 그대로이므로 전달 시각만 앞당겨진다.
  yield* takePreview();
  let second: AdapterResponse;
  try {
    second = await context.reopen(announcement);
  } catch {
    if (context.signal?.aborted) aborted();
    yield* fallback("fallback_fetch_error");
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
        yield* fallback(error instanceof UpstreamIdleTimeoutError ? "fallback_idle" : "fallback_stream_error");
        return;
      }
      if (next.done) {
        if (!committed) {
          yield* fallback("fallback_stream_error");
          return;
        }
        // 출력을 시작한 뒤 종료 이벤트 없이 끝나면 소비자가 미완료 스트림으로 처리한다.
        report(terminal ?? "error_after_commit");
        return;
      }
      const event = next.value;
      // message_start는 첫 응답의 created로 이미 나갔다.
      if (event.type === "response.created") continue;
      track(event);
      ttfbAt ??= Date.now();
      if (!committed) {
        // 출력 전의 실패는 첫 응답보다 나을 것이 없다.
        if (event.type === "response.failed" || event.type === "error") {
          yield* fallback("fallback_stream_error");
          return;
        }
        if (event.type === "response.completed") {
          // 도구 없이 끝난 두 번째는 첫 응답보다 나을 것이 없다. 사용량 관측을 위해 꼬리를 읽는다.
          secondCompleted = event;
          await drainRest(iterator, context.signal);
          yield* fallback(event.response.incomplete !== undefined
            ? "fallback_incomplete"
            : secondHeld.length === 0
              ? "fallback_empty"
              : sawReasoning || (event.response.usage?.reasoning_output_tokens ?? 0) > 0
                ? "reasoning_final"
                : "text_again");
          return;
        }
        if (showsWork(event) !== "function_call") {
          secondHeld.push(event);
          continue;
        }
        committed = true;
        yield* takePreview();
        yield* secondHeld.splice(0);
      }
      if (event.type === "response.completed") {
        secondCompleted = event;
        // 커밋은 도구 호출에서만 일어나므로 끝까지 온 두 번째는 회복이다.
        terminal = event.response.incomplete !== undefined ? "incomplete" : "tool_recovered";
      } else if (event.type === "response.failed" || event.type === "error") {
        terminal = "error_after_commit";
      }
      yield event;
    }
  } finally {
    await iterator.return?.();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
