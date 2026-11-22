import type * as http from "node:http";
import {
  DESKTOP_REMOTE_PREVIEW_FRAME_PATH,
  REMOTE_PREVIEW_AFTER_PARAM,
  REMOTE_PREVIEW_AGE_HEADER,
  REMOTE_PREVIEW_FRAME_PATH,
  REMOTE_PREVIEW_MAX_BYTES,
  REMOTE_PREVIEW_SEQ_HEADER,
  REMOTE_PREVIEW_STATE_PATH,
  REMOTE_PREVIEW_TARGET_PARAM,
  type RemotePreviewState,
  type RemotePreviewTarget,
} from "../shared/remote-preview.js";

/**
 * 원격 미리보기의 호스트 쪽 — 최신 정지 화면 1장과 그것을 기다리는 원격 full 세션들.
 *
 * 노출 범위를 이 객체가 지킨다(결정 8cd1a62d):
 * - 장은 메모리에만 있고 최신 1장뿐이다. 디스크에 쓰지 않는다.
 * - 보여 줄 대상이 없거나 바뀌었거나 호스트가 보내기를 끄면 그 즉시 장을 버리고 기다리던 요청을 끝낸다.
 * - 받아 가는 세션이 없으면 장을 받지도 들고 있지도 않는다. 호스트는 시청자 수(0/1+)를 보고 뽑기를 멈춘다.
 * - 한 세션은 기다리는 요청 하나만 가진다(새 요청이 앞 요청을 밀어낸다). 서로 다른 세션은 상한까지만.
 */

/** 동시에 받아 갈 수 있는 서로 다른 원격 세션 수. 원격 full은 보통 하나지만 다시 붙는 사이의 겹침을 견딘다. */
export const REMOTE_PREVIEW_MAX_SESSIONS = 4;
/** 마지막 요청 뒤 이 시간 안에는 아직 보는 중으로 친다 — 응답과 다음 요청 사이의 틈을 시청 종료로 읽지 않는다. */
export const REMOTE_PREVIEW_WATCH_GRACE_MS = 3000;
/** 새 장이 없을 때 한 요청이 기다리는 최대 시간. */
export const REMOTE_PREVIEW_WAIT_MS = 10_000;

export interface RemotePreviewFrame {
  readonly targetId: string;
  readonly seq: number;
  readonly at: number;
  readonly jpeg: Buffer;
}

export type RemotePreviewWatch =
  | { readonly kind: "frame"; readonly frame: RemotePreviewFrame }
  | { readonly kind: "unavailable" }
  | { readonly kind: "busy" }
  | { readonly kind: "ended" }
  | { readonly kind: "superseded" }
  | { readonly kind: "timeout" };

export type RemotePreviewAccept = "ok" | "no_target" | "stale_target" | "not_sending" | "no_viewers";

