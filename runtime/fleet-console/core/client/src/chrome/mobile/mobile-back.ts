/**
 * 하드웨어 뒤로의 웹 쪽 끝점(impl-spec S-51, 네이티브 브리지 `window.__fleetMobileBack`).
 * 앱이 history.back을 따로 쓰지 않고 이 함수를 불러, 브라우저의 뒤로 가드와 같은 우선순위로 처리하게 한다:
 *   1) 열린 겹침(메뉴 → 시트 → 드로어)을 맨 위부터 하나 닫는다.
 *   2) 쌓인 상세(플러그인 depth · 설정 섹션)를 하나 걷는다.
 *   3) 홈이 아닌 목적지 루트면 홈으로, 4) 홈이면 드로어를 연다.
 * 겹침·상세는 열린 동안 자기 닫기를 이 레지스트리에 올려 둔다 — 같은 일을 history 항목도 하므로(브라우저 뒤로) 두 길이 한 닫기 함수를 쓴다.
 */
interface BackLayer { readonly id: number; readonly close: () => void; readonly kind?: "drawer" }

const layers: BackLayer[] = [];
let nextId = 1;

/** 겹침·상세가 열렸다고 알린다. 반환값은 그것이 닫혔을 때 부르는 해제 함수. 나중에 올린 것이 먼저 닫힌다. */
export function pushBackLayer(close: () => void, kind?: "drawer"): () => void {
  const id = nextId++;
  layers.push({ id, close, ...(kind ? { kind } : {}) });
  return () => {
    const index = layers.findIndex((layer) => layer.id === id);
    if (index >= 0) layers.splice(index, 1);
  };
}

/** 1·2순위 — 올라와 있는 겹침/상세가 있으면 맨 위 하나를 닫고 true. */
export function closeTopBackLayer(): boolean {
  const top = layers.at(-1);
  if (!top) return false;
  top.close();
  return true;
}

declare global {
  interface Window { __fleetMobileBack?: () => boolean }
}

/** 모바일 배치가 서 있는 동안만 정의한다. `fallback`은 3·4순위(목적지 루트 → 홈 / 홈 → 드로어)다. */
export function installMobileBackBridge(fallback: () => void, atHome: () => boolean): () => void {
  const handler = (): boolean => {
    // 홈 위의 드로어 한 겹(그 위에 시트·메뉴가 없을 때)은 사실상 최상위 화면이다 — 앱에 넘겨 앱 기본(Console 목록)으로 가게 한다(false).
    // 홈이 아닌 화면 위의 드로어는 다른 겹침처럼 닫고 true.
    if (layers.at(-1)?.kind === "drawer" && atHome()) return false;
    if (closeTopBackLayer()) return true;
    fallback();
    return true;
  };
  window.__fleetMobileBack = handler;
  return () => { if (window.__fleetMobileBack === handler) delete window.__fleetMobileBack; };
}
