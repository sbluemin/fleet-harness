import { useEffect, useState } from "react";

/**
 * 창을 들고 있는 셸이 알려 준 "돌아갈 곳". 원격 콘솔이 서빙한 화면은 자기가 아닌 origin을
 * 스스로 알 수 없으므로, 이 값이 없으면 호스트 스위처에는 돌아가는 줄이 서지 않는다.
 *
 * 이 값은 게시한 창에만 되돌아온다. 다른 사람의 화면에 흘러가면 거기서는 그 사람의 기계를
 * 가리키기 때문이다 — 서버가 요청자를 보고 가리므로, 여기서는 한 번 읽어 오기만 한다.
 */
export interface DesktopShellHome {
  /** 셸이 게시한 집. 셸이 없거나 아직 게시하지 않았으면 null. */
  readonly origin: string | null;
  /** 아직 답을 받지 못했는가. */
  readonly pending: boolean;
}

/**
 * "아직 모른다"와 "집이 없다"는 다르다. 둘을 하나의 null로 합치면, 답이 오기 전 잠깐 동안
 * 손님 콘솔이 자기가 집인 것처럼 보인다 — 그 사이 사용자가 칩을 누르면 남의 목록이 펼쳐진다.
 */
export function useDesktopHomeOrigin(): DesktopShellHome {
  const [home, setHome] = useState<DesktopShellHome>({ origin: null, pending: true });

  useEffect(() => {
    const controller = new AbortController();
    void fetchDesktopHomeOrigin(controller.signal)
      .then((origin) => setHome({ origin, pending: false }))
      // 끊긴 요청은 답이 아니다 — 이 화면은 이미 사라졌거나 곧 다시 묻는다.
      .catch(() => { if (!controller.signal.aborted) setHome({ origin: null, pending: false }); });
    return () => controller.abort();
  }, []);

  return home;
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
