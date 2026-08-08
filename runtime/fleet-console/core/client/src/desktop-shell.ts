import { useEffect, useState } from "react";

/**
 * 창을 들고 있는 셸이 알려 준 "돌아갈 곳". 원격 콘솔이 서빙한 화면은 자기가 아닌 origin을
 * 스스로 알 수 없으므로, 이 값이 없으면 호스트 스위처에는 돌아가는 줄이 서지 않는다.
 *
 * 이 값은 게시한 창에만 되돌아온다. 다른 사람의 화면에 흘러가면 거기서는 그 사람의 기계를
 * 가리키기 때문이다 — 서버가 요청자를 보고 가리므로, 여기서는 한 번 읽어 오기만 한다.
 */
export function useDesktopHomeOrigin(): string | null {
  const [homeOrigin, setHomeOrigin] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDesktopHomeOrigin(controller.signal).then(setHomeOrigin).catch(() => undefined);
    return () => controller.abort();
  }, []);

  return homeOrigin;
}

export async function fetchDesktopHomeOrigin(signal?: AbortSignal): Promise<string | null> {
  const response = await fetch("/api/v1/desktop/shell", { signal });
  if (!response.ok) return null;
  return readHomeOrigin(await response.json());
}

function readHomeOrigin(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>).homeOrigin;
  if (typeof entry !== "string") return null;
  try {
    return new URL(entry).origin === entry ? entry : null;
  } catch {
    return null;
  }
}

/**
 * 이 창을 Fleet Desktop이 들고 있는가.
 *
 * 원격 콘솔로 건너가는 일은 셸의 인증서 배관을 거쳐야 성립한다. 브라우저 단독으로 그 주소에
 * 항해하면 자체서명 인증서에 막히거나 세션이 없어 401이고, 그 순간 사용자는 멀쩡히 쓰던
 * 로컬 콘솔에서 튕겨 나간다 — 그래서 셸이 없으면 그 동작을 내주지 않는다.
 */
export function isDesktopShell(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
}
