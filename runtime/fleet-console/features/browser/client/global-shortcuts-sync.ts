import { React } from "@fleet-console/sdk/plugin/browser";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { CORE_SHORTCUT_COMMANDS, resolveShortcutChords, useShortcutOverrides } from "../../../core/client/src/integration/shortcut-bindings.js";

/**
 * Desktop 단축키 중계 동기화(리뷰 B).
 *
 * 네이티브 뷰에 포커스가 있으면 Console 단축키가 렌더러에 닿지 않으므로,
 * 클라이언트가 현재 유효 조합(사용자 재배정 반영, shortcut-bindings 단일 출처)을
 * `POST /api/v1/browser/shortcuts`로 서버에 알리고, 서버는 스냅샷 선택 필드
 * `shortcuts`로 셸에 싣는다. 옛 셸은 모르는 필드를 무시하고, 옛 Console은
 * 필드를 싣지 않아 새 셸이 중계하지 않는다.
 *
 * companion 토글(Alt+B)은 CORE 목록 밖에 있어 기본값을 함께 싣는다.
 * 사용자 재배정 companion 코드는 별도 후속(명령 열거)으로 둔다.
 * 서버 경로가 아직 없으면(호스트 구현 중) 조용히 실패하고, 다음 포그라운드에서 다시 시도한다.
 */

let lastSent = "";
let lastOk = false;

async function sendShortcuts(shortcuts: readonly string[]): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/browser/shortcuts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcuts }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function useGlobalBrowserShortcutsSync(active: boolean): void {
  const overrides = useShortcutOverrides();
  React.useEffect(() => {
    if (!active || !isDesktopShell()) return;
    const chords = new Set<string>();
    for (const command of CORE_SHORTCUT_COMMANDS) {
      for (const chord of resolveShortcutChords(command.id)) chords.add(chord);
    }
    chords.add("Alt+KeyB");
    const body = JSON.stringify([...chords]);
    if (body === lastSent && lastOk) return;
    lastSent = body;
    void sendShortcuts([...chords]).then((ok) => { lastOk = ok; });
  }, [active, overrides]);
  // 실패했으면 다음 포그라운드에서 다시 — 서버가 늦게 열려도 따라간다.
  React.useEffect(() => {
    if (!active) return;
    const retry = () => {
      if (document.visibilityState !== "visible" || lastOk || lastSent === "") return;
      const body = lastSent;
      lastSent = "";
      void sendShortcuts(JSON.parse(body) as string[]).then((ok) => {
        lastOk = ok;
        if (ok) lastSent = body;
      });
    };
    document.addEventListener("visibilitychange", retry);
    return () => document.removeEventListener("visibilitychange", retry);
  }, [active]);
}
