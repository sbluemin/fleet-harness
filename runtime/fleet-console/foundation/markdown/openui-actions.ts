/** OpenUI의 평문·대상 판정 — 원문을 정규화해서 권한을 넓히지 않는다. */
export type OpenUISendPort = (text: string) => void;
export type OpenUIOpenTarget =
  | { readonly kind: "https"; readonly url: string; readonly hostname: string }
  | { readonly kind: "objective"; readonly id: string }
  | { readonly kind: "mission"; readonly number: number };
export interface OpenUIOpenPort {
  /** 이 표면에서 열 수 있는가. 렌더 중에도 부르므로 부작용이 없어야 한다. */
  accepts(target: OpenUIOpenTarget): boolean;
  /** 사람의 클릭 하나로만 호출한다. 좌표는 호스트의 링크 열기 카드 위치다. */
  open(target: OpenUIOpenTarget, at: { readonly x: number; readonly y: number }): void;
}

export function parseOpenUIOpenTarget(raw: unknown): OpenUIOpenTarget | null {
  if (typeof raw !== "string" || !raw || raw.length > 500) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\\]/u.test(raw)) return null;
  const objective = /^objective:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(raw);
  if (objective) return Object.freeze({ kind: "objective", id: objective[1]! });
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
export function composeDraft(template: string, values: ReadonlyMap<string, string>): string | null {
  // 한 번만 치환한다. 값의 중괄호·$&는 다시 해석하지 않는다.
  // eslint-disable-next-line no-control-regex
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80);
  return sendableDraft(template.replace(/\{([a-z][a-z0-9_]{0,15})\}/g, (_, name: string) => clean(values.get(name) ?? "")));
}
