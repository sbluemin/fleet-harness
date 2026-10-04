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
const DESKTOP_UNSEEN_POLL_MS = 1000;
const DESKTOP_UNSEEN_LIMIT_MS = 120_000;
const PERMISSION_RECHECK_MIN_MS = 1000;

/**
 * Desktop이 원격 Console에 서체 목록을 내주기 전에 사용자에게 묻게 한다. 셸은 항해를 막고 부모 창 모달
 * 확인창을 띄운다. Electron은 권한 변화를 알리지 않으므로 화면은 답을 다시 물어 알아낸다.
 * - 창이 포커스를 잃으면(확인창이 뜬 것) 되찾을 때까지 기다린다 — 시간 상한은 없다. 닫힌 뒤에는 셸이 답을
 *   기록하는 순간과의 경주를 짧은 재조회로 흡수하고, 그래도 허용이 아니면 거부로 본다.
 * - 포커스를 잃지 않으면 확정하지 않는다. 확인창이 렌더러에 blur를 주지 않는 플랫폼(macOS 시트 등), 늦게 뜬
 *   확인창, 이미 답을 기억한 셸을 화면은 구별할 수 없다 — 그래서 대기 상태를 유지한 채 2분 동안 1초마다 묻고,
 *   그 사이 포커스를 잃으면 위 경로로 넘어간다. 2분이 지나도 허용이 아니면 거부로 본다.
 * 거부로 본 뒤에도 같은 화면에서 되살아난다: 권한 재조회(포커스·가시성·입력·주기)와 자동 로드가 이어받는다.
 */
export async function requestDesktopDeviceFonts(): Promise<void> {
  if (isBusy(state.status)) return;
  publish({ status: "awaitingDesktop" });
  let dialogSeen = false;
  const onBlur = () => { dialogSeen = true; };
  window.addEventListener("blur", onBlur);
  let granted = false;
  try {
    location.assign(desktopLocalFontsUrl(location.origin));
    await waitUntil(() => dialogSeen, DESKTOP_DIALOG_APPEAR_MS);
    if (dialogSeen || !document.hasFocus()) {
      granted = await answerAfterDialog();
    } else {
      const deadline = Date.now() + DESKTOP_UNSEEN_LIMIT_MS;
      while (Date.now() < deadline) {
        if (await localFontsPermission() === "granted") { granted = true; break; }
        if (dialogSeen || !document.hasFocus()) { granted = await answerAfterDialog(); break; }
        await sleep(DESKTOP_UNSEEN_POLL_MS);
      }
    }
  } finally {
    window.removeEventListener("blur", onBlur);
  }
  if (!granted) {
    publish({ status: "desktopDenied" });
    return;
  }
  const result = await queryLocalFontFamilies();
  publish(result.status === "loaded" ? { status: "loaded", fonts: result.fonts } : { status: "failed" });
}

async function answerAfterDialog(): Promise<boolean> {
  for (let attempt = 0; attempt < DESKTOP_ANSWER_POLLS; attempt += 1) {
    await untilFocused();
    if (await localFontsPermission() === "granted") return true;
    await sleep(DESKTOP_ANSWER_POLL_MS);
  }
  return false;
}

async function waitUntil(done: () => boolean, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!done() && Date.now() < deadline) await sleep(100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function untilFocused(): Promise<void> {
  if (document.hasFocus()) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("focus", () => resolve(), { once: true }));
}

function isBusy(status: DeviceFontsState["status"]): boolean {
  return status === "loading" || status === "awaitingDesktop";
}

/** 이 페이지가 지금 보이는가. 숨은 탭에서는 서체 열거가 거절되므로 자동 로드는 보일 때만 시작한다. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
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
  // 확인창이 렌더러에 포커스 이벤트를 주지 않는 플랫폼에서는 사용자의 다음 입력이 그 신호다 — 입력마다(초당 한 번까지) 묻는다.
  useEffect(() => {
    if (!supported) return;
    let current = true;
    let lastCheck = 0;
    const recheck = () => { void localFontsPermission().then((next) => { if (current) setPermission(next); }); };
    const onInput = () => {
      if (Date.now() - lastCheck < PERMISSION_RECHECK_MIN_MS) return;
      lastCheck = Date.now();
      recheck();
    };
    const onVisibility = () => { if (document.visibilityState === "visible") recheck(); };
    window.addEventListener("focus", recheck);
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("keydown", onInput, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      current = false;
      window.removeEventListener("focus", recheck);
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("keydown", onInput, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [supported]);
  // Desktop 거부로 본 뒤에도 2분 동안은 1초마다 묻는다 — 늦게 기록된 허용을 입력 없이도 받아 자동 로드로 넘긴다.
  useEffect(() => {
    if (!supported || status !== "desktopDenied") return;
    let current = true;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > DESKTOP_UNSEEN_LIMIT_MS) { clearInterval(timer); return; }
      void localFontsPermission().then((next) => { if (current) setPermission(next); });
    }, DESKTOP_UNSEEN_POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [supported, status]);
  // 첫 답 전에 버튼을 세웠다가 거부로 걷으면 깜박인다 — 답이 올 때까지 없는 것으로 둔다.
  return supported ? permission : null;
}
