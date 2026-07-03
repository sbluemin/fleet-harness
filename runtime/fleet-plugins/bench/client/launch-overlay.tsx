import * as React from "react";

interface AgentCliEntry {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
}

interface RubricItem {
  readonly id: string;
  readonly label: string;
}

interface BenchLaunchOverlayProps {
  readonly theaterId: string;
  readonly onSuccess: (benchOpId: string) => void;
  readonly onCancel: () => void;
}

const EDITING_KEYWORDS = ["write", "edit", "modify", "rewrite", "create", "delete", "remove", "replace", "refactor", "move", "rename"] as const;

const DEFAULT_RUBRIC: readonly RubricItem[] = [
  { id: "correctness", label: "Correctness" },
  { id: "clarity", label: "Clarity" },
  { id: "efficiency", label: "Efficiency" },
];

const PROMPT_MAX_CHARS = 16_000;
const CONTENDERS_MIN = 2;
const CONTENDERS_MAX = 4;

function detectClientKeywords(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const found: string[] = [];
  const seen = new Set<string>();
  for (const kw of EDITING_KEYWORDS) {
    if (!seen.has(kw) && new RegExp(`\\b${kw}\\b`, "i").test(lower)) {
      seen.add(kw);
      found.push(kw);
    }
  }
  return found;
}

export function BenchLaunchOverlay({ theaterId, onSuccess, onCancel }: BenchLaunchOverlayProps) {
  const [prompt, setPrompt] = React.useState("");
  const [clis, setClis] = React.useState<readonly AgentCliEntry[]>([]);
  const [selectedClis, setSelectedClis] = React.useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const editingKeywords = React.useMemo(() => detectClientKeywords(prompt), [prompt]);

  const canSubmit =
    prompt.trim().length > 0 &&
    selectedClis.size >= CONTENDERS_MIN &&
    selectedClis.size <= CONTENDERS_MAX &&
    !submitting;

  React.useEffect(() => {
    const abort = new AbortController();
    fetch("/plugins/terminal/agent/agent-cli/state", { signal: abort.signal })
      .then((r) => r.json() as Promise<{ clis?: unknown[] }>)
      .then((data) => {
        if (Array.isArray(data.clis)) setClis(data.clis as AgentCliEntry[]);
      })
      .catch(() => {});
    return () => abort.abort();
  }, []);

  const toggleCli = (id: string) => {
    setSelectedClis((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/plugins/bench/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theaterId,
          initialPrompt: prompt,
          contenders: Array.from(selectedClis).map((cliId) => ({ cliId })),
          rubric: DEFAULT_RUBRIC,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errData.error ?? `start_bench_failed:${res.status}`);
      }
      const data = await res.json() as { run: { benchOpId: string } };
      onSuccess(data.run.benchOpId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "launch_failed");
      setSubmitting(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div
      className="bench-launch-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div className="bench-launch-scrim" aria-hidden="true" onClick={onCancel} />
      <div
        className="bench-launch-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Launch Eval Bench"
      >
        <h2>Eval Bench</h2>
        <div className="bench-launch-readonly-note">
          Read-only tasks are recommended. Tasks that involve editing, deleting, or refactoring files will cause contender CLIs to make real changes — run in an isolated worktree.
        </div>
        {editingKeywords.length > 0 && (
          <div className="bench-launch-warning">
            Editing keywords detected: {editingKeywords.join(", ")}
          </div>
        )}
        <div className="bench-launch-field">
          <label htmlFor="bench-prompt">Initial prompt</label>
          <textarea
            id="bench-prompt"
            className="bench-launch-textarea"
            placeholder="Describe the task for each Agent CLI to complete…"
            rows={5}
            maxLength={PROMPT_MAX_CHARS}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />
        </div>
        <div className="bench-launch-field">
          <label>Contenders (select {CONTENDERS_MIN}–{CONTENDERS_MAX})</label>
          <div className="bench-launch-cli-grid">
            {clis.length === 0
              ? <span className="bench-launch-error">Loading CLI list…</span>
              : clis.map((cli) => (
                <label key={cli.id} className="bench-launch-cli-option">
                  <input
                    type="checkbox"
                    checked={selectedClis.has(cli.id)}
                    disabled={
                      !cli.available ||
                      (!selectedClis.has(cli.id) && selectedClis.size >= CONTENDERS_MAX)
                    }
                    onChange={() => toggleCli(cli.id)}
                  />
                  <span className="bench-launch-cli-option-label">
                    {cli.displayName}{cli.available ? "" : " (unavailable)"}
                  </span>
                </label>
              ))
            }
          </div>
        </div>
        <div className="bench-launch-field">
          <label>Rubric</label>
          <div className="bench-launch-rubric">
            {DEFAULT_RUBRIC.map((r) => <span key={r.id}>{r.label}</span>)}
          </div>
        </div>
        {error && <p className="bench-launch-error" role="alert">{error}</p>}
        <div className="bench-launch-actions">
          <button type="button" className="canvas-header-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="canvas-header-btn is-primary"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Launching…" : "Start bench"}
          </button>
        </div>
      </div>
    </div>
  );
}
