import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

import type { CliMessagePolicy, PtyInputChunk } from "../agent-cli/types.js";

export interface PtyWriteSink {
  write(data: string): void;
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

export function createCarrierResultReminderRouter(deps: {
  readonly streamRegister: (handler: (event: CarrierJobStreamEvent) => void) => () => void;
  readonly resolveSink: (event: CarrierJobStreamEvent) => PtyWriteSink | undefined;
  readonly resolvePolicy?: (event: CarrierJobStreamEvent) => CliMessagePolicy;
  readonly resolveSessionKey?: (event: CarrierJobStreamEvent) => string | undefined;
  readonly platform?: NodeJS.Platform;
}): () => void {
  // 세션별 지연 제출 직렬화 tail. Windows 지연 경로에서 같은 세션으로 두 리마인더가 250ms
  // 지연 창 안에 도착하면 텍스트가 뒤섞이고(textA textB) CR이 결합/공백 제출되므로, 이전
  // 제출의 종결자(CR)까지 flush된 뒤 다음 리마인더의 첫 write가 시작되도록 체인한다.
  const submitTails = new Map<string, Promise<void>>();

  return deps.streamRegister((event) => {
    if (event.type !== "job:finalized") return;
    if (typeof event.systemReminder !== "string") return;

    const reminder = sanitizeCarrierResultReminder(event.systemReminder);
    if (reminder.trim().length === 0) return;

    const sink = deps.resolveSink(event);
    if (!sink) return;

    // host가 활성 프로파일의 messagePolicy를 제공하면 그대로 적용한다. 미제공 시 기본 정책.
    const policy = deps.resolvePolicy?.(event) ?? {};
    const chunks = formatCarrierResultReminderMessage(policy, reminder, deps.platform);
    const write = (data: string) => sink.write(data);

    // 지연 청크(Windows conpty 경로)만 직렬화한다. 동기 단일 write 경로는 즉시 flush되어
    // 인터리브가 불가능하므로, 세션 키가 있어도 기존 동기 동작을 그대로 유지한다.
    const key = deps.resolveSessionKey?.(event);
    const hasDelay = chunks.some((chunk) => chunk.submitDelayMs !== undefined);
    if (!hasDelay || key === undefined) {
      void writeChunksWithDelay(write, chunks);
      return;
    }

    const prev = submitTails.get(key) ?? Promise.resolve();
    const tail = prev.then(() => writeChunksWithDelay(write, chunks)).catch(() => {});
    submitTails.set(key, tail);
    void tail.then(() => {
      if (submitTails.get(key) === tail) submitTails.delete(key);
    });
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
): PtyInputChunk[] {
  const resolvedPolicy = resolveMessagePolicy(policy);
  return applyMessagePolicy(text, resolvedPolicy, platform);
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
): PtyInputChunk[] {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));

  if (policy.conptyPasteBurst && platform === "win32" && usePasteMode) {
    return [
      { data: text },
      { data: policy.lineTerminator, submitDelayMs: WINDOWS_CONPTY_SUBMIT_DELAY_MS },
    ];
  }

  return [{
    data: usePasteMode
      ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}${policy.lineTerminator}`
      : `${text}${policy.lineTerminator}`,
  }];
}

function writeChunksWithDelay(write: (data: string) => void, chunks: readonly PtyInputChunk[]): Promise<void> {
  return new Promise((resolve) => {
    let index = 0;

    const writeNext = (): void => {
      const chunk = chunks[index++];
      if (!chunk) {
        resolve();
        return;
      }

      const commit = () => {
        try {
          write(chunk.data);
        } catch {
          // Sessions may close before a deferred submit reaches the host PTY.
        }
        writeNext();
      };

      if (chunk.submitDelayMs === undefined) {
        commit();
      } else {
        setTimeout(commit, chunk.submitDelayMs);
      }
    };

    writeNext();
  });
}
