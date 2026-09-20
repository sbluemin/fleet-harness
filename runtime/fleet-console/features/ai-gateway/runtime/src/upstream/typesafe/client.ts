import type { FetchLike } from "../../transport/upstream-sse.js";
import { linkAbortSignal } from "../../transport/upstream-sse.js";
import {
  SYSTEM_ONE_MAX_CHOICE_OPTIONS,
  SYSTEM_ONE_MAX_SCORE_LEVELS,
  SYSTEM_ONE_MIN_SCORE_LEVELS,
  decodeSystemOneResult,
  encodeSystemOneRequest,
  type SystemOneModelCard,
  type SystemOneQuestions,
  type SystemOneResult,
  type SystemOneState,
} from "./protocol.js";
import {
  TYPESAFE_API_BASE_URL,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_MODELS_PATH,
  TYPESAFE_SYSTEM_ONE_PATH,
} from "./coordinates.js";

/** 공급자가 일시적 포화로 되돌려주는 상태들 — 물러섰다 다시 물으면 된다. */
const RETRYABLE_STATUSES = new Set([429, 529]);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 400;
const DEFAULT_TIMEOUT_MS = 30_000;

export class SystemOneError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SystemOneError";
  }
}

export interface SystemOneClientDeps {
  /** 저장된 키를 읽어 온다. 없으면 로그인되지 않은 것이므로 호출자가 강등한다. */
  readonly readApiKey: () => Promise<string | undefined>;
  /** 호스트가 주입한다. 이 패키지는 전역 fetch를 가정하지 않는다. */
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly maxAttempts?: number;
  /**
   * 요청 시작부터 응답 **본문**을 읽기까지 포함한 전체 deadline.
   * fetch headers만 돌아오고 body가 늘어지는 경우를 끊기 위해 헤더 수신에서 타이머를
   * 풀지 않는다.
   */
  readonly timeoutMs?: number;
  /** 물러나는 시간을 호출자가 지정한다(테스트가 실제로 기다리지 않도록). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SystemOneAskInput<Q extends SystemOneQuestions> {
  readonly state: SystemOneState;
  readonly questions: Q;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * System One 호출 한 번을 책임지는 클라이언트. 자격증명·fetch·물러남을 모두 주입받고,
 * 전역이나 환경변수를 스스로 들여다보지 않는다.
 */
export class SystemOneClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SystemOneClientDeps) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (deps.baseUrl ?? TYPESAFE_API_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = deps.defaultModel ?? TYPESAFE_DEFAULT_MODEL;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** 키가 저장되어 있는지. 기능은 이걸 보고 강등 여부를 정한다. */
  async isSignedIn(): Promise<boolean> {
    return (await this.deps.readApiKey()) !== undefined;
  }

  async ask<Q extends SystemOneQuestions>(input: SystemOneAskInput<Q>): Promise<SystemOneResult<Q>> {
    assertQuestionsWithinLimits(input.questions);
    const body = encodeSystemOneRequest({
      state: input.state,
      model: input.model ?? this.defaultModel,
      questions: input.questions,
    });
    const payload = await this.send(TYPESAFE_SYSTEM_ONE_PATH, {
      method: "POST",
      body: JSON.stringify(body),
      signal: input.signal,
    });
    return decodeSystemOneResult(payload, input.questions);
  }

  async listModels(signal?: AbortSignal): Promise<readonly SystemOneModelCard[]> {
    const payload = await this.send(TYPESAFE_MODELS_PATH, { method: "GET", signal });
    const models = (payload as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    return models.map((entry) => {
      const card = entry as Record<string, unknown>;
      return {
        name: typeof card.name === "string" ? card.name : "",
        description: typeof card.description === "string" ? card.description : "",
        releaseDate: typeof card.release_date === "string" ? card.release_date : undefined,
      };
    });
  }

  private async send(
    path: string,
    init: { method: string; body?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const apiKey = await this.deps.readApiKey();
    if (apiKey === undefined) {
      throw new SystemOneError("TypeSafe is not signed in", undefined);
    }

    let lastError: SystemOneError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.sendAttempt(path, init, apiKey);
      } catch (error) {
        lastError = error instanceof SystemOneError
          ? error
          : new SystemOneError(
            error instanceof Error ? error.message : String(error),
            undefined,
            error,
          );
        if (isAbortLike(error) || attempt === this.maxAttempts) {
          throw lastError;
        }
        if (lastError.status === undefined || !RETRYABLE_STATUSES.has(lastError.status)) {
          throw lastError;
        }
        // 지수 물러남. 공급자 문서가 429/529에 즉시 재시도를 금한다.
        await this.sleep(DEFAULT_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new SystemOneError("TypeSafe request failed", undefined);
  }

  /**
   * fetch 헤더와 본문 읽기를 하나의 deadline 아래에서 수행한다. 이미 abort된 외부 signal도
   * 즉시 반영하고, listener는 항상 해제한다.
   */
  private async sendAttempt(
    path: string,
    init: { method: string; body?: string; signal?: AbortSignal },
    apiKey: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutError = createTimeoutError(this.timeoutMs);
    const timeout = setTimeout(() => {
      controller.abort(timeoutError);
    }, this.timeoutMs);
    const unlink = linkAbortSignal(init.signal, controller);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readBodyUnderSignal(response, controller.signal);
        throw new SystemOneError(
          `TypeSafe request failed with HTTP ${response.status}`,
          response.status,
          detail,
        );
      }
      return await readJsonUnderSignal(response, controller.signal);
    } catch (error) {
      if (error instanceof SystemOneError) throw error;
      throw new SystemOneError(
        error instanceof Error ? error.message : String(error),
        undefined,
        error,
      );
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }
}

function createTimeoutError(timeoutMs: number): DOMException {
  return new DOMException(`TypeSafe request timed out after ${timeoutMs}ms`, "TimeoutError");
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  if (error instanceof SystemOneError) {
    return isAbortLike(error.detail) || /aborted|abort|timed out|timeout/i.test(error.message);
  }
  return false;
}

async function readJsonUnderSignal(response: Response, signal: AbortSignal): Promise<unknown> {
  const detail = await readBodyUnderSignal(response, signal);
  if (detail === undefined || typeof detail === "string") {
    throw new SystemOneError("TypeSafe response body was not JSON", response.status, detail);
  }
  return detail;
}

async function readBodyUnderSignal(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw abortReason(signal);
  try {
    const text = await raceWithAbort(response.text(), signal);
    if (text === "") return undefined;
    try {
      const body = JSON.parse(text) as { detail?: unknown };
      return body.detail ?? body;
    } catch {
      return text;
    }
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // abort가 이긴 뒤에도 body promise가 나중에 reject될 수 있다. 그 늦은 거절을
  // unhandled rejection으로 남기지 않는다.
  const ignoreLateRejection = () => {
    void promise.catch(() => undefined);
  };
  if (signal.aborted) {
    ignoreLateRejection();
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      ignoreLateRejection();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function assertQuestionsWithinLimits(questions: SystemOneQuestions): void {
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      const options = Object.keys(question.criteria).length;
      if (options > SYSTEM_ONE_MAX_CHOICE_OPTIONS) {
        throw new SystemOneError(
          `Choice question '${name}' declares ${options} options; the provider accepts at most ${SYSTEM_ONE_MAX_CHOICE_OPTIONS}`,
          undefined,
        );
      }
    }
    if (question.type === "score") {
      const levels = question.criteria.length;
      if (levels < SYSTEM_ONE_MIN_SCORE_LEVELS || levels > SYSTEM_ONE_MAX_SCORE_LEVELS) {
        throw new SystemOneError(
          `Score question '${name}' declares ${levels} levels; the provider accepts ${SYSTEM_ONE_MIN_SCORE_LEVELS}-${SYSTEM_ONE_MAX_SCORE_LEVELS}`,
          undefined,
        );
      }
    }
  }
}
