import { localFontsPermission, localFontsSupported, queryLocalFontFamilies, type LocalFontsPermission } from "@fleet-console/font-picker/local-fonts";
import type { SystemFontRecord } from "@fleet-console/font-picker/system-fonts";
import { useEffect, useState, useSyncExternalStore } from "react";

export type DeviceFontsState =
  | { readonly status: "idle" | "loading" | "denied" | "failed" }
  | { readonly status: "loaded"; readonly fonts: readonly SystemFontRecord[] };

/* 이 기기의 서체 목록은 핑거프린팅 표면이라 이 모듈 변수에만 산다 — 서버·설정·브라우저 저장소·로그
   어디에도 내보내지 않는다. 모듈에 두는 까닭은 설정 화면을 다시 열 때 한 번 더 누르지 않게 하려는
   것뿐이고, 새로고침하면 사라진다. */
let state: DeviceFontsState = { status: "idle" };
const listeners = new Set<() => void>();

function publish(next: DeviceFontsState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeviceFonts(): DeviceFontsState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** 사용자 클릭에서만 부른다 — 권한 프롬프트와 열거 모두 사용자 제스처를 요구한다. */
export async function loadDeviceFonts(): Promise<void> {
  if (state.status === "loading") return;
  publish({ status: "loading" });
  const result = await queryLocalFontFamilies();
  publish(result.status === "loaded" ? { status: "loaded", fonts: result.fonts } : { status: result.status });
}

/** API가 없거나 첫 조회가 끝나기 전이면 null. 권한 상태는 버튼을 보일지 정할 때만 쓴다. */
export function useDeviceFontsPermission(): LocalFontsPermission | null {
  const supported = localFontsSupported();
  const [permission, setPermission] = useState<LocalFontsPermission | null>(null);
  const status = useDeviceFonts().status;
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void localFontsPermission().then((next) => { if (!cancelled) setPermission(next); });
    return () => { cancelled = true; };
  }, [supported, status]);
  // 첫 답 전에 버튼을 세웠다가 거부로 걷으면 깜박인다 — 답이 올 때까지 없는 것으로 둔다.
  return supported ? permission : null;
}
