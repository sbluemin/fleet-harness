import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";

export interface BenchRubricItem {
  readonly id: string;
  readonly label: string;
}

export interface BenchContender {
  readonly cliId: string;
  readonly opId: string;
  readonly sessionId?: string;
}

export interface BenchVerdict {
  readonly rubricId: string;
  readonly winnerOpId: string;
}

export interface BenchRun {
  readonly runId: string;
  readonly theaterId: string;
  readonly benchOpId: string;
  readonly groupId: string;
  readonly initialPrompt: string;
  readonly rubric: readonly BenchRubricItem[];
  readonly participants: readonly BenchContender[];
  verdicts: readonly BenchVerdict[];
  readonly createdAt: string;
  updatedAt: string;
  judgedAt?: string;
}

interface StoredRuns {
  readonly version: 1;
  readonly runs: BenchRun[];
}

const STORAGE_KEY = "runs";
const PLUGIN_ID = "bench";

export interface BenchStore {
  loadRuns(): Promise<BenchRun[]>;
  saveRun(run: BenchRun): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  saveVerdicts(runId: string, verdicts: readonly BenchVerdict[], notes?: string): Promise<BenchRun | null>;
}

export function createBenchStore(storage: FleetPluginStorageHost): BenchStore {
  async function loadRuns(): Promise<BenchRun[]> {
    const raw = await storage.readJson(PLUGIN_ID, STORAGE_KEY);
    if (!raw || typeof raw !== "object") return [];
    const stored = raw as StoredRuns;
    if (stored.version !== 1 || !Array.isArray(stored.runs)) return [];
    return stored.runs;
  }

  async function writeRuns(runs: BenchRun[]): Promise<void> {
    await storage.writeJson(PLUGIN_ID, STORAGE_KEY, { version: 1, runs });
  }

  async function saveRun(run: BenchRun): Promise<void> {
    const runs = await loadRuns();
    const idx = runs.findIndex((r) => r.runId === run.runId);
    if (idx >= 0) runs[idx] = run;
    else runs.push(run);
    await writeRuns(runs);
  }

  async function deleteRun(runId: string): Promise<void> {
    const runs = await loadRuns();
    await writeRuns(runs.filter((r) => r.runId !== runId));
  }

  async function saveVerdicts(runId: string, verdicts: readonly BenchVerdict[], notes?: string): Promise<BenchRun | null> {
    const runs = await loadRuns();
    const idx = runs.findIndex((r) => r.runId === runId);
    if (idx < 0) return null;
    const now = new Date().toISOString();
    const updated: BenchRun = { ...runs[idx]!, verdicts, updatedAt: now, judgedAt: now };
    runs[idx] = updated;
    await writeRuns(runs);
    return updated;
  }

  return { loadRuns, saveRun, deleteRun, saveVerdicts };
}
