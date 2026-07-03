import * as React from "react";

import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import type { BenchContender, BenchRubricItem, BenchVerdict } from "../server/bench-store.js";
import { postVerdicts } from "./api.js";

interface VerdictFormProps {
  readonly runId: string;
  readonly rubric: readonly BenchRubricItem[];
  readonly participants: readonly BenchContender[];
  readonly existingVerdicts: readonly BenchVerdict[];
  readonly judgedAt?: string;
  readonly api: ClientApiCapability;
  readonly onVerdicted: (verdicts: readonly BenchVerdict[]) => void;
}

export function VerdictForm({ runId, rubric, participants, existingVerdicts, judgedAt, api, onVerdicted }: VerdictFormProps) {
  const [selections, setSelections] = React.useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const v of existingVerdicts) m.set(v.rubricId, v.winnerOpId);
    return m;
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [judged, setJudged] = React.useState(!!judgedAt);

  const allSelected = rubric.length > 0 && rubric.every((r) => selections.has(r.id));

  const handleSubmit = async () => {
    if (!allSelected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const verdicts: BenchVerdict[] = rubric
        .filter((r) => selections.has(r.id))
        .map((r) => ({ rubricId: r.id, winnerOpId: selections.get(r.id)! }));
      const updated = await postVerdicts(api, runId, verdicts);
      onVerdicted(updated.verdicts);
      setJudged(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "submit_failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bench-verdict-form">
      <h3>Verdict</h3>
      {rubric.map((item) => (
        <div key={item.id} className="bench-rubric-row">
          <span className="bench-rubric-label">{item.label}</span>
          <div className="bench-rubric-options">
            {participants.map((p) => (
              <label key={p.opId} className="bench-rubric-option">
                <input
                  type="radio"
                  name={`verdict-${item.id}`}
                  value={p.opId}
                  checked={selections.get(item.id) === p.opId}
                  onChange={() => setSelections((prev) => new Map(prev).set(item.id, p.opId))}
                />
                <span className="bench-rubric-option-label">{p.cliId}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {error && <p className="bench-launch-error" role="alert">{error}</p>}
      <div className="bench-verdict-actions">
        {judged && <span className="bench-verdict-judged-badge">Judged</span>}
        <button
          type="button"
          className="canvas-header-btn"
          disabled={!allSelected || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? "Saving…" : "Submit verdicts"}
        </button>
      </div>
    </div>
  );
}
