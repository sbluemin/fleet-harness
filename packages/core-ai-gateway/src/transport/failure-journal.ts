/**
 * A durable record of every turn this gateway failed, and nothing else.
 *
 * A failed turn is the one event that leaves no trace here. The wire log is opt-in, rotates on a
 * byte budget, and keeps a single backup — measured 2026-08-21, a burst of 55 concurrent streams
 * evicted 42 of its own request records while it was running, so the log is least usable exactly
 * when a concurrency failure is what needs reading. And a failure that lands after the response
 * has committed can only be reported as one SSE frame, which the client renders once and no one
 * can retrieve.
 *
 * So this journal is deliberately the opposite of the wire log: always on, one line per failure,
 * and small enough that a month of them costs nothing. It records the coordinates a diagnosis
 * needs — which provider, which phase, what the client was told, what the transport said, and how
 * many upstream connections were open at that moment — and never a prompt, a completion, a tool
 * argument, a header, or a credential.
 */

export const DEFAULT_FAILURE_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
/** Upper bound on the transport message. Long enough to carry a cause chain, short enough to stay a line. */
const MAX_DETAIL_LENGTH = 512;

/**
 * Where the failure happened relative to the response, because it decides who could have recovered.
 *
 * `pre_commit` failures still have a status line to spend, so both this gateway and the client's
 * retry budget can act on them. `post_commit` failures have already sent bytes; neither layer may
 * retry them, and the client renders `API mid response error`. Counting the two separately is what
 * tells an operator whether a fix belongs in recovery or in prevention.
 */
export type GatewayFailurePhase = "pre_commit" | "post_commit";

export interface GatewayFailureRecord {
  readonly timestamp: string;
  readonly phase: GatewayFailurePhase;
  /** Catalog id the caller asked for, never a credential-bearing alias. */
  readonly model?: string;
  readonly provider?: string;
  /** Status the client was given, or absent when the response had already committed. */
  readonly status?: number;
  /** Anthropic error class the client was given. */
  readonly errorType: string;
  /** Transport cause code where one exists — `UND_ERR_SOCKET`, `ECONNRESET`, and so on. */
  readonly code?: string;
  /** Bounded failure text. Carries no body, header, or credential. */
  readonly detail: string;
  /** Milliseconds from the gateway accepting the request to the failure. */
  readonly elapsedMs: number;
  /** Upstream connections this process held when the turn died. */
  readonly upstreamInFlight?: number;
  /** Calls waiting for a connection at that moment. */
  readonly upstreamQueued?: number;
}

export type GatewayFailureSink = (record: GatewayFailureRecord) => void;

export interface FailureJournalOptions {
  readonly filePath: string;
  /** Rotate at this size, retaining one `.1` backup. */
  readonly maxBytes?: number;
}

export interface FailureJournal {
  readonly write: GatewayFailureSink;
  /** Settle pending appends. Hosts call this on shutdown. */
  flush(): Promise<void>;
}

/** Trim a failure message to one bounded, single-line field. */
export function failureDetail(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_DETAIL_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

/**
 * An append-only JSONL journal.
 *
 * Writes are serialized behind one promise chain so concurrent failures cannot interleave inside a
 * line, and every failure in the writer itself is swallowed: a journal that cannot record must
 * never be the reason a turn ends differently than it would have.
 */
export function createFailureJournal(options: FailureJournalOptions): FailureJournal {
  const maxBytes = options.maxBytes ?? DEFAULT_FAILURE_JOURNAL_MAX_BYTES;
  let chain: Promise<void> = Promise.resolve();

  const append = async (line: string): Promise<void> => {
    const { appendFile, mkdir, rename, stat } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(options.filePath), { recursive: true });
    const size = await stat(options.filePath).then((s) => s.size).catch(() => 0);
    if (size + line.length > maxBytes && size > 0) {
      await rename(options.filePath, `${options.filePath}.1`).catch(() => undefined);
    }
    await appendFile(options.filePath, line, { mode: 0o600 });
  };

  return {
    write: (record) => {
      const line = `${JSON.stringify(record)}\n`;
      chain = chain.then(() => append(line)).catch(() => undefined);
    },
    flush: () => chain,
  };
}
