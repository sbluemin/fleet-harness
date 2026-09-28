import { useSyncExternalStore } from "react";

import { useT } from "../../../core/client/src/i18n/index.js";

/**
 * 이 문서가 로컬 번들로 원격 콘솔의 데이터를 **읽기 전용**으로 보여 주는 epoch 표면인가.
 *
 * 판별은 문서 자체가 한다 — epoch 리스너만 진입 문서에 표식을 넣고, 상태 조회는 그 리스너에만 있다.
 * 평소 부팅은 표식이 없으므로 요청을 하나도 더 보내지 않는다. 이 표면에서 SPA는 쓰기·조인·목록 조회를
 * 시도하지 않고, 돌아가는 길은 셸이 가로채는 같은 origin 신호 하나뿐이다.
 */
export interface ProxyDataSurface {
  /** 표시 중인 원격 콘솔의 이름. broker가 길이와 서식 문자를 정리해 내준다. */
  readonly hostLabel: string;
}

const SURFACE_META = 'meta[name="fleet-surface"][content="proxy-data"]';
const STATE_PATH = "/api/v1/proxy/state";
const LABEL_LIMIT = 64;

let surface: ProxyDataSurface | null = null;
const listeners = new Set<() => void>();

export function isProxyDataDocument(): boolean {
  return typeof document !== "undefined" && document.querySelector(SURFACE_META) !== null;
}

/** 부팅 때 한 번. 조회가 실패해도 표면은 읽기 전용으로 남는다 — 이름만 비어 있다. */
export async function loadProxyDataSurface(): Promise<ProxyDataSurface> {
  let hostLabel = "";
  try {
    const response = await fetch(STATE_PATH, { credentials: "same-origin", cache: "no-store" });
    if (response.ok) {
      const body = await response.json() as { host?: { label?: unknown } } | null;
      const label = body?.host?.label;
      if (typeof label === "string") hostLabel = label.slice(0, LABEL_LIMIT);
    }
  } catch {
    // 이름 없이도 읽기 전용 안내와 돌아가는 칩은 선다.
  }
  surface = { hostLabel };
  document.documentElement.dataset.surface = "proxy-data";
  for (const listener of listeners) listener();
  return surface;
}

export function readProxyDataSurface(): ProxyDataSurface | null {
  return surface;
}

export function useProxyDataSurface(): ProxyDataSurface | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => surface,
    () => null,
  );
}

/**
 * 읽기 전용 안내. 이 표면에서는 쓰기 버튼이 눌려도 epoch 리스너가 404로 끝내므로, 무엇이 안 되는지와
 * 왜인지를 먼저 한 줄로 말한다 — 조용히 실패하는 버튼보다 앞서야 한다.
 */
export function ProxyDataBanner() {
  const t = useT();
  const proxy = useProxyDataSurface();
  if (proxy === null) return null;
  return (
    <div className="console-proxy-banner" role="status" aria-live="polite">
      <span>{t("chrome.proxy.readOnly", { name: proxy.hostLabel || t("chrome.proxy.unnamed") })}</span>
    </div>
  );
}
