import { fetchJobs, fetchTenants, openEventsStream } from "./api.js";
import { createSseFrameParser, interpretObserverFrame } from "./sse.js";
import {
  applyJobsSnapshot,
  applyObservedEvent,
  applySessionAttention,
  applySessionUpdate,
  applyTenantSnapshot,
  applyTruncation,
  setState,
} from "./store.js";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

/** observer 연결 수명을 소유한다: 초기 스냅샷 → SSE 소비 → 재연결 시 리싱크. */
export function startObserverConnection(): () => void {
  const abort = new AbortController();
  void runConnectionLoop(abort.signal);
  return () => abort.abort();
}

async function runConnectionLoop(signal: AbortSignal): Promise<void> {
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let tenantRefreshInFlight = false;

  const refreshTenantsOnce = async (): Promise<void> => {
    if (tenantRefreshInFlight) return;
    tenantRefreshInFlight = true;
    try {
      applyTenantSnapshot(await fetchTenants(signal));
    } catch {
      // 라이브 스트림이 유지되는 동안의 테넌트 목록 갱신은 best-effort다.
    } finally {
      tenantRefreshInFlight = false;
    }
  };

  while (!signal.aborted) {
    setState({ connection: "connecting" });
    try {
      await resyncSnapshots(signal);
      const reader = await openEventsStream(signal);
      setState({ connection: "live", connectionError: null });
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      await consumeStream(reader, signal, refreshTenantsOnce);
      if (!signal.aborted) setState({ connection: "connecting", connectionError: null });
    } catch (err) {
      if (signal.aborted) return;
      setState({ connection: "connecting", connectionError: err instanceof Error ? err.message : String(err) });
    }
    if (signal.aborted) return;
    await delay(reconnectDelay, signal);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

async function consumeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  onUnknownTenant: () => Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder();
  const parse = createSseFrameParser();
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) return;
    for (const frame of parse(decoder.decode(result.value, { stream: true }))) {
      const interpreted = interpretObserverFrame(frame);
      if (!interpreted) continue;
      if (interpreted.kind === "truncation" && interpreted.truncation) {
        applyTruncation(interpreted.tenantId, interpreted.tenantLabel, interpreted.truncation);
        continue;
      }
      if (interpreted.kind === "session" && interpreted.session) {
        applySessionUpdate(interpreted.session);
        continue;
      }
      if (interpreted.kind === "attention" && interpreted.session) {
        applySessionAttention(interpreted.session);
        continue;
      }
      if (interpreted.event) {
        const { unknownTenant } = applyObservedEvent(interpreted.event, interpreted.tenantLabel);
        if (unknownTenant) void onUnknownTenant();
      }
    }
  }
}

async function resyncSnapshots(signal: AbortSignal): Promise<void> {
  const [tenants, jobs] = await Promise.all([fetchTenants(signal), fetchJobs(signal)]);
  applyTenantSnapshot(tenants);
  applyJobsSnapshot(jobs);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}
