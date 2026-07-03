import type http from "node:http";
import crypto from "node:crypto";
import type net from "node:net";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { BenchStore, BenchRubricItem } from "./bench-store.js";
import { detectEditingKeywords } from "./warnings.js";
import { runContenderFanout, deleteFanout } from "./contender-fanout.js";

const INITIAL_PROMPT_MAX_BYTES = 16_384;
const CONTENDERS_MIN = 2;
const CONTENDERS_MAX = 4;

export function registerBenchRoutes(ctx: FleetPluginServerContext, store: BenchStore): void {
  ctx.registerRouter("runs", makeHandler(ctx, store));
}

function makeHandler(ctx: FleetPluginServerContext, store: BenchStore) {
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    const path = pathname.slice(`${ctx.basePath}/runs`.length) || "/";

    const runIdMatch = path.match(/^\/([^/]+)\/verdicts$/);
    if (runIdMatch) return handleVerdicts(req, res, runIdMatch[1]!, store, ctx);
    const deleteMatch = path.match(/^\/([^/]+)$/);

    if (path === "/" || path === "") {
      if (req.method === "GET") return handleListRuns(req, res, store, ctx);
      if (req.method === "POST") return handleCreateRun(req, res, store, ctx);
      ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (deleteMatch) {
      const runId = deleteMatch[1]!;
      if (req.method === "GET") return handleGetRun(req, res, runId, store, ctx);
      if (req.method === "DELETE") return handleDeleteRun(req, res, runId, store, ctx);
      ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    return false;
  };
}

async function handleListRuns(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  store: BenchStore,
  ctx: FleetPluginServerContext,
): Promise<boolean> {
  const runs = await store.loadRuns();
  // initialPrompt은 첫 80자 프리뷰만
  const sanitized = runs.map((r) => ({ ...r, initialPrompt: r.initialPrompt.slice(0, 80) }));
  ctx.host.http.writeJson(res, 200, { runs: sanitized });
  return true;
}

async function handleGetRun(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  store: BenchStore,
  ctx: FleetPluginServerContext,
): Promise<boolean> {
  const runs = await store.loadRuns();
  const run = runs.find((r) => r.runId === runId);
  if (!run) {
    ctx.host.http.writeJson(res, 404, { error: "run_not_found" });
    return true;
  }
  ctx.host.http.writeJson(res, 200, { run });
  return true;
}

async function handleCreateRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: BenchStore,
  ctx: FleetPluginServerContext,
): Promise<boolean> {
  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly initialPrompt?: unknown;
    readonly contenders?: unknown;
    readonly rubric?: unknown;
  }>(req);

  if (!body || typeof body.theaterId !== "string" || typeof body.initialPrompt !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_run_body" });
    return true;
  }
  if (Buffer.byteLength(body.initialPrompt, "utf8") > INITIAL_PROMPT_MAX_BYTES) {
    ctx.host.http.writeJson(res, 400, { error: "prompt_too_large" });
    return true;
  }
  if (!Array.isArray(body.contenders) || body.contenders.length < CONTENDERS_MIN || body.contenders.length > CONTENDERS_MAX) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_contenders_count" });
    return true;
  }
  const contenders = body.contenders as Array<{ cliId?: unknown }>;
  if (!contenders.every((c) => typeof c.cliId === "string")) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_contender_cli" });
    return true;
  }
  const rubric: BenchRubricItem[] = Array.isArray(body.rubric)
    ? (body.rubric as Array<{ id?: unknown; label?: unknown }>).filter((r) => typeof r.id === "string" && typeof r.label === "string").map((r) => ({ id: r.id as string, label: r.label as string }))
    : [{ id: "correctness", label: "Correctness" }, { id: "clarity", label: "Clarity" }, { id: "efficiency", label: "Efficiency" }];

  const warnings = detectEditingKeywords(body.initialPrompt);
  const serverPort = (req.socket as net.Socket).localPort ?? 0;
  if (!serverPort) {
    ctx.host.http.writeJson(res, 500, { error: "server_port_unavailable" });
    return true;
  }

  try {
    const fanout = await runContenderFanout({
      theaterId: body.theaterId,
      initialPrompt: body.initialPrompt,
      contenders: contenders as Array<{ cliId: string }>,
      rubric,
      serverPort,
    });
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const run = {
      runId,
      theaterId: body.theaterId,
      benchOpId: fanout.benchOpId,
      groupId: fanout.groupId,
      initialPrompt: body.initialPrompt,
      rubric,
      participants: fanout.participants,
      verdicts: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.saveRun(run);
    ctx.host.http.writeJson(res, 200, { run, warnings });
  } catch (err) {
    ctx.host.http.writeJson(res, 502, { error: err instanceof Error ? err.message : "fanout_failed" });
  }
  return true;
}

async function handleVerdicts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  store: BenchStore,
  ctx: FleetPluginServerContext,
): Promise<boolean> {
  if (req.method !== "POST") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = await ctx.host.http.readJsonBody<{ readonly verdicts?: unknown; readonly notes?: unknown }>(req);
  if (!body || !Array.isArray(body.verdicts)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_verdicts" });
    return true;
  }
  const verdicts = (body.verdicts as Array<{ rubricId?: unknown; winnerOpId?: unknown }>)
    .filter((v) => typeof v.rubricId === "string" && typeof v.winnerOpId === "string")
    .map((v) => ({ rubricId: v.rubricId as string, winnerOpId: v.winnerOpId as string }));
  const notes = typeof body.notes === "string" ? body.notes : undefined;
  const updated = await store.saveVerdicts(runId, verdicts, notes);
  if (!updated) {
    ctx.host.http.writeJson(res, 404, { error: "run_not_found" });
    return true;
  }
  ctx.host.http.writeJson(res, 200, { run: updated });
  return true;
}

async function handleDeleteRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  store: BenchStore,
  ctx: FleetPluginServerContext,
): Promise<boolean> {
  const runs = await store.loadRuns();
  const run = runs.find((r) => r.runId === runId);
  if (!run) {
    ctx.host.http.writeJson(res, 404, { error: "run_not_found" });
    return true;
  }
  const serverPort = (req.socket as net.Socket).localPort ?? 0;
  if (serverPort) {
    await deleteFanout(
      run.participants.map((p) => p.opId),
      run.benchOpId,
      run.groupId,
      serverPort,
    );
  }
  await store.deleteRun(runId);
  ctx.host.http.writeJson(res, 200, { ok: true });
  return true;
}
