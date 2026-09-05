# Codex review activation and waiting

### Phase 3 — Await the Codex review (deterministic background poll)

The Codex automated reviewer (`chatgpt-codex-connector[bot]`) posts asynchronously. The skill **waits with a deterministic background poll that wakes you only when something real changes** — never ask the user to run `/loop` by hand, and prefer this over a fixed-interval cron that re-invokes the model every tick whether or not anything happened. A cheap `gh` loop runs in the background (no model tokens) and re-invokes you on the first genuine signal.

0. **Ensure PR metadata, any warranted changelog path, the right branch, and frozen context.** Confirm `<pr_number>`, `<repo>`, and `<headRefName>` are known. On a fresh run they come from Phase 2; on a resume entry, resolve them first via `gh pr view --json number,headRefName,url` for the current branch (or the `<pr_number>` carried in the resume prompt). Never poll or push without them. When a new release note was chosen, require the branch-named fragment on the remote head. For an amendment, require every declared pending fragment on the remote head plus the `changelog-amend` label and exact `Changelog-Amend:` body lines. Omission of a fragment needs no declaration. If the selected path is incomplete, return to Phase 1 or 2 before activating review. Then confirm the **current branch equals `<headRefName>`** (`git branch --show-current`); if it does not, stop and ask the user before editing or committing — do not auto-checkout and never commit fixes onto a non-head branch. Finally confirm the **working tree is clean** (`git status --short`); if there are unrelated uncommitted changes, stop and ask the user before editing — never overwrite them or fold pre-existing changes into a review-fix commit. Before the first review-fix, freeze the Product Context Record and set `REVIEW_BASE_HEAD` to the current pushed head SHA.
1. **Activate the initial review before waiting.** Apply this gate once per PR, before the first long-running poll. Skip it after Codex has already reacted, reviewed, commented, or been explicitly requested.
   1. Check PR-body reactions, reviews, and Codex top-level comments. Any `chatgpt-codex-connector[bot]` reaction, review, or comment means the reviewer is active; continue to step 2.
   2. If no Codex signal exists, post `@codex Please review this PR.` as a PR comment and record its comment ID, URL, and creation time. Do not start the 40-minute poll yet.
   3. For `<review_activation_timeout>` (default 60 seconds), check every ~10 seconds for a Codex reaction on either the PR body or request comment, a Codex review, or a Codex top-level comment newer than the request. Any one is activation; continue to step 2. An `eyes` reaction means active, not approved.
   4. If the bounded window expires, refresh all four surfaces once to avoid a boundary race. If no signal exists, set `REVIEW_BYPASS_REASON=codex_activation_timeout` and go directly to Phase 6. This fallback is not approval and never bypasses branch protection or required checks.
