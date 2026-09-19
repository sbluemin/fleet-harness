import { readVendorSessionTitle } from "./vendor-sdk.js";

const SESSION_TITLE_TIMEOUT_MS = 5_000;

/**
 * Claude Code가 남긴 세션 기록에서 표시용 제목을 읽는다.
 *
 * 제목이 없는 세션이 정상이므로 `null`은 실패가 아니다. 실패와 지연도 `null`로 접는다 — 이 값은
 * 라벨 하나를 채울 뿐이라, 읽지 못했다고 세션 자체를 막을 이유가 없다.
 */
export async function readClaudeSessionTitle(sessionId: string, cwd: string): Promise<string | null> {
  try {
    const info = await withTimeout(readVendorSessionTitle(sessionId, cwd));
    if (!info) return null;
    const custom = normalize(info.customTitle);
    if (custom) return custom;
    const summary = normalize(info.summary);
    return summary && summary !== normalize(info.firstPrompt) ? summary : null;
  } catch {
    return null;
  }
}

function normalize(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SESSION_TITLE_TIMEOUT_MS).unref?.()),
  ]);
}
