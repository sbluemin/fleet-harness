import { localFontsPermission, localFontsSupported, queryLocalFontFamilies, watchLocalFontsPermission, type LocalFontsPermission } from "@fleet-console/font-picker/local-fonts";
import type { SystemFontRecord } from "@fleet-console/font-picker/system-fonts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { desktopLocalFontsUrl } from "../../../core/client/src/integration/desktop-shell.js";

export type DeviceFontsState =
  | { readonly status: "idle" | "loading" | "awaitingDesktop" | "denied" | "failed" | "desktopDenied" }
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

/** 권한이 'prompt'이면 사용자 클릭에서만 부른다(프롬프트에 사용자 제스처가 필요하다). 'granted'이면 제스처 없이 열거된다. */
export async function loadDeviceFonts(): Promise<void> {
  if (isBusy(state.status)) return;
  publish({ status: "loading" });
  const result = await queryLocalFontFamilies();
  publish(result.status === "loaded" ? { status: "loaded", fonts: result.fonts } : { status: result.status });
}

const DESKTOP_DIALOG_APPEAR_MS = 1500;
const DESKTOP_ANSWER_POLL_MS = 300;
const DESKTOP_ANSWER_POLLS = 10;

/**
 * Desktop이 원격 Console에 서체 목록을 내주기 전에 사용자에게 묻게 한다. 셸은 항해를 막고 부모 창 모달
 * 확인창을 띄운다. Electron은 권한 변화를 알리지 않으므로 화면은 답을 다시 물어 알아낸다.
 * - 창이 포커스를 잃으면(확인창) 되찾을 때까지 기다린다 — 사용자가 오래 열어 두어도 시간 상한은 없다.
 * - 포커스를 잃지 않았다면 셸이 이미 답을 기억하고 있거나, 확인창이 늦게 떴거나, 이 플랫폼이 blur를 주지
 *   않는 것이다. 그래서 바로 판정하지 않고 짧게 여러 번 다시 묻는다(늦게 뜬 확인창이면 다시 기다린다).
 * - 확인창이 닫히는 순간과 셸이 답을 기록하는 순간의 순서도 정해져 있지 않아, 그 경주도 같은 재조회가 흡수한다.
 * 그래도 허용이 아니면 거부로 본다. 오판이었다면 포커스·가시성 재조회와 자동 로드가 같은 화면에서 되살린다.
 */
export async function requestDesktopDeviceFonts(): Promise<void> {
  if (isBusy(state.status)) return;
  publish({ status: "awaitingDesktop" });
  await new Promise<void>((resolve) => {
    const onBlur = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { window.removeEventListener("blur", onBlur); resolve(); }, DESKTOP_DIALOG_APPEAR_MS);
    window.addEventListener("blur", onBlur, { once: true });
    location.assign(desktopLocalFontsUrl(location.origin));
  });
  let granted = false;
  for (let attempt = 0; attempt < DESKTOP_ANSWER_POLLS && !granted; attempt += 1) {
    await untilFocused();
    granted = await localFontsPermission() === "granted";
    if (!granted) await new Promise((resolve) => setTimeout(resolve, DESKTOP_ANSWER_POLL_MS));
  }
  if (!granted) {
    publish({ status: "desktopDenied" });
    return;
  }
  const result = await queryLocalFontFamilies();
  publish(result.status === "loaded" ? { status: "loaded", fonts: result.fonts } : { status: "failed" });
}

function untilFocused(): Promise<void> {
  if (document.hasFocus()) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("focus", () => resolve(), { once: true }));
}

function isBusy(status: DeviceFontsState["status"]): boolean {
  return status === "loading" || status === "awaitingDesktop";
}

/** API가 없거나 첫 조회가 끝나기 전이면 null. 권한 상태는 버튼을 보일지 정할 때만 쓴다. */
export function useDeviceFontsPermission(): LocalFontsPermission | null {
  const supported = localFontsSupported();
  const [permission, setPermission] = useState<LocalFontsPermission | null>(null);
  const status = useDeviceFonts().status;
  // 불러오기를 마칠 때마다 다시 묻는다 — 프롬프트를 닫은 경우처럼 change 이벤트 없이 바뀌는 상태도 있다.
  useEffect(() => supported ? watchLocalFontsPermission(setPermission) : undefined, [supported, status]);
  // Electron은 check 결과가 바뀌어도 change 이벤트를 내지 않는다. 확인창이 닫히거나 창으로 돌아올 때마다 다시
  // 물어, 늦게 기록된 Desktop의 답도 같은 화면에서 반영되게 한다.
  useEffect(() => {
    if (!supported) return;
    let current = true;
    const recheck = () => { void localFontsPermission().then((next) => { if (current) setPermission(next); }); };
    const onVisibility = () => { if (document.visibilityState === "visible") recheck(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      current = false;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [supported]);
  // 첫 답 전에 버튼을 세웠다가 거부로 걷으면 깜박인다 — 답이 올 때까지 없는 것으로 둔다.
  return supported ? permission : null;
}
