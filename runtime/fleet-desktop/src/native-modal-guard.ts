import type { BaseWindow } from "electron";

/**
 * Windows 에서 페이지가 띄운 네이티브 모달(WebAuthn·파일 선택·다운로드 저장 상자 등)은 소유 창을 EnableWindow(FALSE)로 잠근다.
 * 그 소유 창이 Desktop 최상위 창이면 Console·Fleet Browser 크롬·제어 알약의 클릭이 모두 그 창에 배달되지 않아,
 * 대화상자가 가려졌거나 닫을 길이 없을 때 사람이 창을 쓸 수 없게 된다.
 * 요청은 막지도 거절하지도 않고 네이티브로 그대로 흘려보낸다 — 대신 창이 잠기는 순간(WM_ENABLE, wParam=0) 곧바로 다시 켠다.
 * 대화상자는 소유 창 위에 그대로 남고, 사람은 그 동안에도 Desktop 을 조작할 수 있다.
 *
 * Electron 의 setEnabled(true)는 Electron 이 기억하는 상태(is_enabled_)와 같으면 아무 일도 하지 않는데, 외부(OS 대화상자)가 끈 창에서는
 * 그 기억이 여전히 true 라 EnableWindow(TRUE)까지 가지 않는다. 그래서 false 를 먼저 불러 기억을 바꾼 뒤(이때는 창이 이미 꺼져 있어 EnableWindow 가 나가지 않는다)
 * true 를 불러야 비로소 창이 켜진다. 이 두 번의 호출이 다시 WM_ENABLE 을 부르므로 재진입 가드가 필요하다.
 * 후킹은 창의 네이티브 메시지 표에 들어 있어 창과 함께 사라진다 — 따로 풀지 않는다.
 */
const WM_ENABLE = 0x000a;

/** Desktop 이 직접 띄운 확인 대화상자가 떠 있는 횟수 — 그 모달성은 의도이므로 그동안은 다시 켜지 않는다. */
const ownModals = new WeakMap<BaseWindow, number>();

export function keepWindowEnabled(base: BaseWindow, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  let restoring = false;
  base.hookWindowMessage(WM_ENABLE, (wParam) => {
    // wParam 이 0 이면 창이 막 꺼졌다. 켜지는 통지와 우리가 일으킨 통지는 건드리지 않는다.
    if (restoring || wParam.readUInt32LE(0) !== 0 || (ownModals.get(base) ?? 0) > 0) return;
    // 통지는 EnableWindow 안에서 오므로 그 호출이 끝난 뒤에 되돌린다.
    setImmediate(() => {
      if (base.isDestroyed() || base.isEnabled() || (ownModals.get(base) ?? 0) > 0) return;
      restoring = true;
      try {
        base.setEnabled(false);
        base.setEnabled(true);
      } finally {
        restoring = false;
      }
    });
  });
}

/**
 * Desktop 이 이 창을 부모로 직접 띄우는 확인 대화상자(콘솔 시작·관리 해제·저장한 콘솔 빼기·서체 허용)를 감싼다.
 * 이 대화상자들은 답이 나오기 전까지 창의 다른 조작(다른 콘솔로 이동, 같은 확인의 중복 열기)을 막는 것이 의도이므로,
 * 떠 있는 동안에는 `keepWindowEnabled`가 창을 다시 켜지 않는다.
 */
export async function withOwnModal<T>(base: BaseWindow, show: () => Promise<T>): Promise<T> {
  ownModals.set(base, (ownModals.get(base) ?? 0) + 1);
  try {
    return await show();
  } finally {
    const left = (ownModals.get(base) ?? 1) - 1;
    if (left > 0) ownModals.set(base, left);
    else ownModals.delete(base);
  }
}
