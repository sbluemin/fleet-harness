# Handoff format and operational gotchas

### 5. Hand it over

Report in this shape — a wall of setup detail is not a handoff:

```
<url>

| Operation | State | What to look at |
|---|---|---|
| <title> | <state> | <what it demonstrates> |

## Things to try
- <one line per interaction, in the order they make sense>

## To produce a new one yourself
<the Quick Launch prompt that recreates the scenario>

## Environment
- Theater: <path> (throwaway; the agent may edit these files)
- Model: <pinned id> — spends real quota
- Data: <handoff-dir>, isolated from your usual console
- Build: <branch> (<commit>)

Stop it with PID <pid> when you are done.
```

Say which dialogs greet a fresh runtime directory (commissioning guide, What's New, then the tours) and that `Escape` clears them, or the user's first impression of the change is a modal.

## Gotchas

- **The port moves on every boot.** Re-read `console.lock` after any restart and re-send the URL; a stale port reads to the user as a broken build.
- **A rebuild needs a restart** for host changes and a reload for client changes. When you rebuild mid-handoff, restart and tell the user the URL changed.
- **The model may not do what the scenario needs.** A prompt that names a tool is a request, not a guarantee — verify the seeded state from the script's output and adjust the prompt rather than reporting an intent.
- **Quota is real and shared.** Keep seed prompts short, say which model is pinned, and do not seed more Operations than the scenario needs.
- **A fresh runtime directory exposes no gateway models in the picker.** Pinning through the environment sidesteps that, but if the user needs to switch models in the UI, they must add one under Settings → AI Gateway first.
