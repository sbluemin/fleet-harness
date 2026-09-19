import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PRESSURE_INPUT_TOKENS = 256_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function textFromInput(input) {
  if (!Array.isArray(input)) return "";
  return input.map((item) => {
    if (typeof item?.content === "string") return item.content;
    if (!Array.isArray(item?.content)) return "";
    return item.content.map((part) => part?.text ?? "").join("");
  }).join("\n");
}

function classify(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const text = textFromInput(input.slice(-1));
  if (input.at(-1)?.type === "compaction_trigger") return "compact";
  if (input[0]?.type === "compaction" && input.length === 2) return "summary";
  if (text.includes("Create a detailed plaintext handoff summary for another coding agent")) return "summary";
  if (text.includes("FLEET_PRESSURE_CHECKPOINT")) return "pressure";
  if (text.includes("The durable session state is MODEL_CANARY=")) return "boundary";
  if (text.includes("Remember the exact canary MODEL_CANARY=")) return "initial";
  if (text.includes("RECALL_AUTO=") || text.includes("RECALL_MANUAL=")) return "recall";
  if (input[0]?.type === "compaction") return "replay";
  return "other";
}

function parseEvents(text) {
  const events = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

function rewritePressureUsage(text) {
  const frames = [];
  for (const frame of text.split(/(\r?\n\r?\n)/)) {
    if (!frame || /^\r?\n\r?\n$/.test(frame)) {
      frames.push(frame);
      continue;
    }
    const lines = frame.split(/\r?\n/);
    const dataIndex = lines.findIndex((line) => line.startsWith("data:"));
    if (dataIndex === -1) {
      frames.push(frame);
      continue;
    }
    const raw = lines[dataIndex].slice(5).trimStart();
    try {
      const event = JSON.parse(raw);
      if ((event.type === "response.created" || event.type === "response.completed") && event.response) {
        event.response.usage = {
          ...(event.response.usage ?? {}),
          input_tokens: PRESSURE_INPUT_TOKENS,
          cached_tokens: 0,
          output_tokens: event.response.usage?.output_tokens ?? 0,
        };
        lines[dataIndex] = `data: ${JSON.stringify(event)}`;
      }
    } catch {}
    frames.push(lines.join("\n"));
  }
  return frames.join("");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("product probe server did not expose a port"));
      else resolve(address.port);
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

export async function createProductProbeRuntime(gateway, options, trigger) {
  const target = gateway.findGatewayModel(options.model);
  if (!target || target.provider !== "codex" || gateway.upstreamModelId(target) !== "gpt-5.6-luna") {
    throw new Error(`model is not the live Luna target: ${options.model}`);
  }
  const auth = await gateway.readCodexSubscriptionAuth();
  if (!auth) throw new Error("Codex subscription credential is unavailable");
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "fleet-product-compact-"));
  const durable = gateway.createClaudeCodexCompactionStore({ directory: stateDir });
  const hookToken = randomUUID();
  const diagnostics = [];
  let expectedCanary = "";
  let expectedManualDirective = "";
  const record = (event, fields = {}) => diagnostics.push({ sequence: diagnostics.length + 1, event, ...fields });
  const store = {
    ...durable,
    recordPreCompact(input) {
      durable.recordPreCompact(input);
      record("pre_compact_hook", {
        trigger: input.trigger,
        customInstructionsPresent: !!input.customInstructions,
      });
    },
    recordPostCompact(input) {
      durable.recordPostCompact(input);
      record("post_compact_hook", {
        trigger,
        summaryBytes: Buffer.byteLength(input.summary ?? ""),
        summarySha256: input.summary ? sha256(input.summary) : null,
      });
    },
  };

  const fetchImpl = async (input, init) => {
    let requestBody;
    try { requestBody = JSON.parse(String(init?.body ?? "{}")); } catch { requestBody = {}; }
    const kind = classify(requestBody);
    record("anthropic_request", { kind });
    if (kind === "compact" && options.simulateCompactFailure) {
      record("openai_compact_failure_injected", { trigger });
      return new Response('{"error":{"type":"invalid_request_error","message":"simulated compact failure"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (kind === "compact") {
      record("openai_compact_request", {
        trigger,
        inputItems: requestBody.input?.length ?? 0,
        inputTypes: requestBody.input?.map((item) => item?.type) ?? [],
        instructionBytes: Buffer.byteLength(requestBody.instructions ?? ""),
        customInstructionsApplied: expectedManualDirective.length > 0
          && String(requestBody.instructions ?? "").includes(expectedManualDirective),
      });
    }
    const upstream = await globalThis.fetch(input, init);
    const originalText = await upstream.text();
    const text = kind === "pressure" ? rewritePressureUsage(originalText) : originalText;
    const events = parseEvents(text);
    const completed = events.findLast((event) => event?.type === "response.completed");
    if (completed) {
      record("openai_turn_completed", {
        kind,
        inputTokens: completed.response?.usage?.input_tokens ?? null,
        outputTokens: completed.response?.usage?.output_tokens ?? null,
      });
    }
    if (kind === "compact") {
      const items = events.filter((event) => event?.type === "response.output_item.done" && event.item?.type === "compaction");
      if (items.length === 1) {
        const encrypted = items[0].item.encrypted_content;
        record("openai_compact_completed", {
          status: upstream.status,
          compactionItems: 1,
          encryptedBytes: Buffer.byteLength(encrypted),
          encryptedSha256: sha256(encrypted),
        });
      }
    }
    const outputText = events.filter((event) => event?.type === "response.output_text.delta").map((event) => event.delta).join("");
    if (kind === "summary") {
      const fallback = options.simulateCompactFailure;
      if (fallback) record("claude_summary_fallback", { name: "Error", message: "simulated compact failure" });
      record(fallback ? "claude_fallback_summary_rendered" : "claude_summary_rendered", {
        outputBytes: Buffer.byteLength(outputText),
        outputSha256: sha256(outputText),
        containsCanary: expectedCanary.length > 0 && outputText.includes(expectedCanary),
        containsManualDirective: expectedManualDirective.length > 0 && outputText.includes(expectedManualDirective),
      });
    } else if (kind === "replay" || kind === "recall") {
      const compactItem = requestBody.input?.find((item) => item?.type === "compaction");
      record("openai_compaction_replayed", {
        encryptedSha256: typeof compactItem?.encrypted_content === "string" ? sha256(compactItem.encrypted_content) : null,
        outputContainsCanary: expectedCanary.length > 0 && outputText.includes(expectedCanary),
        outputContainsManualDirective: expectedManualDirective.length > 0 && outputText.includes(expectedManualDirective),
      });
    }
    return new Response(text, { status: upstream.status, headers: upstream.headers });
  };

  const router = gateway.createAiGatewayRouter({
    originator: "fleet-console",
    readAuth: () => auth,
    readCursorToken: () => null,
    readXaiToken: () => null,
    readAntigravityToken: () => null,
    fetch: fetchImpl,
    compactionStore: store,
    compactionHookToken: hookToken,
  });
  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const handled = await router.handle({ req, res, pathname });
      if (!handled && !res.writableEnded) res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
    });
  });
  const port = await listen(server);
  return {
    port,
    hookToken,
    diagnostics,
    setExpectedCanary(value) { expectedCanary = value; },
    setExpectedManualDirective(value) { expectedManualDirective = value; },
    async close() {
      await closeServer(server);
      router.dispose();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
