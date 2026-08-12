import type http from "node:http";

import type { GlobalOptionsService } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext, OperationNode } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { resolveTranscriptPath } from "./analysis-routes.js";
import { readAnalysisProviderSession } from "./provider-session.js";
import { TranscriptReaderTail, type ReaderBlock } from "./transcript-reader.js";

const AGENT_OPERATION_TYPE = "agent";
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";
/** Measured transcript flush lag is ~0.03-0.11s, so this poll is well inside the source's own latency. */
const POLL_INTERVAL_MS = 250;
const KEEPALIVE_MS = 30_000;

export const READER_ERROR_CODES = {
  disabled: "transcript_reader_disabled",
  operationNotFound: "transcript_reader_operation_not_found",
  transcriptMissing: "transcript_reader_transcript_missing",
} as const;

interface TranscriptReaderRouteDeps {
  readonly globalOptionsService: GlobalOptionsService;
  readonly pollIntervalMs?: number;
}

/** One tail per Operation, shared by every subscriber and disposed with the last one. */
interface ReaderStream {
  readonly tail: TranscriptReaderTail;
  readonly subscribers: Set<(blocks: readonly ReaderBlock[], generation: number) => void>;
  timer: ReturnType<typeof setInterval> | null;
}

export function registerTranscriptReaderRoutes(ctx: FleetPluginServerContext, deps: TranscriptReaderRouteDeps): void {
  const streams = new Map<string, ReaderStream>();
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;

  const enabled = (): boolean => {
    try {
      return deps.globalOptionsService.load().transcriptReaderEnabled === true;
    } catch {
      // Unreadable settings must fail closed: an experimental transcript surface never opens by default.
      return false;
    }
  };

  const dispose = (operationId: string): void => {
    const stream = streams.get(operationId);
    if (!stream) return;
    if (stream.timer) clearInterval(stream.timer);
    streams.delete(operationId);
  };

  registerRouter(ctx, "reader", async ({ req, res, pathname }) => {
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) {
      writeError(ctx, res, 403, READER_ERROR_CODES.disabled, "Transcript reader is not accepted by this host.");
      return true;
    }
    const suffix = pathname.slice(`${ctx.basePath}/reader`.length) || "/";
    const match = suffix.match(/^\/([^/]+)\/stream$/);
    if (!match) return false;
    if (req.method !== "GET") {
      ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    // The gate is re-read per request, so turning the switch off closes the next reader immediately.
    if (!enabled()) {
      writeError(ctx, res, 403, READER_ERROR_CODES.disabled, "Transcript reader is disabled.");
      return true;
    }
    const operationId = decodeURIComponent(match[1] ?? "");
    const operation = getAgentOperation(ctx, operationId);
    if (!operation) {
      writeError(ctx, res, 404, READER_ERROR_CODES.operationNotFound, "Operation was not found.");
      return true;
    }
    const transcriptPath = await resolveOperationTranscript(operation);
    if (!transcriptPath) {
      writeError(ctx, res, 409, READER_ERROR_CODES.transcriptMissing, "No transcript yet — send a message in this session first.");
      return true;
    }
    return handleStream(ctx, req, res, operationId, transcriptPath, streams, pollIntervalMs, dispose);
  }, [
    {
      method: "GET",
      path: "/:operationId/stream",
      summary: "Stream sanitized transcript blocks for an agent Operation.",
      category: "Terminal Plugin",
      gate: "origin-write",
      transport: "sse",
    },
  ]);

  const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
    const event = payload as { readonly pluginId?: unknown; readonly operationId?: unknown } | null;
    if (!event || event.pluginId !== ctx.pluginId || typeof event.operationId !== "string") return;
    dispose(event.operationId);
  });
  ctx.host.lifecycle.registerCleanup(async () => {
    unsubscribeDelete();
    for (const operationId of [...streams.keys()]) dispose(operationId);
  });
}

