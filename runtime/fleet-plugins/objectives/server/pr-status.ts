import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { prTarget, RESULT_LIMITS, type PrObservation } from "./results.js";
import type { ObjectiveStore } from "./store.js";

export type PrErrorCode = Extract<PrObservation, { state: "error" }>["error"]["code"];
export type PrLookupResult = { readonly state: "open" | "merged" | "closed"; readonly title?: string } | { readonly error: PrErrorCode; readonly retryAt?: number };
export type PrLookup = (url: string, signal: AbortSignal) => Promise<PrLookupResult>;

const execute = promisify(execFile);
type Execute = (args: readonly string[], signal: AbortSignal) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** 이미 인증된 gh만 사용한다. 로그인·자격증명 추출·공개 API fallback은 없다. */
export function createGhPrLookup(options: { readonly cwd: string; readonly execute?: Execute }): PrLookup {
  const run: Execute = options.execute ?? (async (args, signal) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", PAGER: "cat" };
    delete env.GH_DEBUG;
    delete env.GH_FORCE_TTY;
    return execute("gh", [...args], { cwd: options.cwd, env, signal, timeout: RESULT_LIMITS.prTimeoutMs, maxBuffer: RESULT_LIMITS.prResponseBytes, shell: false, windowsHide: true });
  });
  return async (url, signal) => {
    const target = prTarget(url);
    const args = ["api", "--hostname", "github.com", "--include", `repos/${target.owner}/${target.repo}/pulls/${target.number}`];
    try {
      const response = await run(args, signal);
      const parsed = responseParts(response.stdout);
      if (parsed.status !== null && parsed.status !== 200) return classifyFailure(response.stdout, response.stderr);
      try {
        const body = JSON.parse(parsed.body) as { title?: unknown; state?: unknown; merged?: unknown; merged_at?: unknown; number?: unknown; html_url?: unknown };
        if (body.number !== target.number || typeof body.html_url !== "string" || prTarget(body.html_url).url !== target.url || typeof body.merged !== "boolean" || (body.state !== "open" && body.state !== "closed")) return { error: "invalid_response" };
        const cleaned = typeof body.title === "string" ? body.title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, RESULT_LIMITS.prTitle) : "";
        const title = cleaned ? { title: cleaned } : {};
        if (body.merged) return body.state === "closed" && typeof body.merged_at === "string" ? { state: "merged", ...title } : { error: "invalid_response" };
        return body.merged_at === null ? { state: body.state, ...title } : { error: "invalid_response" };
      } catch { return { error: "invalid_response" }; }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
      if (failure.code === "ENOENT") return { error: "gh_unavailable" };
      if (failure.killed || failure.code === "ABORT_ERR" || signal.aborted) return { error: "timeout" };
      return classifyFailure(failure.stdout ?? "", failure.stderr ?? "");
    }
  };
}

function responseParts(stdout: string): { status: number | null; headers: string; body: string } {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(normalized);
  if (!status) return { status: null, headers: "", body: normalized };
  const split = normalized.indexOf("\n\n");
  return { status: Number(status[1]), headers: split >= 0 ? normalized.slice(0, split) : normalized, body: split >= 0 ? normalized.slice(split + 2) : "" };
}

function classifyFailure(stdout: string, stderr: string): PrLookupResult {
  const { status, headers } = responseParts(stdout);
  const detail = `${stdout}\n${stderr}`;
  if (status === 429 || /rate limit|secondary rate|abuse detection/i.test(detail)) {
    const reset = /^x-ratelimit-reset:\s*(\d+)/im.exec(headers);
    const retry = /^retry-after:\s*(\d+)/im.exec(headers);
    const retryAt = retry ? Date.now() + Number(retry[1]) * 1000 : reset ? Number(reset[1]) * 1000 : undefined;
    return { error: "rate_limited", ...(retryAt !== undefined && Number.isFinite(retryAt) ? { retryAt } : {}) };
  }
  if (status === 401 || /gh auth login|not logged|authentication|requires authentication|bad credentials|GH_TOKEN/i.test(detail)) return { error: "auth_required" };
  if (status === 404 || /HTTP 404/i.test(detail)) return { error: "not_found_or_forbidden" };
  if (status === 403 || /HTTP 403/i.test(detail)) return { error: "forbidden" };
  if (/timed? out|timeout|deadline exceeded/i.test(detail)) return { error: "timeout" };
  if (/could not resolve|no such host|failed to connect|connection (refused|reset)|network|dial tcp|TLS handshake|error connecting/i.test(detail)) return { error: "network" };
  return { error: "lookup_failed" };
}

export interface PrStatusService {
  /** 읽기·등록·수정이 stale 대상의 자동 조회를 깨운다. backoff와 single-flight는 그대로 지킨다. */
  refresh(objectiveId?: string): void;
  dispose(): Promise<void>;
}

