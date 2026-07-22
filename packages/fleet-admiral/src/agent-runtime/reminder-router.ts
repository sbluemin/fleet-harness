import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

import type { CliMessagePolicy, PtyInputChunk } from "../agent-cli/types.js";

export interface PtyWriteSink {
  write(data: string): boolean | void;
}

const DEFAULT_BRACKETED_PASTE = false;
const DEFAULT_CONPTY_PASTE_BURST = false;
const DEFAULT_LINE_TERMINATOR = "\r";
const DEFAULT_MULTILINE_STRATEGY = "literal";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const C1_BRACKETED_PASTE_END = "\x9B201~";
const CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;
const LINE_BREAK_PATTERN = /[\r\n]/;
// Windows crossterm reads INPUT_RECORD rather than bracketed paste, then Codex suppresses Enter during its paste burst window.
const WINDOWS_CONPTY_SUBMIT_DELAY_MS = 250;

export interface PtyMessageDeliveryOptions {
  readonly submitDelayMs?: number;
}

export interface DelayedPtyWriter {
  // sessionKey가 있고 지연 청크가 포함되면 같은 키의 이전 제출이 끝난 뒤 순차 실행한다.
  enqueue(sessionKey: string | undefined, write: (data: string) => boolean | void, chunks: readonly PtyInputChunk[]): void;
  cancel(sessionKey: string): void;
  cancelAll(): void;
}

// 세션별 지연 제출을 직렬화하는 공유 primitive. 같은 세션으로 두 입력
// (carrier 리마인더/rename 주입)이 250ms 지연 창 안에 도착하면 텍스트가 뒤섞이고(textA textB)
// CR이 결합/공백 제출되므로, 이전 제출의 종결자(CR)까지 flush된 뒤 다음 입력의 첫 write가
// 시작되도록 체인한다. 리마인더와 rename이 같은 인스턴스를 공유해야 상호 직렬화된다.
export function createDelayedPtyWriter(): DelayedPtyWriter {
  const submitTails = new Map<string, Promise<void>>();
  const pendingControllers = new Map<string, Set<AbortController>>();

  const cancel = (sessionKey: string): void => {
    const controllers = pendingControllers.get(sessionKey);
    if (controllers) {
      for (const controller of controllers) controller.abort();
    }
    pendingControllers.delete(sessionKey);
    submitTails.delete(sessionKey);
  };

  return {
    enqueue(sessionKey, write, chunks) {
      // 지연 청크만 직렬화한다. 동기 단일 write 경로는 즉시 flush되어 인터리브가 불가능하므로
      // 세션 키가 있어도 기존 동기 동작을 그대로 유지한다.
      const hasDelay = chunks.some((chunk) => chunk.submitDelayMs !== undefined);
      if (!hasDelay || sessionKey === undefined) {
        void writeChunksWithDelay(write, chunks);
        return;
      }

      const controller = new AbortController();
      const controllers = pendingControllers.get(sessionKey) ?? new Set<AbortController>();
      controllers.add(controller);
      pendingControllers.set(sessionKey, controllers);
      const prev = submitTails.get(sessionKey) ?? Promise.resolve();
      const tail = prev.then(() => writeChunksWithDelay(write, chunks, controller.signal)).catch(() => {});
      submitTails.set(sessionKey, tail);
      void tail.then(() => {
        controllers.delete(controller);
        if (pendingControllers.get(sessionKey) === controllers && controllers.size === 0) pendingControllers.delete(sessionKey);
        if (submitTails.get(sessionKey) === tail) submitTails.delete(sessionKey);
      });
    },
    cancel,
    cancelAll() {
      for (const sessionKey of [...pendingControllers.keys()]) cancel(sessionKey);
    },
  };
}

