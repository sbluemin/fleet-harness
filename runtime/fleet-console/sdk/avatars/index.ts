import { isIdentityTone, type IdentityTone } from "../operations/identity-tones.js";

/**
 * 몽글 아바타 — 사령관·지휘관·구성원이 함께 쓰는 프리셋 계약.
 *
 * 베이스는 15종이다. 각 베이스는 몸 모양·정체성 톤·얼굴 디테일이 정해진 캐릭터이고, 역할은 베이스 위에 특징 하나로만 갈린다
 * (사령관은 왼쪽 위 brass 별 배지, 지휘관은 머리 위 안테나, 구성원은 베이스만). 상태는 얼굴과 몸짓이 말한다.
 *
 * 저장은 키(`theater:<id>`·`operation:<id>`) → 모습이다. 처음 읽을 때 형제와 겹치지 않는 베이스를 무작위로 뽑아 저장하고,
 * `origin` 은 그때 뽑힌 베이스라 「처음 값으로」가 돌아갈 자리다. 서버·브라우저가 같은 정제기로 읽는다.
 */

export const MONGLE_SHAPES = ["bang", "gureum", "tteok", "kong", "mul", "kkot", "dol", "sat", "egg", "mandu"] as const;
export type MongleShape = (typeof MONGLE_SHAPES)[number];

export const MONGLE_DETAILS = ["brow", "smile", "freckle", "cat", "lash", "line", "mole", "tooth"] as const;
export type MongleDetail = (typeof MONGLE_DETAILS)[number];

export interface MongleBase {
  /** 1부터 15까지. 저장되는 값이라 번호와 캐릭터의 짝은 바꾸지 않는다. */
  readonly id: number;
  readonly name: { readonly ko: string; readonly en: string };
  readonly shape: MongleShape;
  readonly tone: IdentityTone;
  readonly detail: MongleDetail;
}

export const MONGLE_BASES: readonly MongleBase[] = [
  { id: 1, name: { ko: "몽이", en: "Puff" }, shape: "bang", tone: "cerulean", detail: "brow" },
  { id: 2, name: { ko: "구름이", en: "Cloud" }, shape: "gureum", tone: "teal", detail: "smile" },
  { id: 3, name: { ko: "떡이", en: "Mochi" }, shape: "tteok", tone: "amber", detail: "freckle" },
  { id: 4, name: { ko: "콩이", en: "Bean" }, shape: "kong", tone: "plum", detail: "cat" },
  { id: 5, name: { ko: "방울이", en: "Drop" }, shape: "mul", tone: "rose", detail: "lash" },
  { id: 6, name: { ko: "꽃이", en: "Blossom" }, shape: "kkot", tone: "moss", detail: "line" },
  { id: 7, name: { ko: "돌이", en: "Pebble" }, shape: "dol", tone: "indigo", detail: "mole" },
  { id: 8, name: { ko: "사탕이", en: "Candy" }, shape: "sat", tone: "crimson", detail: "tooth" },
  { id: 9, name: { ko: "알이", en: "Egg" }, shape: "egg", tone: "moss", detail: "smile" },
  { id: 10, name: { ko: "만두", en: "Dumpling" }, shape: "mandu", tone: "cerulean", detail: "freckle" },
  { id: 11, name: { ko: "솜이", en: "Fluff" }, shape: "gureum", tone: "rose", detail: "brow" },
  { id: 12, name: { ko: "젤리", en: "Jelly" }, shape: "mul", tone: "indigo", detail: "cat" },
  { id: 13, name: { ko: "찰떡", en: "Chewy" }, shape: "tteok", tone: "crimson", detail: "lash" },
  { id: 14, name: { ko: "콩콩", en: "Beanie" }, shape: "kong", tone: "amber", detail: "tooth" },
  { id: 15, name: { ko: "꽃잎", en: "Petal" }, shape: "kkot", tone: "plum", detail: "mole" },
];

export const MONGLE_BASE_COUNT = MONGLE_BASES.length;

export function mongleBase(id: number): MongleBase {
  return MONGLE_BASES[(isMongleBaseId(id) ? id : 1) - 1]!;
}

export function isMongleBaseId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MONGLE_BASE_COUNT;
}

/** 역할 — 사령관(Theater 운영자), 지휘관(목표의 뿌리와 일반 Operation), 구성원(목표 안의 Operation). */
export type MongleRole = "commodore" | "commander" | "member";

/** 얼굴·몸짓이 말하는 상태. Console 표시 어휘(running·awaiting·unseen·idle·ended)와 목표 줄 글리프에 결정 요청·오류를 더했다. */
export type MongleState = "fresh" | "running" | "awaiting" | "decision" | "unseen" | "idle" | "ended" | "review" | "done" | "error";

/** 저장된 모습. `tone` 이 null 이면 베이스의 원래 색이다. */
export interface MongleLook {
  readonly base: number;
  readonly tone: IdentityTone | null;
  /** 처음 뽑힌 베이스 — 「처음 값으로」가 돌아갈 자리. */
  readonly origin: number;
}

