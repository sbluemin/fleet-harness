import { localFontsPermission, localFontsSupported, queryLocalFontFamilies, watchLocalFontsPermission, type LocalFontsPermission } from "@fleet-console/font-picker/local-fonts";
import type { SystemFontRecord } from "@fleet-console/font-picker/system-fonts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { desktopLocalFontsUrl } from "../../../core/client/src/integration/desktop-shell.js";

export type DeviceFontsState =
  | { readonly status: "idle" | "loading" | "denied" | "failed" | "desktopDenied" }
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

const DESKTOP_DIALOG_APPEAR_MS = 1500;
const DESKTOP_DIALOG_LIMIT_MS = 120_000;

/**
 * Desktop이 원격 Console에 서체 목록을 내주기 전에 사용자에게 묻게 한다. 셸이 항해를 막고 부모 창 모달
 * 확인창을 띄우므로, 창이 포커스를 잃었다 되찾으면 답이 난 것이다. 창이 포커스를 잃지 않으면 셸이 이미
 * 이 origin의 답을 기억하고 있다는 뜻이다. 허용이면 권한이 허용으로 바뀌어 사용자 제스처 없이 열거된다.
 */
export async function requestDesktopDeviceFonts(): Promise<void> {
  if (state.status === "loading") return;
  publish({ status: "loading" });
  await new Promise<void>((resolve) => {
    let dialogShown = false;
    const finish = () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      clearTimeout(appearTimer);
      clearTimeout(limitTimer);
      resolve();
    };
    const onBlur = () => { dialogShown = true; };
    const onFocus = () => { if (dialogShown) finish(); };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    const appearTimer = setTimeout(() => { if (!dialogShown) finish(); }, DESKTOP_DIALOG_APPEAR_MS);
    const limitTimer = setTimeout(finish, DESKTOP_DIALOG_LIMIT_MS);
    location.assign(desktopLocalFontsUrl(location.origin));
  });
  if (await localFontsPermission() !== "granted") {
    publish({ status: "desktopDenied" });
    return;
  }
  const result = await queryLocalFontFamilies();
  publish(result.status === "loaded" ? { status: "loaded", fonts: result.fonts } : { status: "failed" });
}

/** API가 없거나 첫 조회가 끝나기 전이면 null. 권한 상태는 버튼을 보일지 정할 때만 쓴다. */
export function useDeviceFontsPermission(): LocalFontsPermission | null {
  const supported = localFontsSupported();
  const [permission, setPermission] = useState<LocalFontsPermission | null>(null);
  const status = useDeviceFonts().status;
  // 불러오기를 마칠 때마다 다시 묻는다 — 프롬프트를 닫은 경우처럼 change 이벤트 없이 바뀌는 상태도 있다.
  useEffect(() => supported ? watchLocalFontsPermission(setPermission) : undefined, [supported, status]);
  // 첫 답 전에 버튼을 세웠다가 거부로 걷으면 깜박인다 — 답이 올 때까지 없는 것으로 둔다.
  return supported ? permission : null;
}