/** 화면/구성원 세션이 아닌 플러그인의 수명이다. canonical PR 하나를 여러 목표가 공유해도 요청은 하나다. */
export function createPrStatusService(store: ObjectiveStore, options: { readonly lookup: PrLookup; readonly now?: () => number; readonly onError?: (code: string) => void }): PrStatusService {
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const attempts = new Map<string, { nextAt: number; failures: number; observation: PrObservation }>();
  const queued = new Set<string>();
  const flights = new Map<string, Promise<void>>();
  let stopped = false;
  let scanning = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const targets = () => store.all().flatMap((objective) => objective.results.flatMap((result) => result.kind === "pr" ? [{ objectiveId: objective.id, done: !!objective.done, result }] : []));
  const report = () => options.onError?.("pr_status_storage_failed");
  const pump = () => {
    if (stopped) return;
    for (const url of queued) {
      if (flights.size >= RESULT_LIMITS.prConcurrency) break;
      queued.delete(url);
      const flight = Promise.resolve().then(async () => {
        let found: ReturnType<typeof targets>;
        try { found = targets().filter((entry) => entry.result.url === url); } catch { report(); return; }
        if (!found.length || stopped) return;
        let answer: PrLookupResult;
        try { answer = await options.lookup(url, controller.signal); }
        catch { answer = { error: "lookup_failed" }; }
        if (stopped) return;
        const checkedAt = now();
        const failures = "error" in answer ? (attempts.get(url)?.failures ?? 0) + 1 : 0;
        const delay = "error" in answer ? RESULT_LIMITS.prBackoffMs[Math.min(failures - 1, RESULT_LIMITS.prBackoffMs.length - 1)]! : answer.state === "merged" || found.every((entry) => entry.done) ? RESULT_LIMITS.prSettledRefreshMs : RESULT_LIMITS.prRefreshMs;
        const previous = attempts.get(url)?.observation ?? [...found].sort((a, b) => (b.result.observation.checkedAt ?? 0) - (a.result.observation.checkedAt ?? 0))[0]!.result.observation;
        const lastSuccess = previous.state === "open" || previous.state === "merged" || previous.state === "closed" ? { state: previous.state, checkedAt: previous.checkedAt } : previous.lastSuccess;
        const observation: PrObservation = "error" in answer
          ? { state: "error", checkedAt, stale: false, ...(previous.title ? { title: previous.title } : {}), error: { code: answer.error }, ...(lastSuccess ? { lastSuccess } : {}) }
          : { state: answer.state, checkedAt, stale: false, ...(answer.title ? { title: answer.title } : {}), lastSuccess: { state: answer.state, checkedAt } };
        attempts.set(url, { nextAt: Math.max(checkedAt + delay, "error" in answer ? answer.retryAt ?? 0 : 0), failures, observation });
        // 기다리는 동안 삭제·URL 교체·다른 목표의 참조 추가가 있었을 수 있다. 지금 그 PR을 가리키는 항목만 쓴다.
        try {
          for (const entry of targets().filter((candidate) => candidate.result.url === url)) store.resultObserved(entry.objectiveId, entry.result.id, url, observation);
        } catch { report(); }
      }).finally(() => { flights.delete(url); pump(); arm(); });
      flights.set(url, flight);
    }
  };
  const refresh = (objectiveId?: string) => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const current = targets();
      const active = new Set(current.map((entry) => entry.result.url));
      for (const url of attempts.keys()) if (!active.has(url)) attempts.delete(url);
      for (const url of queued) if (!active.has(url)) queued.delete(url);
      for (const entry of current) {
        if (objectiveId !== undefined && entry.objectiveId !== objectiveId) continue;
        if (flights.has(entry.result.url)) continue;
        const attempted = attempts.get(entry.result.url);
        const interval = entry.done || attempted?.observation.state === "merged" ? RESULT_LIMITS.prSettledRefreshMs : RESULT_LIMITS.prRefreshMs;
        const nextAt = attempted && attempted.failures === 0 ? Math.min(attempted.nextAt, (attempted.observation.checkedAt ?? 0) + interval) : attempted?.nextAt ?? 0;
        if (attempted) attempted.nextAt = nextAt;
        if (attempted && nextAt > now()) {
          // 새 참조는 같은 PR의 이번 프로세스 내 최신 관측을 공유한다. 조회 실패 backoff도 건너뛰지 않는다.
          if (entry.result.observation.state === "unchecked") store.resultObserved(entry.objectiveId, entry.result.id, entry.result.url, attempted.observation);
          continue;
        }
        if (!entry.result.observation.stale) store.resultObserved(entry.objectiveId, entry.result.id, entry.result.url, { ...entry.result.observation, stale: true });
        queued.add(entry.result.url);
      }
    } catch { report(); }
    finally { scanning = false; }
    pump();
    arm();
  };
  // 응답이 끝난 시각의 nextAt에 맞춘다. 고정 60초 tick은 네트워크 지연만큼 due를 지나쳐 120초 간격이 된다.
  const arm = () => {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    const due = [...attempts].filter(([url]) => !flights.has(url) && !queued.has(url)).map(([, attempt]) => attempt.nextAt);
    const delay = due.length ? Math.max(1, Math.min(...due) - now()) : RESULT_LIMITS.prRefreshMs;
    timer = setTimeout(() => refresh(), delay);
    timer.unref?.();
  };
  refresh();
  return {
    refresh,
    async dispose() { stopped = true; if (timer) clearTimeout(timer); queued.clear(); controller.abort(); await Promise.allSettled(flights.values()); flights.clear(); attempts.clear(); },
  };
}