export type AvatarBook = Readonly<Record<string, MongleLook>>;

const AVATAR_KEY = /^(?:theater|operation):[A-Za-z0-9._:-]{1,160}$/u;
/** 저장소가 끝없이 자라지 않게 하는 상한. 넘치면 읽기에서 뒤쪽을 버린다(다음 읽기에서 다시 뽑힌다). */
export const MAX_AVATAR_ENTRIES = 5000;

export function theaterAvatarKey(theaterId: string): string {
  return `theater:${theaterId}`;
}

export function operationAvatarKey(operationId: string): string {
  return `operation:${operationId}`;
}

export function isAvatarKey(value: unknown): value is string {
  return typeof value === "string" && AVATAR_KEY.test(value);
}

/** 모르는 값은 null — 손상된 항목은 없는 것으로 읽고, 다음 읽기에서 새로 뽑는다. */
export function sanitizeMongleLook(value: unknown): MongleLook | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isMongleBaseId(record.base)) return null;
  const tone = isIdentityTone(record.tone) ? record.tone : null;
  const origin = isMongleBaseId(record.origin) ? record.origin : record.base;
  return { base: record.base, tone, origin };
}

export function sanitizeAvatarBook(value: unknown): Record<string, MongleLook> {
  const book: Record<string, MongleLook> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return book;
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= MAX_AVATAR_ENTRIES) break;
    if (!isAvatarKey(key)) continue;
    const look = sanitizeMongleLook(entry);
    if (!look) continue;
    book[key] = look;
    count += 1;
  }
  return book;
}

/**
 * 저장값을 아직 모르거나 쓸 수 없을 때(불러오는 중·읽기 전용 접속·저장 실패) 그리는 베이스. 키에서 정해지므로 화면마다 같고,
 * 저장하지 않는다 — 무작위 배정은 쓰기 권한이 있는 클라이언트가 저장소에 남긴 값만 진실이다.
 */
export function fallbackMongleBase(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % MONGLE_BASE_COUNT) + 1;
}

/** 형제가 쓰지 않은 베이스 중 하나를 고른다. 15종을 다 쓰면 그때부터 겹침을 허용한다. */
export function pickMongleBase(taken: ReadonlySet<number>, random: () => number = Math.random): number {
  const free = MONGLE_BASES.filter((base) => !taken.has(base.id));
  const pool = free.length > 0 ? free : MONGLE_BASES;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index]!.id;
}

export const AVATARS_API_PATH = "/api/v1/avatars";

/** 쓰기 요청. `claim` 은 비어 있을 때만 저장하고(처음 배정), `set` 은 덮어쓴다(편집기). 응답은 언제나 저장된 책 전체다. */
export type AvatarWrite =
  | { readonly mode: "claim"; readonly entries: readonly { readonly key: string; readonly base: number }[] }
  | { readonly mode: "set"; readonly key: string; readonly base: number; readonly tone: IdentityTone | null };

export const MAX_AVATAR_CLAIMS = 200;

export function sanitizeAvatarWrite(value: unknown): AvatarWrite | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.mode === "claim") {
    if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > MAX_AVATAR_CLAIMS) return null;
    const entries: { key: string; base: number }[] = [];
    for (const entry of record.entries) {
      if (typeof entry !== "object" || entry === null) return null;
      const { key, base } = entry as Record<string, unknown>;
      if (!isAvatarKey(key) || !isMongleBaseId(base)) return null;
      entries.push({ key, base });
    }
    return { mode: "claim", entries };
  }
  if (record.mode === "set") {
    if (!isAvatarKey(record.key) || !isMongleBaseId(record.base)) return null;
    if (record.tone !== null && !isIdentityTone(record.tone)) return null;
    return { mode: "set", key: record.key, base: record.base, tone: record.tone as IdentityTone | null };
  }
  return null;
}

/** 쓰기를 책에 적용한다 — 서버의 락 안에서 부른다. 바뀐 것이 없으면 null(파일을 다시 쓰지 않는다). */
export function applyAvatarWrite(book: AvatarBook, write: AvatarWrite): Record<string, MongleLook> | null {
  if (write.mode === "claim") {
    let next: Record<string, MongleLook> | null = null;
    for (const entry of write.entries) {
      if (book[entry.key] || next?.[entry.key]) continue;
      if (Object.keys(next ?? book).length >= MAX_AVATAR_ENTRIES) break;
      next ??= { ...book };
      next[entry.key] = { base: entry.base, tone: null, origin: entry.base };
    }
    return next;
  }
  const current = book[write.key];
  const origin = current?.origin ?? write.base;
  if (current && current.base === write.base && current.tone === write.tone) return null;
  if (!current && Object.keys(book).length >= MAX_AVATAR_ENTRIES) return null;
  return { ...book, [write.key]: { base: write.base, tone: write.tone, origin } };
}
