import { SESSION_HOOK_INPUT_MS, SESSION_HOOK_POLICY_MS, SESSION_HOOK_OBSERVATION_MS } from "@fleet-console/protocol/session-host";

/** Immutable hook shim. The Console adapter chooses the hook vocabulary and maps its business policy. */
const args = process.argv.slice(2);
if (args[0] === "hook") args.shift();
const command = args.shift() ?? "";
const permitted = new Set(["capture-session", "turn-start", "turn-end", "workspace", "background-report", "background-spawn", "background-stop", "attention", "auto-name", "agent-call"]);
const policy = command === "agent-call";
const unavailable = "Fleet Console could not verify this delegation. Continue in the current session.";
let reason: string | null = policy ? unavailable : null;
try {
  if (!permitted.has(command)) throw new Error("session_hook_unknown");
  const origin = process.env.FLEET_SESSION_HOOK_ORIGIN;
  const token = process.env.FLEET_SESSION_HOOK_TOKEN;
  if (!origin || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("session_hook_unbound");
  const input = await new Promise<string>((resolve) => {
    let text = "";
    const done = () => { clearTimeout(timer); process.stdin.pause(); resolve(text); };
    const timer = setTimeout(done, SESSION_HOOK_INPUT_MS); timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) { text = ""; done(); } });
    process.stdin.once("end", done); process.stdin.once("error", done); process.stdin.resume();
  });
  const response = await fetch(`${origin}/${command}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ command, args, input }), signal: AbortSignal.timeout(policy ? SESSION_HOOK_POLICY_MS : SESSION_HOOK_OBSERVATION_MS) });
  if (policy && response.ok) { const body = await response.json() as { reason?: unknown }; reason = body.reason === null ? null : typeof body.reason === "string" ? body.reason : unavailable; }
} catch { /* Observational hooks never block a provider; delegation policy remains fail-closed. */ }
if (policy && reason !== null) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
