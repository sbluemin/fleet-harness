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
  readonly platform?: NodeJS.Platform;
}): () => void {
  return deps.streamRegister((event) => {
    if (event.type !== "job:finalized") return;
    if (typeof event.systemReminder !== "string") return;

    const reminder = sanitizeCarrierResultReminder(event.systemReminder);
    if (reminder.trim().length === 0) return;

    const sink = deps.resolveSink(event);
    if (!sink) return;

    // host가 활성 프로파일의 messagePolicy를 제공하면 그대로 적용한다. 미제공 시 기본 정책.
    const policy = deps.resolvePolicy?.(event) ?? {};
    writeChunksWithDelay((data) => sink.write(data), formatCarrierResultReminderMessage(policy, reminder, deps.platform));
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

function writeChunksWithDelay(write: (data: string) => void, chunks: readonly PtyInputChunk[]): void {
  let index = 0;

  const writeNext = (): void => {
    const chunk = chunks[index++];
    if (!chunk) return;

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
}
