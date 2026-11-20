# Handoff format and operational gotchas

### 5. Hand it over

After verifying the seeded state, PID, and token-free URL, open that URL in this Objective's Fleet Browser. Do not click through the scenario. First-run dialogs stay for the user; explain them. Leave the tab and keep the isolated Console running for the handoff; after its last use the recorded session stops it, and [Run lifetime](../../console-e2e/references/setup.md#run-lifetime-and-reclamation) decides when it is reclaimed.

If Fleet Browser is unavailable, keep the Console running and report the reason with the clickable URL. Only then use the platform opener (`open <url>` on macOS, `xdg-open <url>` on Linux, or `Start-Process <url>` in Windows PowerShell), preserving tool permission gates. Do not launch agent-browser for this action. A successful opener command confirms dispatch, not that the user saw the page.

Report in this shape — a wall of setup detail is not a handoff. Include the Fleet Browser outcome (or fallback reason) and always retain the clickable URL:

```
<url>

Opened in this Objective's Fleet Browser.

| Objective | State | What to look at |
|---|---|---|
| <title> | <state> | <what it demonstrates> |

## Things to try
- <one line per interaction, in the order they make sense>

## To produce a new one yourself
<the new session prompt that recreates the scenario>

## Environment
- Theater: <path> (throwaway; the agent may edit these files)
- Model: <pinned id> — spends real quota
- Data: <handoff-dir>, isolated from your usual console
- Build: <branch> (<commit>)
- Lifetime: kept for this handoff; the objective reclaims it before completing unless you ask to keep it.
```

Send the person the lifetime line in these words: "이 콘솔은 지금 사용하실 수 있어요. 보존을 요청하지 않으면 이 목표가 끝나기 전에 정리해요." A preservation request is recorded through the reclaim entry with its reference, keeper, and release condition. Do not tell the person to stop the process by PID: a reused PID is not ownership ([restart after a forced kill](../../console-e2e/references/setup.md#restart-after-a-forced-kill)).

Say which dialogs greet a fresh runtime directory (the commissioning guide, then the "Fleet at a glance" popup) and that `Escape` clears them, or the user's first impression of the change is a modal.

## Gotchas

- **The port moves on every boot.** Re-read `console.lock` after any restart, open the new URL in Fleet Browser, and re-send it; a stale port reads to the user as a broken build.
- **A rebuild needs a restart** for host changes and a reload for client changes. When you rebuild mid-handoff, restart and tell the user the URL changed.
- **The seeded Console is a different port**, not this Console. Opening it in Fleet Browser does not attach the user's live session.
- **The model may not do what the scenario needs.** A prompt that names a tool is a request, not a guarantee — verify the seeded state from the script's output and adjust the prompt rather than reporting an intent.
- **Quota is real and shared.** Keep seed prompts short, say which model is pinned, and do not seed more Objectives than the scenario needs.
- **A fresh runtime directory exposes no gateway models in the picker.** Pinning through the environment sidesteps that, but if the user needs to switch models in the UI, they must add one under Settings → AI Gateway first.