interface Waiter {
  readonly afterSeq: number;
  readonly resolve: (result: RemotePreviewWatch) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RemotePreviewHubOptions {
  /** 시청 세션 수가 바뀔 때. 호스트 Desktop에 알려 뽑기를 켜고 끈다. */
  readonly onViewersChanged: (count: number) => void;
  readonly now?: () => number;
  readonly waitMs?: number;
  readonly graceMs?: number;
  readonly maxSessions?: number;
}

export class RemotePreviewHub {
  readonly #options: RemotePreviewHubOptions;
  readonly #now: () => number;
  #target: RemotePreviewTarget | null = null;
  #sending = false;
  #frame: RemotePreviewFrame | null = null;
  #seq = 0;
  readonly #waiters = new Map<string, Waiter>();
  readonly #seen = new Map<string, number>();
  #count = 0;
  #sweep: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemotePreviewHubOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** 원격 full 구독자에게 보낼 상태. 대상이 없으면 보내기 여부도 의미가 없어 false다. */
  state(): RemotePreviewState {
    return { target: this.#target, sending: this.#target !== null && this.#sending };
  }

  viewers(): number {
    return this.#count;
  }

  /** 이 장이 찍힌 지 몇 ms 지났는가. 기기 사이 시계 차이를 타지 않으려고 응답에 나이로 싣는다. */
  age(frame: RemotePreviewFrame): number {
    return Math.max(0, this.#now() - frame.at);
  }

  /** 지금 들고 있는 장 — 테스트와 진단용. 원격 응답은 watch()만 쓴다. */
  frame(): RemotePreviewFrame | null {
    return this.#frame;
  }

  /**
   * 캡처 대상·호스트 설정이 바뀔 때마다 부른다. 대상 id가 바뀌거나 사라지거나 보내기가 꺼지면 장을 버리고
   * 기다리던 요청을 끝낸다. 원격에 보낼 상태가 달라졌으면 true.
   */
  update(target: RemotePreviewTarget | null, sending: boolean): boolean {
    const before = JSON.stringify(this.state());
    const targetChanged = (this.#target?.id ?? null) !== (target?.id ?? null);
    this.#target = target;
    this.#sending = sending;
    if (targetChanged || !this.#available()) this.#end();
    return JSON.stringify(this.state()) !== before;
  }

  /** 호스트 Desktop이 올린 장. 지금 대상의 장이고, 보내기가 켜져 있고, 받아 갈 세션이 있을 때만 받는다. */
  accept(targetId: string, jpeg: Buffer): RemotePreviewAccept {
    if (this.#target === null) return "no_target";
    if (this.#target.id !== targetId) return "stale_target";
    if (!this.#sending) return "not_sending";
    if (this.#count === 0) return "no_viewers";
    const frame: RemotePreviewFrame = { targetId, seq: ++this.#seq, at: this.#now(), jpeg };
    this.#frame = frame;
    const now = this.#now();
    for (const [session, waiter] of this.#waiters) {
      if (waiter.afterSeq >= frame.seq) continue;
      this.#waiters.delete(session);
      clearTimeout(waiter.timer);
      this.#seen.set(session, now);
      waiter.resolve({ kind: "frame", frame });
    }
    this.#recount();
    return "ok";
  }

  /** 원격 full 세션 하나가 `afterSeq` 보다 새 장을 기다린다. `signal`이 끊기면(응답 닫힘) 기다림을 거둔다. */
  watch(session: string, afterSeq: number, signal?: AbortSignal): Promise<RemotePreviewWatch> {
    if (!this.#available()) return Promise.resolve({ kind: "unavailable" });
    const active = this.#activeSessions();
    if (!active.has(session) && active.size >= (this.#options.maxSessions ?? REMOTE_PREVIEW_MAX_SESSIONS)) return Promise.resolve({ kind: "busy" });
    this.#seen.set(session, this.#now());
    const previous = this.#waiters.get(session);
    if (previous) {
      this.#waiters.delete(session);
      clearTimeout(previous.timer);
      previous.resolve({ kind: "superseded" });
    }
    const frame = this.#frame;
    if (frame && frame.seq > afterSeq) {
      this.#recount();
      return Promise.resolve({ kind: "frame", frame });
    }
    return new Promise<RemotePreviewWatch>((resolve) => {
      let settled = false;
      const finish = (result: RemotePreviewWatch) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        if (this.#waiters.get(session)?.resolve !== finish) return;
        this.#waiters.delete(session);
        clearTimeout(timer);
        this.#seen.set(session, this.#now());
        finish({ kind: "ended" });
        this.#recount();
      };
      const timer = setTimeout(() => {
        if (this.#waiters.get(session)?.resolve !== finish) return;
        this.#waiters.delete(session);
        this.#seen.set(session, this.#now());
        finish({ kind: "timeout" });
        this.#recount();
      }, this.#options.waitMs ?? REMOTE_PREVIEW_WAIT_MS);
      this.#waiters.set(session, { afterSeq, resolve: finish, timer });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      this.#recount();
    });
  }

  /** 세션이 끝났다(회수·만료). 그 세션의 기다림과 시청 흔적을 바로 지운다. */
  forgetSession(session: string): void {
    const waiter = this.#waiters.get(session);
    if (waiter) {
      this.#waiters.delete(session);
      clearTimeout(waiter.timer);
      waiter.resolve({ kind: "ended" });
    }
    this.#seen.delete(session);
    this.#recount();
  }

  dispose(): void {
    this.#end();
    if (this.#sweep) clearTimeout(this.#sweep);
    this.#sweep = null;
  }

  #available(): boolean {
    return this.#target !== null && this.#sending;
  }

  /** 장을 버리고 모든 기다림을 끝낸다. 시청 흔적도 지워 호스트가 곧바로 뽑기를 멈추게 한다. */
  #end(): void {
    this.#frame = null;
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ kind: "ended" });
    }
    this.#waiters.clear();
    this.#seen.clear();
    this.#recount();
  }

  #activeSessions(): Set<string> {
    const now = this.#now();
    const grace = this.#options.graceMs ?? REMOTE_PREVIEW_WATCH_GRACE_MS;
    for (const [session, at] of this.#seen) {
      if (!this.#waiters.has(session) && now - at >= grace) this.#seen.delete(session);
    }
    return new Set([...this.#waiters.keys(), ...this.#seen.keys()]);
  }

  #recount(): void {
    const count = this.#activeSessions().size;
    if (count === 0) this.#frame = null;
    if (count !== this.#count) {
      this.#count = count;
      this.#options.onViewersChanged(count);
    }
    this.#scheduleSweep();
  }

  /** 기다림 없이 흔적만 남은 세션은 유예가 지나면 빠진다 — 그 시점에 다시 센다. */
  #scheduleSweep(): void {
    if (this.#sweep) clearTimeout(this.#sweep);
    this.#sweep = null;
    const grace = this.#options.graceMs ?? REMOTE_PREVIEW_WATCH_GRACE_MS;
    let earliest = Number.POSITIVE_INFINITY;
    for (const [session, at] of this.#seen) if (!this.#waiters.has(session)) earliest = Math.min(earliest, at + grace);
    if (!Number.isFinite(earliest)) return;
    this.#sweep = setTimeout(() => { this.#sweep = null; this.#recount(); }, Math.max(1, earliest - this.#now()));
    this.#sweep.unref?.();
  }
}

/** 호스트 캡처 대상을 원격에 실을 모양으로 줄인다 — 창 번호·pid·창 제목은 빼고 주인과 조작자만 남긴다. */
export function toRemotePreviewTarget(target: { readonly id: string; readonly ownerKind: "objective" | "commodore"; readonly objectiveId: string | null; readonly commodoreId: string | null; readonly actor: string } | null): RemotePreviewTarget | null {
  return target ? { id: target.id, ownerKind: target.ownerKind, objectiveId: target.objectiveId, commodoreId: target.commodoreId, actor: target.actor } : null;
}

/** SSE 구독자 판정에 필요한 모양. 서버의 구독자 기록이 이 필드를 들고 있다. */
export interface RemotePreviewSubscriber {
  readonly audience: "local" | "remote";
  readonly client: "desktop" | "browser" | "objective-browser";
  /** 원격 세션의 등급. 루프백 구독자는 null이다. */
  readonly access: "full" | "monitoring" | null;
}

/** 미리보기 상태는 원격 full 화면에만 간다. monitoring·루프백·Desktop 안 네이티브 뷰는 받지 않는다. */
export function receivesRemotePreviewState(subscriber: RemotePreviewSubscriber): boolean {
  return subscriber.audience === "remote" && subscriber.access === "full" && subscriber.client !== "objective-browser";
}

/** 시청자 수는 장을 뽑는 쪽, 곧 이 Console을 띄운 로컬 Desktop에만 간다. */
export function receivesRemotePreviewViewers(subscriber: RemotePreviewSubscriber): boolean {
  return subscriber.audience === "local" && subscriber.client === "desktop";
}

export interface RemotePreviewRouteDeps {
  readonly hub: RemotePreviewHub;
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: http.IncomingMessage) => boolean;
  readonly isSameOriginConsoleRead: (req: http.IncomingMessage) => boolean;
  /** Electron 창에서 온 요청인가(클라이언트 셸 표식과 같은 UA 판정). */
  readonly isDesktopClient: (req: http.IncomingMessage) => boolean;
  /** 원격 리스너 요청의 세션. 루프백이거나 세션이 없으면 null. */
  readonly remoteSession: (req: http.IncomingMessage) => { readonly handle: string; readonly access: "full" | "monitoring" } | null;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly withSecurityHeaders: (headers: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
  /** 상태를 읽기 전에 캡처 대상·설정에 맞춘다(서버의 syncRemotePreview). */
  readonly refresh?: () => void;
}

const TARGET_ID = /^[A-Za-z0-9-]{1,64}$/u;

export function createRemotePreviewRouter(deps: RemotePreviewRouteDeps): (ctx: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }) => Promise<boolean> {
  const { hub, writeJson } = deps;
  return async ({ req, res, pathname }) => {
    if (pathname === DESKTOP_REMOTE_PREVIEW_FRAME_PATH) {
      if (!deps.isLoopbackListener(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
      if (req.method !== "POST") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!deps.isExactConsoleOrigin(req) || !deps.isDesktopClient(req)) { writeJson(res, 403, { error: "forbidden" }); return true; }
      const type = req.headers["content-type"];
      const targetId = new URL(req.url ?? "/", "http://localhost").searchParams.get(REMOTE_PREVIEW_TARGET_PARAM);
      if (typeof type !== "string" || !type.startsWith("image/jpeg") || !targetId || !TARGET_ID.test(targetId)) { writeJson(res, 400, { error: "invalid_frame" }); return true; }
      const bytes = await readRawBody(req, REMOTE_PREVIEW_MAX_BYTES);
      if (!bytes || bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) { writeJson(res, 400, { error: "invalid_frame" }); return true; }
      const outcome = hub.accept(targetId, bytes);
      if (outcome !== "ok") { writeJson(res, 409, { error: outcome }); return true; }
      res.writeHead(204, deps.withSecurityHeaders({ "Cache-Control": "no-store" }));
      res.end();
      return true;
    }
    if (pathname === REMOTE_PREVIEW_FRAME_PATH || pathname === REMOTE_PREVIEW_STATE_PATH) {
      // 호스트 화면 앞의 사람은 실시간 영상을 이미 본다. 이 경로는 원격 기기 전용이다.
      if (deps.isLoopbackListener(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
      if (req.method !== "GET") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      const session = deps.remoteSession(req);
      if (session === null) { writeJson(res, 401, { error: "unauthorized" }); return true; }
      // 결정 8cd1a62d: 보기 전용(monitoring) 기기에는 보내지 않는다. 읽기 요청이라 입장 규칙은 통과하므로 여기서 막는다.
      if (session.access !== "full") { writeJson(res, 403, { error: "preview_full_only" }); return true; }
      if (!deps.isSameOriginConsoleRead(req)) { writeJson(res, 403, { error: "forbidden" }); return true; }
      if (pathname === REMOTE_PREVIEW_STATE_PATH) {
        deps.refresh?.();
        res.setHeader("Cache-Control", "no-store");
        writeJson(res, 200, hub.state());
        return true;
      }
      const raw = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get(REMOTE_PREVIEW_AFTER_PARAM) ?? "0");
      const afterSeq = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      const result = await hub.watch(session.handle, afterSeq, controller.signal);
      res.off("close", abort);
      if (res.writableEnded || res.destroyed) return true;
      if (result.kind === "frame") {
        const { frame } = result;
        res.writeHead(200, deps.withSecurityHeaders({
          "Content-Type": "image/jpeg",
          "Content-Length": String(frame.jpeg.length),
          "Cache-Control": "no-store",
          [REMOTE_PREVIEW_SEQ_HEADER]: String(frame.seq),
          [REMOTE_PREVIEW_AGE_HEADER]: String(hub.age(frame)),
        }));
        res.end(frame.jpeg);
        return true;
      }
      if (result.kind === "unavailable") { writeJson(res, 409, { error: "preview_unavailable" }); return true; }
      if (result.kind === "busy") { writeJson(res, 429, { error: "preview_busy" }); return true; }
      res.writeHead(204, deps.withSecurityHeaders({ "Cache-Control": "no-store" }));
      res.end();
      return true;
    }
    return false;
  };
}

async function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) return null;
    chunks.push(buffer);
  }
  return chunks.length === 0 ? null : Buffer.concat(chunks);
}
