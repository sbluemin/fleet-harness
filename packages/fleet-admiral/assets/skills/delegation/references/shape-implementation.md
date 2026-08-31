# Shape — the mechanical implementation exception

The delegation skill owns whether implementation leaves the host at all; its conditions are deliberately hard to meet, and nothing here loosens them. What lives here is how the exception runs once it holds. Delegated writing's characteristic risk is not failure — a failed edit is visible — but convergence: several branches each producing something reasonable that together do not match the codebase.

## Rules

- **Fix every literal on the host first.** Of each choice ask: must the branch name a concrete value, and does it lack the convention context to justify one? Both yes means the host chooses it and passes it verbatim — design tokens, API paths, setting keys, names, error text, thresholds, constants. Skip this barrier and each branch invents its own answer.
- **Isolate every writing branch.** Parallel edits to one shared tree corrupt each other; pay the worktree cost whenever more than one branch writes.
- **Inspect artifacts, never narratives.** Read the actual diff per site. A branch's summary is evidence of what it believed, not of what it wrote — a branch that could not find its target still reports the intent as done.
- **Check returns against the literals sent.** An equivalent-looking substitution is a defect, not a variation.
- **A site needing a new decision stops.** When a branch meets a case the literals did not cover, it returns that fact instead of choosing; the host decides and restarts that branch with the value. One branch never sets precedent for the rest.
- **Reject rather than patch.** A drifted branch is re-run with a sharper prompt; hand-fixing its output hides that the prompt was insufficient, and the next site drifts the same way.
- **Keep the scope measured.** Only local, well-precedented edits were measured to land reliably; nothing establishes this for sweeping or cross-package work, where each branch sees one slice and convention drift compounds. Keep batches small, and keep structural change on the host.

## Gotchas

- **Symptom:** Every branch's diff looks plausible alone, and the assembled result is inconsistent.
  **Action:** Compare each branch against the sent literals, not against its siblings, and re-run the drifted ones.
  **Why:** Convergence failure is invisible per branch — each answer is reasonable, and only the host holds all of them.

- **Symptom:** A branch reports its batch complete, but one of its sites is untouched.
  **Action:** Trust the diff over the report and re-run that branch scoped to the missed sites.
  **Why:** A branch that could not locate a target has no way to distinguish "done" from "found nothing to do" unless the contract forces it to return the gap.