export function createCarrierResultReminderRouter(deps: {
  readonly streamRegister: (handler: (event: CarrierJobStreamEvent) => void) => () => void;
  readonly resolveSink: (event: CarrierJobStreamEvent) => PtyWriteSink | undefined;
  readonly resolvePolicy?: (event: CarrierJobStreamEvent) => CliMessagePolicy;
  readonly resolveSessionKey?: (event: CarrierJobStreamEvent) => string | undefined;
  // rename 주입 등 다른 지연 경로와 세션 단위로 함께 직렬화하려면 host가 공유 writer를 주입한다.
  readonly writer?: DelayedPtyWriter;
  // host 전용 전송 정책. 미지정 시 기존 formatter 바이트와 제출 타이밍을 유지한다.
  readonly delivery?: PtyMessageDeliveryOptions;
  readonly platform?: NodeJS.Platform;
}): () => void {
  const writer = deps.writer ?? createDelayedPtyWriter();

  return deps.streamRegister((event) => {
    if (event.type !== "job:finalized") return;
    if (typeof event.systemReminder !== "string") return;

    const reminder = sanitizeCarrierResultReminder(event.systemReminder);
    if (reminder.trim().length === 0) return;

    const sink = deps.resolveSink(event);
    if (!sink) return;

    // host가 활성 프로파일의 messagePolicy를 제공하면 그대로 적용한다. 미제공 시 기본 정책.
    const policy = deps.resolvePolicy?.(event) ?? {};
    const chunks = formatCarrierResultReminderMessage(policy, reminder, deps.platform, deps.delivery);
    writer.enqueue(deps.resolveSessionKey?.(event), (data) => sink.write(data), chunks);
  });
}

export function sanitizeCarrierResultReminder(text: string): string {
  return text
    .split(BRACKETED_PASTE_END)
    .join("")
    .split(C1_BRACKETED_PASTE_END)
    .join("")
    .replace(CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE, "");
}

export function formatCarrierResultReminderMessage(
  policy: CliMessagePolicy,
  text: string,
  platform: NodeJS.Platform = process.platform,
  delivery: PtyMessageDeliveryOptions = {},
): PtyInputChunk[] {
  const resolvedPolicy = resolveMessagePolicy(policy);
  return applyMessagePolicy(text, resolvedPolicy, platform, delivery);
}

function resolveMessagePolicy(policy: CliMessagePolicy): Required<CliMessagePolicy> {
  return {
    bracketedPaste: policy.bracketedPaste ?? DEFAULT_BRACKETED_PASTE,
    conptyPasteBurst: policy.conptyPasteBurst ?? DEFAULT_CONPTY_PASTE_BURST,
    lineTerminator: policy.lineTerminator ?? DEFAULT_LINE_TERMINATOR,
    multilineStrategy: policy.multilineStrategy ?? DEFAULT_MULTILINE_STRATEGY,
  };
}

function applyMessagePolicy(
  text: string,
  policy: Required<CliMessagePolicy>,
  platform: NodeJS.Platform,
  delivery: PtyMessageDeliveryOptions,
): PtyInputChunk[] {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));
  const useConptyPasteBurst = policy.conptyPasteBurst && platform === "win32" && usePasteMode;
  const payload = useConptyPasteBurst
    ? text
    : usePasteMode
      ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`
      : text;

  if (delivery.submitDelayMs !== undefined) {
    return [
      { data: payload },
      { data: policy.lineTerminator, submitDelayMs: delivery.submitDelayMs },
    ];
  }

  if (useConptyPasteBurst) {
    return [
      { data: text },
      { data: policy.lineTerminator, submitDelayMs: WINDOWS_CONPTY_SUBMIT_DELAY_MS },
    ];
  }

  return [{
    data: `${payload}${policy.lineTerminator}`,
  }];
}

async function writeChunksWithDelay(
  write: (data: string) => boolean | void,
  chunks: readonly PtyInputChunk[],
  signal?: AbortSignal,
): Promise<void> {
  for (const chunk of chunks) {
    if (signal?.aborted) return;
    if (chunk.submitDelayMs !== undefined) {
      await waitForDelay(chunk.submitDelayMs, signal);
      if (signal?.aborted) return;
    }
    try {
      if (write(chunk.data) === false) return;
    } catch {
      // Sessions may close before a deferred submit reaches the host PTY.
      return;
    }
  }
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
