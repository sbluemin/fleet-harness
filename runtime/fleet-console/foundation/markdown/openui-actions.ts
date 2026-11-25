/** OpenUI의 평문·대상 판정 — 원문을 정규화해서 권한을 넓히지 않는다. */

/** OpenUI 펜스 언어 — 정식 이름은 업스트림 inline mode 관례인 `openui-lang`, `openui`는 별칭이다. */
export const OPENUI_LANGUAGES: ReadonlySet<string> = new Set(["openui-lang", "openui"]);
export type OpenUISendPort = (text: string) => void;
/** 입력창에 초안을 채워 사람이 수정한 뒤 보낼 수 있게 한다 — 바로 전송하지 않는다. */
export type OpenUIDraftPort = (text: string) => void;
export type OpenUIEntityBadgeTone = "good" | "warn" | "bad" | "wait";
export type OpenUIIdentityTone = "crimson" | "amber" | "moss" | "teal" | "cerulean" | "indigo" | "plum" | "rose";
export interface OpenUIResolvedEntity {
  /** 사람이 읽는 대상 이름(사령관 별칭·목표 제목·미션 제목·사이트 이름). */
  readonly title: string;
  /** 짧은 보조 설명(예: "Theater 미연결 · 목표 0개", "진행 중 · 3/5"). */
  readonly subtitle?: string;
  /** 짧은 상태 배지. */
  readonly badge?: string;
  readonly badgeTone?: OpenUIEntityBadgeTone;
  /** 사령관 몽글 아바타 톤. */
  readonly avatarTone?: OpenUIIdentityTone;
  /** 오른쪽 이동 라벨(예: "열기", "보드"). 없으면 기본 열기 라벨. */
  readonly actionLabel?: string;
}
export type OpenUIOpenTarget =
  | { readonly kind: "https"; readonly url: string; readonly hostname: string }
  | { readonly kind: "objective"; readonly id: string }
  | { readonly kind: "commodore"; readonly id: string }
  | { readonly kind: "mission"; readonly number: number };
export interface OpenUIOpenPort {
  /** 이 표면에서 열 수 있는가. 렌더 중에도 부르므로 부작용이 없어야 한다. */
  accepts(target: OpenUIOpenTarget): boolean;
  /** 사람의 클릭 하나로만 호출한다. 좌표는 호스트의 링크 열기 카드 위치다. */
  open(target: OpenUIOpenTarget, at: { readonly x: number; readonly y: number }): void;
  /** 대상의 현재 이름·상태·아바타 톤을 읽는다(선택). 렌더 중 호출되므로 부작용이 없어야 한다. */
  resolve?(target: OpenUIOpenTarget): OpenUIResolvedEntity | null;
}

// OAuth 동의 URL처럼 긴 실제 링크도 받는다 — 상한은 transcript 링크 추출(MAX_URL_CHARS)과 같은 8192자다.
const MAX_OPEN_TARGET = 8192;
export function parseOpenUIOpenTarget(raw: unknown): OpenUIOpenTarget | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_OPEN_TARGET) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\\]/u.test(raw)) return null;
  const internal = /^(objective|commodore):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(raw);
  if (internal) return Object.freeze({ kind: internal[1] as "objective" | "commodore", id: internal[2]! });
  const mission = /^mission:([1-9]\d{0,2})$/.exec(raw);
  if (mission) return Object.freeze({ kind: "mission", number: Number(mission[1]) });
  if (!raw.startsWith("https://")) return null;
  try {
    const url = new URL(raw);
    if (url.href !== raw || url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname)) return null;
    return Object.freeze({ kind: "https", url: raw, hostname: url.hostname });
  } catch { return null; }
}

export function sendableText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const message = value.trim();
  if (!message || message.length > max) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u.test(message)) return null;
  return message.startsWith("/") || message.startsWith("@") || /(?:^|\s)@\S*$/u.test(message) ? null : message;
}
export const sendableReply = (value: unknown): string | null => sendableText(value, 200);
export const sendableDraft = (value: unknown): string | null => sendableText(value, 480);

function cleanFieldValue(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

export function composeDraft(template: string, values: ReadonlyMap<string, string>): string | null {
  // 한 번만 치환한다. 값의 중괄호·$&는 다시 해석하지 않는다.
  return sendableDraft(template.replace(/\{([a-z][a-z0-9_]{0,15})\}/g, (_, name: string) => cleanFieldValue(values.get(name) ?? "", 80)));
}

/** 체크리스트에서 고른 항목들을 한 번만 치환해 전송 가능한 한 줄 메시지로 만든다. */
export function composeChecklistDraft(template: string, selected: readonly string[]): string | null {
  const joined = selected.map((item) => cleanFieldValue(item, 80)).filter(Boolean).join(", ");
  if (!joined) return null;
  return sendableDraft(template.replace(/\{selected\}/g, () => joined));
}