2. **Freeze the wait baseline.** Record what is *already* on the PR so the poll only fires on something new: the latest pushed head commit timestamp `HEAD_TS` (`gh api repos/<repo>/commits/<head_sha> -q .commit.committer.date`, or the time of the Phase 2 / Phase 5 push) and the current review count `BASE_REVIEWS` (`gh pr view <pr_number> --repo <repo> --json reviews -q '.reviews | length'`).
3. **Launch the background poll (signal-driven, not interval-driven).** Start one `run_in_background` Bash loop that polls with `gh` every ~30s (or `<review_poll_interval>`), capped at ~40 min, and **exits — re-invoking you — only on a genuine signal**, printing which:
   - **approval** — a `chatgpt-codex-connector[bot]` `+1` reaction on the PR body with `created_at > HEAD_TS` (fresh, not a stale carry-over);
   - **new review** — the review count exceeds `BASE_REVIEWS` (a new review pass carries its inline comments);
   - **new top-level** — a Codex top-level comment with `created_at > HEAD_TS`.
   On timeout it prints `TIMEOUT`; relaunch it. Report the background task id. Do not run model turns between signals.
   - **Re-anchor caveat — do not detect feedback by `commit_id`.** After each push GitHub re-anchors still-open review comments onto the newest commit, so an already-addressed comment reappears with `commit_id == <new head>` and would trip a false "new inline" signal. Detect new feedback by the **review count** and by **comment/reaction `created_at` vs `HEAD_TS`** only — never by matching `commit_id` to the head.
   - Reference loop (run it as the loop itself with `run_in_background: true`; its completion notification re-invokes you):
     ```bash
     REPO=<repo>; PR=<pr_number>; HEAD_TS="<iso8601 of latest push>"; BASE=<BASE_REVIEWS>
     for i in $(seq 1 80); do
       PLUS=$(gh api repos/$REPO/issues/$PR/reactions -H "Accept: application/vnd.github.squirrel-girl-preview+json" \
         -q "[.[]|select(.user.login==\"chatgpt-codex-connector[bot]\" and .content==\"+1\" and (.created_at > \"$HEAD_TS\"))]|length")
       RC=$(gh pr view $PR --repo $REPO --json reviews -q ".reviews|length")
       TOP=$(gh api repos/$REPO/issues/$PR/comments \
         -q "[.[]|select(.user.login==\"chatgpt-codex-connector[bot]\" and (.created_at > \"$HEAD_TS\"))]|length")
       [ "${PLUS:-0}" -gt 0 ] && { echo "SIGNAL=APPROVED"; exit 0; }
       [ "${RC:-$BASE}" -gt "$BASE" ] && { echo "SIGNAL=NEW_REVIEW"; exit 0; }
       [ "${TOP:-0}" -gt 0 ] && { echo "SIGNAL=NEW_TOPLEVEL"; exit 0; }
       sleep 30
     done
     echo "SIGNAL=TIMEOUT"; exit 0
     ```
     Do **not** wrap the loop in `nohup … &` — that detaches it from the harness, so its exit never re-invokes you. The `run_in_background` call itself is the only backgrounding needed.
4. **On wake, read the full state and route.** When the poll exits, read: `gh pr view <pr_number> --repo <repo> --json reviews,comments,reviewDecision`; inline comments `gh api repos/<repo>/pulls/<pr_number>/comments`; top-level comments `gh api repos/<repo>/issues/<pr_number>/comments`; PR-body reactions `gh api repos/<repo>/issues/<pr_number>/reactions -H "Accept: application/vnd.github.squirrel-girl-preview+json"`. Then:
   - **Approval = final-audit trigger.** A fresh `chatgpt-codex-connector[bot]` `+1` on the PR body (`created_at` newer than both the latest pushed head commit and the most recent `@codex` re-review comment) **and** no new actionable comments → go to Phase 6. Treat the signal as code-review completion, not product-correctness proof. A `+1` predating the latest push is stale (GitHub keeps the old reaction) — ignore it. A bare `eyes` reaction means the review is still in progress (pending), not approval.
   - **New actionable feedback** → Phase 4.
   - **Spurious wake or timeout** (only `eyes`, a re-anchored old comment, or nothing genuinely new) → relaunch the background poll (step 3) and keep waiting.

   **Stop rule — the loop must terminate on your judgment, not on the reviewer running out of ideas.** Count review passes. Go to Phase 6 as soon as a pass yields no FIX-class finding under the Judgment Policy, and by default stop after the third pass; post the declines first either way. A clean approval is not a merge requirement — Codex can always produce another suggestion, so waiting for silence is an unbounded loop. Continuing past the third pass requires naming the specific reproduced defect that justifies it. If the user has to interrupt to end the loop, the stop rule was already breached.

**Fallback — cron.** If the harness cannot re-invoke you when a background task completes, fall back to a recurring `CronCreate` (`*/1 * * * *`, `recurring: true`, prompt re-entering Phase 3 with `<pr_number>`/`<repo>`), armed exactly once; the same baseline, freshness, and re-anchor rules apply on each tick. Stop it with `CronDelete` at Phase 6 (instead of `TaskStop`).
