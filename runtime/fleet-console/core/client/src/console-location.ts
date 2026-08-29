/**
 * 주소 표시줄에 대한 코어의 단일 창구.
 *
 * 라우터는 컴포넌트 안에서만 잡히므로(useNavigate), 앱이 부팅할 때 그 함수를 여기에
 * 맡긴다. 플러그인 능력과 코어 비-React 코드는 이 모듈만 보고, 라우터 자체는 보지 않는다.
 *
 * `history.pushState`를 직접 부르지 않는 이유는 popstate가 발화하지 않아 라우터가
 * 이동을 놓치기 때문이다 — 주소는 바뀌었는데 화면은 그대로인 상태가 된다.
 */
type Navigate = (to: { readonly search: string }, options?: { readonly replace?: boolean }) => void;
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
  const search = query ? `?${query}` : "";
  // 라우터에는 **쿼리만** 건넨다. `location.pathname`은 basename(`/console`)을 이미 품고
  // 있어서, 그대로 넘기면 라우터가 basename을 한 번 더 붙여 `/console/console/...`이 된다 —
  // 콘솔은 없는 경로로 떨어지고 화면이 빈 껍데기가 된다.
  // 라우터가 아직 안 붙은 부팅 구간에서만 절대 경로로 직접 맞춘다(그때는 basename을
  // 붙일 라우터가 없으므로 pathname이 정확하다).
  if (navigate) navigate({ search }, { replace });
  else window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  notifyConsoleLocationChanged();
}
