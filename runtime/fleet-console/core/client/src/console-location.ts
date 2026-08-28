/**
 * 주소 표시줄에 대한 코어의 단일 창구.
 *
 * 라우터는 컴포넌트 안에서만 잡히므로(useNavigate), 앱이 부팅할 때 그 함수를 여기에
 * 맡긴다. 플러그인 능력과 코어 비-React 코드는 이 모듈만 보고, 라우터 자체는 보지 않는다.
 *
 * `history.pushState`를 직접 부르지 않는 이유는 popstate가 발화하지 않아 라우터가
 * 이동을 놓치기 때문이다 — 주소는 바뀌었는데 화면은 그대로인 상태가 된다.
 */
type Navigate = (to: string, options?: { readonly replace?: boolean }) => void;
type Listener = () => void;

let navigate: Navigate | null = null;
const listeners = new Set<Listener>();

/** 앱 루트가 부팅 시 라우터의 navigate를 맡긴다. 반환값으로 해제한다. */
export function bindConsoleNavigate(next: Navigate): () => void {
  navigate = next;
  return () => {
    if (navigate === next) navigate = null;
  };
}

/** 라우터가 이동했음을 코어가 알린다 — popstate만으로는 앱 내부 이동을 못 듣는다. */
export function notifyConsoleLocationChanged(): void {
  for (const listener of listeners) listener();
}

export function subscribeConsoleLocation(listener: Listener): () => void {
  listeners.add(listener);
  const onPop = () => listener();
  window.addEventListener("popstate", onPop);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", onPop);
  };
}

/**
 * 쿼리 파라미터만 바꾼다. 경로는 건드리지 않는다 — 콘솔이 어느 화면에 있는지는
 * 코어의 결정이고, 플러그인이 그것을 옮기면 안 된다.
 */
export function applySearchParams(
  next: Readonly<Record<string, string | null>>,
  replace: boolean,
): void {
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  for (const [key, value] of Object.entries(next)) {
    const current = params.get(key);
    if (value === null) {
      if (current === null) continue;
      params.delete(key);
      changed = true;
      continue;
    }
    if (current === value) continue;
    params.set(key, value);
    changed = true;
  }
  if (!changed) return;

  const query = params.toString();
  const target = `${window.location.pathname}${query ? `?${query}` : ""}`;
  // 라우터가 아직 안 붙은 부팅 구간에서도 주소는 맞춰 둔다. 이때는 화면이 아직
  // 그 주소를 읽기 전이므로 replaceState로 조용히 맞추는 것이 옳다.
  if (navigate) navigate(target, { replace });
  else window.history.replaceState(null, "", target);
  notifyConsoleLocationChanged();
}
