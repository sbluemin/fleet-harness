#!/usr/bin/env node
// Relay Claude Code's compact lifecycle to the Fleet AI Gateway that launched this process.
// The token and base URL exist only on Fleet gateway sessions; every other Claude session is a no-op.

const baseUrl = process.env.FLEET_COMPACT_BASE_URL;
const token = process.env.FLEET_COMPACT_HOOK_TOKEN;
if (!baseUrl || !token) process.exit(0);

let input = "";
for await (const chunk of process.stdin) input += chunk;
if (input.length === 0) process.exit(0);

try {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/compact-events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fleet-compact-token": token,
    },
    body: input,
    signal: AbortSignal.timeout(1_500),
  });
  await response.body?.cancel();
} catch {
  // Compaction must remain available when the host is shutting down. The gateway's
  // dedicated plaintext fallback applies only after the event was recorded.
}
