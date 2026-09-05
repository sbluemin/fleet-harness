import { useCallback, useEffect, useRef, useState } from "react";

export type JobLogStatus = "idle" | "running" | "done" | "error";
export interface JobLogState {
  readonly status: JobLogStatus;
  readonly lines: readonly string[];
}
export interface UseJobLogReturn extends JobLogState {
  readonly start: (postUrl: string, body: Record<string, unknown>) => void;
  readonly reset: () => void;
}

const POLL_MS = 750;

export function useJobLog(): UseJobLogReturn {
  const [state, setState] = useState<JobLogState>({ status: "idle", lines: [] });
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const cancel = useCallback(() => {
    generation.current += 1;
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
    controllerRef.current?.abort();
    runningRef.current = false;
  }, []);
  useEffect(() => cancel, [cancel]);

  const reset = useCallback(() => {
    if (runningRef.current) return;
    cancel();
    setState({ status: "idle", lines: [] });
  }, [cancel]);

  const start = useCallback((postUrl: string, body: Record<string, unknown>) => {
    if (runningRef.current) return;
    cancel();
    const current = generation.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    runningRef.current = true;
    setState({ status: "running", lines: [] });
    const fail = () => {
      if (current !== generation.current) return;
      runningRef.current = false;
      setState((prev) => ({ ...prev, status: "error" }));
    };
    void (async () => {
      try {
        const res = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
        if (!res.ok) throw new Error("job_start_failed");
        const { jobId } = await res.json() as { jobId: string };
        if (typeof jobId !== "string") throw new Error("invalid_job");
        if (current !== generation.current) return;
        let cursor = 0;
        const poll = async () => {
          try {
            const response = await fetch(`/plugins/skills/jobs?jobId=${encodeURIComponent(jobId)}&cursor=${cursor}`, { signal: controller.signal });
            if (!response.ok) throw new Error("job_poll_failed");
            const data = await response.json() as { lines: string[]; nextCursor: number; status: JobLogStatus };
            if (!Array.isArray(data.lines) || !["running", "done", "error"].includes(data.status)) throw new Error("invalid_job_status");
            if (current !== generation.current) return;
            cursor = data.nextCursor;
            setState((prev) => ({ status: data.status, lines: [...prev.lines, ...data.lines] }));
            if (data.status === "running") pollRef.current = setTimeout(() => { void poll(); }, POLL_MS);
            else runningRef.current = false;
          } catch { fail(); }
        };
        pollRef.current = setTimeout(() => { void poll(); }, POLL_MS);
      } catch { fail(); }
    })();
  }, [cancel]);
  return { ...state, start, reset };
}
