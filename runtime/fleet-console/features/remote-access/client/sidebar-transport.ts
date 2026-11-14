import { CONSOLE_SIDEBAR_EVENT, SIDEBAR_CHUNK_CHARS, SIDEBAR_MAX_BYTES, consoleSectionCommandUrl, type ConsoleSidebarReply, type ConsoleSidebarRequest } from "@fleet-console/protocol/desktop/console-section";

interface Flight { readonly console: string; readonly chunks: string[]; next: number; size: number; readonly finish: (value: Response | Error) => void }
const flights = new Map<string, Flight>();
// 한 문서의 여러 행이 셸 명령 예산을 서로 굶기지 않는다. 새 화면의 요청만 소유한다.
const queue: (() => void)[] = [];
let draining = false;
function drain(): void {
  if (draining) return;
  draining = true;
  const next = () => {
    const send = queue.shift();
    if (!send) { draining = false; return; }
    send(); window.setTimeout(next, 80);
  };
  next();
}
if (typeof window !== "undefined") window.addEventListener(CONSOLE_SIDEBAR_EVENT, (event) => {
  const value = (event as CustomEvent).detail as Partial<ConsoleSidebarReply> | null;
  if (!value || typeof value.nonce !== "string") return;
  const flight = flights.get(value.nonce);
  if (!flight || value.console !== flight.console) return;
  if (value.index !== flight.next || typeof value.data !== "string" || value.data.length > SIDEBAR_CHUNK_CHARS
    || typeof value.status !== "number" || value.status < 200 || value.status > 599 || typeof value.type !== "string" || typeof value.done !== "boolean") {
    flight.finish(new Error("sidebar_invalid_reply")); return;
  }
  flight.next++; flight.size += value.data.length;
  if (flight.size > Math.ceil(SIDEBAR_MAX_BYTES / 3) * 4) { flight.finish(new Error("sidebar_response_too_large")); return; }
  flight.chunks.push(value.data);
  if (!value.done) return;
  try {
    const text = atob(flight.chunks.join(""));
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
    flight.finish(new Response(value.status === 204 || value.status === 205 || value.status === 304 ? null : bytes, { status: value.status, headers: { "Content-Type": value.type } }));
  } catch { flight.finish(new Error("sidebar_invalid_reply")); }
});

export function sidebarRequest(console: string, operation: ConsoleSidebarRequest["operation"], body?: unknown, query?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<Response> {
  const nonce = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const finish = (result: Response | Error) => {
      if (!flights.delete(nonce)) return;
      window.clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (result instanceof Error) reject(result); else resolve(result);
    };
    flights.set(nonce, { console, chunks: [], next: 0, size: 0, finish });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = window.setTimeout(() => finish(new Error("sidebar_timeout")), 30_000);
    queue.push(() => {
      if (!flights.has(nonce)) return;
      location.assign(consoleSectionCommandUrl(location.origin, { sidebar: { console, operation, nonce,
        ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) } }));
    });
    drain();
  });
}
export async function sidebarJson<T>(console: string, operation: ConsoleSidebarRequest["operation"], body?: unknown, query?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<T> {
  const response = await sidebarRequest(console, operation, body, query, signal);
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === "object" && "error" in value ? value.error : null;
    throw new Error(typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : `sidebar_${response.status}`);
  }
  return response.json() as Promise<T>;
}
