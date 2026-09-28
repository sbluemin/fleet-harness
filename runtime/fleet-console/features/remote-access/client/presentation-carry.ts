import {
  CANVAS_MODE_STORAGE_KEY,
  RAIL_ACTIVE_PANEL_STORAGE_KEY,
  RAIL_PANEL_WIDTHS_STORAGE_KEY,
  TOOLBAR_FOLDED_STORAGE_KEY,
} from "../../../core/client/src/integration/presentation-keys.js";

/**
 * 콘솔을 건너갈 때 "보던 모양"을 함께 옮기는 이월.
 *
 * 저장소는 origin마다 따로라서, 다른 콘솔로 가면 툴바 접힘·열어 둔 도구·그 폭·캔버스 모드가 그 콘솔의
 * 기억으로 돌아간다. 떠나는 화면이 이 값들을 URL fragment에 싸서 보내고, 도착한 화면은 부팅 첫 모듈에서
 * 풀어 자기 저장소에 먼저 적는다 — 스토어는 평소대로 자기 저장소를 읽으면서 이월 값을 받는다.
 *
 * 옮기는 것은 호스트와 무관한 표현 상태뿐이다. Theater·Operation id, 경로, 호스트 목록처럼 그 기계의
 * 데이터를 가리키는 값은 싣지 않는다 — 도착한 콘솔이 이쪽 구성을 알게 되면 안 된다. fragment는 서버로
 * 전송되지 않고 Referrer에도 실리지 않으며(`Referrer-Policy: no-referrer`), 읽는 즉시 주소에서 지운다.
 *
 * Desktop은 같은 접두와 한도(runtime/fleet-desktop/src/remote-bridge.ts)로 모양만 보고 그대로 옮긴다.
 */
export const PRESENTATION_CARRY_PREFIX = "#fleet-carry=";
export const PRESENTATION_CARRY_MAX_LENGTH = 2_048;
const CARRY_VERSION = 1;
const PANEL_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const MAX_PANEL_WIDTH_ENTRIES = 32;

type Scope = "local" | "session";

interface CarriedKey {
  readonly scope: Scope;
  /** 유효하면 저장할 정규화 값, 아니면 null. 모르는 모양은 조용히 버린다. */
  readonly normalize: (raw: string) => string | null;
}

const CARRIED_KEYS: Readonly<Record<string, CarriedKey>> = {
  [TOOLBAR_FOLDED_STORAGE_KEY]: { scope: "local", normalize: (raw) => (raw === "true" || raw === "false" ? raw : null) },
  [RAIL_ACTIVE_PANEL_STORAGE_KEY]: { scope: "local", normalize: (raw) => (PANEL_ID.test(raw) ? raw : null) },
  [RAIL_PANEL_WIDTHS_STORAGE_KEY]: { scope: "local", normalize: normalizePanelWidths },
  [CANVAS_MODE_STORAGE_KEY]: { scope: "session", normalize: normalizeCanvasMode },
};

interface CarryPayload {
  readonly v: number;
  readonly local?: Readonly<Record<string, unknown>>;
  readonly session?: Readonly<Record<string, unknown>>;
}

/**
 * 도착한 화면: fragment에 실려 온 값을 이 origin의 저장소에 적고 주소에서 지운다.
 * 스토어 모듈보다 먼저 불려야 한다(core/client/src/app/boot-presentation-carry.ts).
 */
export function applyIncomingPresentationCarry(): void {
  if (typeof window === "undefined" || !window.location.hash.startsWith(PRESENTATION_CARRY_PREFIX)) return;
  const encoded = window.location.hash.slice(PRESENTATION_CARRY_PREFIX.length);
  // 무엇이 실려 왔든 주소에는 남기지 않는다 — 새로고침·공유·히스토리로 다시 풀리면 안 된다.
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch { /* 주소를 못 고쳐도 적용은 한다. */ }
  const payload = decodePayload(encoded);
  if (!payload) return;
  for (const scope of ["local", "session"] as const) {
    const entries = payload[scope];
    if (!entries || typeof entries !== "object") continue;
    const storage = storageFor(scope);
    if (!storage) continue;
    for (const [key, raw] of Object.entries(entries)) {
      const carried = CARRIED_KEYS[key];
      if (!carried || carried.scope !== scope || typeof raw !== "string") continue;
      const value = carried.normalize(raw);
      if (value === null) continue;
      try { storage.setItem(key, value); } catch { /* 저장소를 못 쓰면 그 콘솔의 기억으로 선다. */ }
    }
  }
}

/** 떠나는 화면: 지금 이 origin의 표현 상태를 fragment로 싼다. 실을 것이 없거나 너무 크면 빈 문자열. */
export function buildPresentationCarryFragment(): string {
  const payload: { v: number; local: Record<string, string>; session: Record<string, string> } = { v: CARRY_VERSION, local: {}, session: {} };
  let carried = 0;
  for (const [key, spec] of Object.entries(CARRIED_KEYS)) {
    let raw: string | null = null;
    try { raw = storageFor(spec.scope)?.getItem(key) ?? null; } catch { raw = null; }
    const value = raw === null ? null : spec.normalize(raw);
    if (value === null) continue;
    payload[spec.scope][key] = value;
    carried += 1;
  }
  if (carried === 0) return "";
  const encoded = toBase64Url(JSON.stringify(payload));
  return encoded.length <= PRESENTATION_CARRY_MAX_LENGTH ? `${PRESENTATION_CARRY_PREFIX}${encoded}` : "";
}

function decodePayload(encoded: string): CarryPayload | null {
  if (encoded.length === 0 || encoded.length > PRESENTATION_CARRY_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as CarryPayload;
    return payload.v === CARRY_VERSION ? payload : null;
  } catch {
    return null;
  }
}

function normalizePanelWidths(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const widths: Record<string, number> = {};
    for (const [id, width] of Object.entries(parsed as Record<string, unknown>).slice(0, MAX_PANEL_WIDTH_ENTRIES)) {
      if (!PANEL_ID.test(id) || typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > 10_000) continue;
      widths[id] = Math.round(width);
    }
    return Object.keys(widths).length > 0 ? JSON.stringify(widths) : null;
  } catch {
    return null;
  }
}

function normalizeCanvasMode(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { readonly warRoom?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.warRoom !== "boolean") return null;
    return JSON.stringify({ warRoom: parsed.warRoom });
  } catch {
    return null;
  }
}

function storageFor(scope: Scope): Storage | null {
  try {
    return scope === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
