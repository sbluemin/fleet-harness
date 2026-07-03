import { createRoot } from "react-dom/client";
import { definePlugin, defineOperationKind, React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import type { BenchRun, BenchVerdict } from "../server/bench-store.js";
import { getBenchRun, deleteBenchRun } from "./api.js";
import { BenchLaunchOverlay } from "./launch-overlay.js";
import { ContenderCard } from "./contender-card.js";
import { VerdictForm } from "./verdict-form.js";
import "./styles.css";

interface RunsListPayload {
  readonly runs: ReadonlyArray<{ readonly runId: string; readonly benchOpId: string; readonly initialPrompt: string }>;
}

const benchOperationKind = defineOperationKind({
  pluginId: "bench",
  type: "bench",
  title: "Eval Bench",
  subtitle: (op) => op.title ?? undefined,
  render: (ctx) => <BenchOperationPanel ctx={ctx} />,
});

export const benchPlugin = definePlugin({
  id: "bench",
  operationKinds: [benchOperationKind],
  launch: async (ctx) => {
    return new Promise((resolve, reject) => {
      const container = document.createElement("div");
      container.setAttribute("data-bench-launch-root", "");
      document.body.appendChild(container);

      const root = createRoot(container);

      const cleanup = () => {
        root.unmount();
        if (document.body.contains(container)) document.body.removeChild(container);
      };

      root.render(
        <BenchLaunchOverlay
          theaterId={ctx.theaterId}
          onSuccess={(id) => { cleanup(); resolve({ id }); }}
          onCancel={() => { cleanup(); reject(new Error("bench_launch_cancelled")); }}
        />,
      );
    });
  },
  closeOperation: async (operationId) => {
    try {
      const res = await fetch("/plugins/bench/runs");
      if (!res.ok) return;
      const data = await res.json() as RunsListPayload;
      const run = data.runs.find((r) => r.benchOpId === operationId);
      if (!run) return;
      await fetch(`/plugins/bench/runs/${encodeURIComponent(run.runId)}`, { method: "DELETE" });
    } catch {
      // 무시 — host가 bench op를 이후 표준 흐름으로 제거
    }
  },
});

export const plugins = [benchPlugin] as const;

function BenchOperationPanel({ ctx }: { readonly ctx: OperationRenderContext }) {
  const [run, setRun] = React.useState<BenchRun | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [verdicts, setVerdicts] = React.useState<readonly BenchVerdict[]>([]);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);

    const load = async () => {
      try {
        const res = await ctx.api.fetch("bench", "runs");
        const data = await res.json() as RunsListPayload;
        const found = data.runs.find((r) => r.benchOpId === ctx.operationId);
        if (!found || !alive) return;
        const full = await getBenchRun(ctx.api, found.runId);
        if (!alive) return;
        setRun(full);
        setVerdicts(full.verdicts);
      } catch {
        // 로드 실패 시 null 유지
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    return () => { alive = false; };
  }, [ctx.operationId, ctx.api]);

  if (loading) {
    return (
      <div className="bench-panel">
        <div className="bench-summary-card">
          <span className="bench-summary-meta">Loading…</span>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="bench-panel">
        <div className="bench-summary-card">
          <span className="bench-summary-meta">Bench run not found.</span>
        </div>
      </div>
    );
  }

  const winnerOpIds = new Set(verdicts.map((v) => v.winnerOpId));

  return (
    <div className="bench-panel">
      <div className="bench-summary-card">
        <div className="bench-summary-prompt">{run.initialPrompt}</div>
        <div className="bench-summary-meta">
          <span className="bench-status-dot" />
          <span>{run.participants.length} contenders</span>
          {run.judgedAt && <span>· Judged</span>}
        </div>
      </div>
      <div className="bench-contenders">
        {run.participants.map((p) => (
          <ContenderCard
            key={p.opId}
            contender={p}
            api={ctx.api}
            isWinner={winnerOpIds.has(p.opId)}
          />
        ))}
      </div>
      <VerdictForm
        runId={run.runId}
        rubric={run.rubric}
        participants={run.participants}
        existingVerdicts={verdicts}
        judgedAt={run.judgedAt}
        api={ctx.api}
        onVerdicted={(updated) => setVerdicts(updated)}
      />
    </div>
  );
}
