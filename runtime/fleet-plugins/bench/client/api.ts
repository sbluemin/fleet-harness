import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import type { BenchRun, BenchRubricItem, BenchVerdict } from "../server/bench-store.js";

export interface StartBenchInput {
  readonly theaterId: string;
  readonly initialPrompt: string;
  readonly contenders: ReadonlyArray<{ readonly cliId: string }>;
  readonly rubric?: readonly BenchRubricItem[];
}

export interface StartBenchResult {
  readonly run: BenchRun;
  readonly warnings: ReadonlyArray<{ code: string; term: string }>;
}

export async function startBenchRun(api: ClientApiCapability, input: StartBenchInput): Promise<StartBenchResult> {
  const res = await api.fetch("bench", "runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `start_bench_failed:${res.status}`);
  }
  return res.json() as Promise<StartBenchResult>;
}

export async function getBenchRun(api: ClientApiCapability, runId: string): Promise<BenchRun> {
  const res = await api.fetch("bench", `runs/${runId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `get_run_failed:${res.status}`);
  }
  const data = await res.json() as { run: BenchRun };
  return data.run;
}

export async function postVerdicts(api: ClientApiCapability, runId: string, verdicts: readonly BenchVerdict[], notes?: string): Promise<BenchRun> {
  const res = await api.fetch("bench", `runs/${runId}/verdicts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verdicts, notes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `post_verdicts_failed:${res.status}`);
  }
  const data = await res.json() as { run: BenchRun };
  return data.run;
}

export async function deleteBenchRun(api: ClientApiCapability, runId: string): Promise<void> {
  const res = await api.fetch("bench", `runs/${runId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `delete_run_failed:${res.status}`);
  }
}