function handleStream(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  operationId: string,
  transcriptPath: string,
  streams: Map<string, ReaderStream>,
  pollIntervalMs: number,
  dispose: (operationId: string) => void,
): true {
  let stream = streams.get(operationId);
  if (!stream) {
    stream = { tail: new TranscriptReaderTail(transcriptPath), subscribers: new Set(), timer: null };
    streams.set(operationId, stream);
  }
  const active = stream;

  let closed = false;
  const write = (data: string) => {
    if (!closed && !res.writableEnded && !res.destroyed) res.write(data);
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });

  // Resume: the browser replays from the last block it holds, so a reconnect backfills rather than
  // repeating. A generation change invalidates that position and forces a full backfill.
  const resumeFrom = readLastEventId(req);

  const send = (blocks: readonly ReaderBlock[], generation: number, mode: "backfill" | "live") => {
    // `opened` already told the browser where it stands, so an empty batch carries nothing.
    if (blocks.length === 0) return;
    const last = blocks.at(-1);
    if (last) write(`id: ${generation}:${last.seq}\n`);
    write(`data: ${JSON.stringify({ type: mode, generation, blocks })}\n\n`);
  };

  const emitInitial = async () => {
    await active.tail.refresh().catch(() => []);
    const snapshot = active.tail.snapshot();
    const carryOver = resumeFrom && resumeFrom.generation === snapshot.generation ? resumeFrom.seq : 0;
    const pending = carryOver > 0 ? snapshot.blocks.filter((block) => block.seq > carryOver) : snapshot.blocks;
    write(`data: ${JSON.stringify({
      type: "opened",
      generation: snapshot.generation,
      truncated: snapshot.truncated,
      // A resumed reader keeps what it holds; a fresh one paints everything at once, with no reveal.
      reset: carryOver === 0,
    })}\n\n`);
    send(pending, snapshot.generation, "backfill");
  };

  const listener = (blocks: readonly ReaderBlock[], generation: number) => send(blocks, generation, "live");
  active.subscribers.add(listener);

  void emitInitial();

  if (!active.timer) {
    active.timer = setInterval(() => {
      void active.tail.refresh().then((appended) => {
        const snapshot = active.tail.snapshot();
        if (appended.length === 0) return;
        for (const subscriber of active.subscribers) subscriber(appended, snapshot.generation);
      }).catch(() => {
        // A transcript that disappears mid-session is not an error the browser can act on; the
        // stream stays open and resumes if the file comes back.
      });
    }, pollIntervalMs);
  }

  const keepalive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
  req.on("close", () => {
    closed = true;
    clearInterval(keepalive);
    active.subscribers.delete(listener);
    if (active.subscribers.size === 0) dispose(operationId);
  });
  return true;
}

function readLastEventId(req: http.IncomingMessage): { readonly generation: number; readonly seq: number } | null {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const [generation, seq] = value.split(":");
  const parsedGeneration = Number(generation);
  const parsedSeq = Number(seq);
  if (!Number.isSafeInteger(parsedGeneration) || !Number.isSafeInteger(parsedSeq)) return null;
  if (parsedGeneration <= 0 || parsedSeq <= 0) return null;
  return { generation: parsedGeneration, seq: parsedSeq };
}

async function resolveOperationTranscript(operation: OperationNode): Promise<string | null> {
  const providerSession = readAnalysisProviderSession(operation.payload?.providerSession);
  if (!providerSession?.transcriptPath) return null;
  return resolveTranscriptPath(providerSession.transcriptPath, operation.ts.createdAt);
}

function getAgentOperation(ctx: FleetPluginServerContext, operationId: string): OperationNode | null {
  const operation = ctx.host.operations.get(operationId);
  return operation?.pluginId === ctx.pluginId && operation.type === AGENT_OPERATION_TYPE ? operation : null;
}

function writeError(
  ctx: FleetPluginServerContext,
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  ctx.host.http.writeJson(res, status, { error: { code, message } });
}
