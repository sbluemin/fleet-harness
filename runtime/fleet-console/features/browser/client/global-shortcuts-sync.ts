import { React } from "@fleet-console/sdk/plugin/browser";
import type { CompanionPanelDescriptor } from "@fleet-console/sdk/plugin";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";
import {
  companionDefaultChord,
  companionShortcutCommandId,
  CORE_SHORTCUT_COMMANDS,
  resolveShortcutChords,
  useShortcutOverrides,
} from "../../../core/client/src/integration/shortcut-bindings.js";
import { usableCompanionShortcuts } from "../../../core/client/src/integration/shortcuts.js";

/**
 * Desktop 단축키 중계 동기화(리뷰 B).
 *
 * 네이티브 뷰에 포커스가 있으면 Console 단축키가 렌더러에 닿지 않으므로,
 * 클라이언트가 현재 유효 조합(사용자 재배정 반영, shortcut-bindings 단일 출처)을
 * `POST /api/v1/browser/shortcuts`로 서버에 알리고, 서버는 스냅샷 선택 필드
 * `shortcuts`로 셸에 싣는다. 옛 셸은 모르는 필드를 무시하고, 옛 Console은
 * 필드를 싣지 않아 새 셸이 중계하지 않는다.
 *
 * companion 토글도 선언된 전부를 푼다(설정 화면의 행과 같은 열거 — 코어 +
 * 플러그인 operation kind). Operation 브라우저를 재배정해도 뷰 포커스 중
 * 중계가 따라간다.
 *
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
  const registry = usePluginRegistry();
  React.useEffect(() => {
    if (!active || !isDesktopShell()) return;
    const chords = new Set<string>();
    for (const command of CORE_SHORTCUT_COMMANDS) {
      for (const chord of resolveShortcutChords(command.id)) chords.add(chord);
    }
    for (const kind of registry.operationKinds) {
      for (const companion of usableCompanionShortcuts(kind.companions ?? []) as readonly CompanionPanelDescriptor[]) {
        if (!companion.shortcut) continue;
        const commandId = companionShortcutCommandId(kind.pluginId, companion.id);
        for (const chord of resolveShortcutChords(commandId, [companionDefaultChord(companion.shortcut.code)])) chords.add(chord);
      }
    }
    const body = JSON.stringify([...chords]);
    if (body === lastSent && lastOk) return;
    lastSent = body;
    void sendShortcuts([...chords]).then((ok) => { lastOk = ok; });
  }, [active, overrides, registry.operationKinds]);
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
