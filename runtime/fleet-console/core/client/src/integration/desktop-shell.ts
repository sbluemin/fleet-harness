import { useEffect, useSyncExternalStore } from "react";

/**
 * 창을 들고 있는 셸이 알려 준 "돌아갈 곳". 원격 콘솔이 서빙한 화면은 자기가 아닌 origin을
 * 스스로 알 수 없으므로, 이 값이 없으면 호스트 스위처에는 돌아가는 줄이 서지 않는다.
 *
 * 이 값은 게시한 창에만 되돌아온다. 다른 사람의 화면에 흘러가면 거기서는 그 사람의 기계를
 * 가리키기 때문이다 — 서버가 요청자를 보고 가리므로, 여기서는 읽어 오기만 한다.
 *
 * 답은 두 길로 온다. 화면이 뜨면서 한 번 묻고, 그 뒤 도착하는 게시는 Operation 스트림의
 * `desktop:shell` 이벤트로 밀려온다. 콘솔이 재기동하면 게시는 사라지고 셸이 다시 게시하는데,
 * 그 순간이 화면의 물음보다 늦으면 첫 답은 빈손이다 — 그 뒤늦은 답을 받는 길이 두 번째다.
 */
export interface DesktopShellHome {
  /** 셸이 게시한 집. 셸이 없거나 아직 게시하지 않았으면 null. */
  readonly origin: string | null;
  /** 아직 답을 받지 못했는가. */
  readonly pending: boolean;
  /** 창을 든 Desktop 앱의 버전. 셸이 없거나 옛 Desktop이면 null. */
  readonly desktopVersion: string | null;
}

type Listener = () => void;

/**
 * "아직 모른다"와 "집이 없다"는 다르다. 둘을 하나의 null로 합치면, 답이 오기 전 잠깐 동안
 * 손님 콘솔이 자기가 집인 것처럼 보인다 — 그 사이 사용자가 칩을 누르면 남의 목록이 펼쳐진다.
 */
let snapshot: DesktopShellHome = { origin: null, pending: true, desktopVersion: null };
const listeners = new Set<Listener>();

function publish(next: DesktopShellHome): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): DesktopShellHome {
  return snapshot;
}

/**
 * `reloadToken`이 바뀌면 다시 읽는다. 셸의 게시는 창을 띄우는 마감과 경주하므로 첫 읽기가 버전을
 * 놓칠 수 있다 — 그 값이 필요한 화면(도움말 메뉴)은 열릴 때 한 번 더 묻는다.
 */
export function useDesktopHomeOrigin(reloadToken = 0): DesktopShellHome {
  const home = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDesktopShell(controller.signal)
      .then((shell) => {
        // 스트림이 먼저 실어 온 집을 뒤늦은 빈 답이 지우지 않는다 — 빈 답은 "아직 게시 전"일 수 있다.
        if (shell.origin === null && snapshot.origin !== null) return;
        publish({ ...shell, pending: false });
      })
      // 끊긴 요청은 답이 아니다 — 이 화면은 이미 사라졌거나 곧 다시 묻는다.
      .catch(() => { if (!controller.signal.aborted && snapshot.pending) publish({ origin: null, pending: false, desktopVersion: null }); });
    return () => controller.abort();
  }, [reloadToken]);

  return home;
}

/** 스트림으로 도착한 게시. 빈 게시는 "모른다"이지 "집이 없다"가 아니므로 이미 아는 집을 지우지 않는다. */
export function applyDesktopShellSnapshot(value: unknown): void {
  const origin = readHomeOrigin(value);
  if (origin === null) return;
  publish({ origin, pending: false, desktopVersion: readDesktopVersion(value) ?? snapshot.desktopVersion });
}

async function fetchDesktopShell(signal?: AbortSignal): Promise<Pick<DesktopShellHome, "origin" | "desktopVersion">> {
  const response = await fetch("/api/v1/desktop/shell", { signal });
  if (!response.ok) return { origin: null, desktopVersion: null };
  const body: unknown = await response.json();
  return { origin: readHomeOrigin(body), desktopVersion: readDesktopVersion(body) };
}

function readDesktopVersion(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>).version;
  return typeof entry === "string" && entry.length > 0 ? entry : null;
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
