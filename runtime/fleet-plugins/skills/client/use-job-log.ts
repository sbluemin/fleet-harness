import { useCallback, useEffect, useRef, useState } from "react";

// ─── types ───────────────────────────────────────────────────────────────────

export type JobLogStatus = "idle" | "running" | "done" | "error";

export interface JobLogState {
  readonly status: JobLogStatus;
  readonly lines: readonly string[];
}

export interface UseJobLogReturn extends JobLogState {
  readonly start: (postUrl: string, body: Record<string, unknown>) => void;
  readonly reset: () => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const POLL_MS = 750;

// ─── useJobLog ────────────────────────────────────────────────────────────────

export function useJobLog(): UseJobLogReturn {
  const [state, setState] = useState<JobLogState>({ status: "idle", lines: [] });
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => clearPoll(), [clearPoll]);

  const reset = useCallback(() => {
    clearPoll();
    setState({ status: "idle", lines: [] });
  }, [clearPoll]);

  const start = useCallback((postUrl: string, body: Record<string, unknown>) => {
    clearPoll();
    setState({ status: "running", lines: [] });

    void (async () => {
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);

      if (!res?.ok) {
        setState({ status: "error", lines: [] });
        return;
      }

      const { jobId } = await res.json() as { jobId: string };
      let cursor = 0;

      const poll = async () => {
        const jr = await fetch(
          `/plugins/skills/jobs?jobId=${encodeURIComponent(jobId)}&cursor=${cursor}`,
        ).catch(() => null);
        if (!jr?.ok) {
          setState((prev) => ({ ...prev, status: "error" }));
          return;
        }
        const data = await jr.json() as {
          lines: string[];
          nextCursor: number;
          status: string;
        };
        cursor = data.nextCursor;
        setState((prev) => ({ ...prev, lines: [...prev.lines, ...data.lines] }));
        if (data.status === "running") {
          pollRef.current = setTimeout(() => { void poll(); }, POLL_MS);
        } else {
          setState((prev) => ({
            ...prev,
            status: data.status as "done" | "error",
          }));
        }
      };

      pollRef.current = setTimeout(() => { void poll(); }, POLL_MS);
    })();
  }, [clearPoll]);

  return { ...state, start, reset };
}
