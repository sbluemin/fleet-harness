---
name: learning-harvest
description: Distill proven recurring friction from substantive work into reusable rules, skills, or tests, or prune stale instructions. Not for one-off incidents, speculation, or restating code/git history.
---

# Learning Harvest

Keep non-obvious learning from completed work in one retrievable, actionable home. Do not let instructions accumulate faster than signal. This skill does not add product features.

## Trigger and approval

On explicit request or after substantive work, briefly propose candidates. Do not claim an automatic hook ran. **New persistent encodings and deletions require user approval of the candidates.** Do not repeat approval for a specific update already authorized by the request.

## Candidate gate

Review actual friction, discoveries, judgment calls, and skills used. A candidate must satisfy all three:

- **Recurrence:** will the situation happen again?
- **Cost:** was the obstacle costly or non-obvious enough?
- **Generality:** does the learning apply beyond that single incident?

Discard failures. Incorrect commands or missing skill boundaries are candidates too, but one model mistake does not justify a universal model rule.

## Route to one home

| Learning | Preferred owner |
|---|---|
| Reproducible regression/defect condition | Test or automated check |
| Repeatable procedure | Existing skill; new skill only if no suitable home exists |
| Procedure-specific trap | That skill's conditional reference/gotcha |
| Stable, expensive-to-violate rule needed before scoped work | Nearest `CLAUDE.md` |
| Non-obvious rationale of an approved decision | `wiki-history` |
| User preference or working feedback | Persistent memory |

Check existing homes for duplicates first. Propose migration rather than copying when a better home exists. `CLAUDE.md` additions must pass root risk-weighted minimalism; do not accumulate handbooks or inventories. Prefer enforceable tests/scripts over prose when feasible.

## Propose, apply, verify

1. Encode each survivor concisely as `symptom → action → why (failure mode)`. Include evidence for all three conditions, the owning home, and duplicates/migration.
2. Inspect the touched surface and propose keep/update/delete dispositions too. Pruning review is required; unnecessary deletion is not.
3. Apply only approved items. Repository changes use a dedicated worktree; Wiki and memory follow their current write/approval contracts. Confirm PR publication authority separately.
4. Skill edits use narrow descriptions, conditionally loaded references, and explicit completion/stop conditions. Keep stable boundaries rather than adding model-performance claims or ceremonial investigation/testing steps.
5. Verify links, commands, and ownership. Check that the rule resolves its target case without blocking neighboring normal cases. Do not persist unverified generalizations.

If nothing survives, say so briefly and finish. Stop at proposal when awaiting approval; after authorized encoding, report locations, changes/removals, and verification. Do not prolong the task with endless retrospection or new-skill creation just to manufacture learning.
