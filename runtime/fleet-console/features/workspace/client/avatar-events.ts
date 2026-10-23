import { useEffect, useSyncExternalStore } from "react";

import type { IdentityTone } from "../shared/identity-tones.js";
import { AVATARS_API_PATH, fallbackMongleBase, MAX_AVATAR_CLAIMS, pickMongleBase, sanitizeAvatarBook, type AvatarBook, type MongleLook } from "../shared/avatars.js";

/**
 * 몽글 아바타 책의 브라우저 쪽 — 서버가 단일 진실이다.
 *
 * 호스트와 내장 플러그인 번들은 이 모듈의 사본을 따로 가질 수 있다. 사본끼리는 모듈 상태를 나누지 않고, 서버 응답을 받은 사본이
 * 문서에 `fleet-console:avatars` 사건으로 책을 알리면 다른 사본이 그 책으로 갈아탄다. 책이 아직 없거나(불러오는 중) 읽을 수 없거나
 * 쓰기 권한이 없는 접속이면 키에서 정한 베이스(`fallbackMongleBase`)를 그리고 아무것도 저장하지 않는다.
 */

const BOOK_EVENT = "fleet-console:avatars";
const RELOAD_AFTER_MS = 60_000;

let book: AvatarBook | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;
/** 쓰기가 거절된 접속(읽기 전용 원격 등)은 이번 페이지 수명 동안 배정을 다시 시도하지 않는다. */
let claimsRefused = false;
let writeChain: Promise<unknown> = Promise.resolve();
const pendingClaims = new Set<string>();
const listeners = new Set<() => void>();
let documentBound = false;

function publish(next: AvatarBook, announce: boolean): void {
  book = next;
  loadedAt = Date.now();
  for (const listener of listeners) listener();
  if (announce && typeof document !== "undefined") document.dispatchEvent(new CustomEvent(BOOK_EVENT, { detail: next }));
}

function bindDocument(): void {
  if (documentBound || typeof document === "undefined") return;
  documentBound = true;
  document.addEventListener(BOOK_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (detail === book) return;
    publish(sanitizeAvatarBook(detail), false);
  });
  // 다른 기기·창이 바꾼 것은 사건으로 오지 않는다 — 다시 보일 때 오래됐으면 새로 읽는다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - loadedAt > RELOAD_AFTER_MS) void load(true);
  });
}

async function readBook(response: Response): Promise<AvatarBook | null> {
  if (!response.ok) return null;
  try {
    const payload = await response.json() as { avatars?: unknown };
    return sanitizeAvatarBook(payload?.avatars);
  } catch {
    return null;
  }
}

function load(force = false): Promise<void> {
  bindDocument();
  if (loading) return loading;
  if (book && !force) return Promise.resolve();
  loading = (async () => {
    try {
      const next = await readBook(await fetch(AVATARS_API_PATH, { headers: { Accept: "application/json" } }));
      if (next) publish(next, true);
    } catch {
      // 읽지 못하면 키에서 정한 베이스로 그린다 — 다음 표시 때 다시 읽는다.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getBook = () => book;

/** 지금 아는 책. 아직 못 읽었으면 null 이고, 읽기를 시작한다. */
export function useAvatarBook(): AvatarBook | null {
  const current = useSyncExternalStore(subscribe, getBook, getBook);
  useEffect(() => { void load(); }, []);
  return current;
}

/** 그릴 모습. 저장값이 없으면 키에서 정한 베이스와 원래 색이다(저장하지 않는다). */
export interface ResolvedMongleLook {
  readonly base: number;
  readonly tone: IdentityTone | null;
  /** 처음 뽑힌 베이스. 저장값이 없으면 지금 베이스다. */
  readonly origin: number;
  /** 저장소에 있는 값인가. */
  readonly stored: boolean;
}

export function resolveMongleLook(current: AvatarBook | null, key: string): ResolvedMongleLook {
  const look: MongleLook | undefined = current?.[key];
  if (look) return { ...look, stored: true };
  const base = fallbackMongleBase(key);
  return { base, tone: null, origin: base, stored: false };
}

export function useMongleLook(key: string): ResolvedMongleLook {
  return resolveMongleLook(useAvatarBook(), key);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

async function write(body: unknown): Promise<AvatarBook | null> {
  const response = await fetch(AVATARS_API_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) claimsRefused = true;
  const next = await readBook(response);
  if (next) publish(next, true);
  return next;
}

/**
 * 아직 모습이 없는 키에 베이스를 뽑아 저장한다. 묶음 하나(같은 Theater 의 사령관·지휘관, 같은 목표의 구성원)는 순서대로 뽑고,
 * 이미 저장된 형제와 이번에 먼저 뽑힌 형제의 베이스는 피한다. 서버는 비어 있는 키만 받으므로 두 창이 동시에 뽑아도 먼저 닿은 쪽이 남는다.
 */
export function claimMongleLooks(groups: readonly (readonly string[])[]): Promise<void> {
  if (claimsRefused) return Promise.resolve();
  return enqueue(async () => {
    await load();
    if (!book || claimsRefused) return;
    const entries: { key: string; base: number }[] = [];
    for (const group of groups) {
      const taken = new Set<number>();
      for (const key of group) {
        const stored = book[key];
        if (stored) taken.add(stored.base);
      }
      for (const key of group) {
        if (book[key] || pendingClaims.has(key) || entries.length >= MAX_AVATAR_CLAIMS) continue;
        const base = pickMongleBase(taken);
        taken.add(base);
        entries.push({ key, base });
      }
    }
    if (entries.length === 0) return;
    for (const entry of entries) pendingClaims.add(entry.key);
    try {
      await write({ mode: "claim", entries });
    } catch {
      // 저장하지 못하면 키에서 정한 베이스로 그린다 — 다음 표시 때 다시 뽑는다.
    } finally {
      for (const entry of entries) pendingClaims.delete(entry.key);
    }
  });
}

/** 편집기의 「적용」 — 베이스와 색을 덮어쓴다. 처음 뽑힌 베이스(origin)는 서버가 지킨다. */
export function setMongleLook(key: string, base: number, tone: IdentityTone | null): Promise<boolean> {
  return enqueue(async () => {
    try {
      const next = await write({ mode: "set", key, base, tone });
      return next !== null && next[key]?.base === base && (next[key]?.tone ?? null) === tone;
    } catch {
      return false;
    }
  });
}

/** 형제가 쓰지 않은 베이스 하나 — 편집기의 「다시 뽑기」. 저장하지 않는다. */
export function drawMongleBase(current: AvatarBook | null, siblingKeys: readonly string[], exclude: number): number {
  const taken = new Set<number>([exclude]);
  for (const key of siblingKeys) {
    const look = current?.[key];
    taken.add(look ? look.base : fallbackMongleBase(key));
  }
  return pickMongleBase(taken);
}
