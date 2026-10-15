import fs from "node:fs";
import path from "node:path";

import { readDesktopThemeSnapshot, type DesktopThemeSnapshot } from "./desktop-theme-sync.js";
import { INITIAL_WINDOWS_TITLE_BAR_OVERLAY } from "./window-policy.js";

interface ThemeMemoryFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  renameSync(oldPath: string, newPath: string): void;
}

/**
 * 창이 뜨는 순간에는 Console이 아직 없다. 그래서 이 기계의 Console이 마지막으로 알려 준 테마를 기억해
 * 다음 실행의 첫 프레임(창 바탕, 진입 화면, Windows 제목 표시줄)에 쓴다. 원격 Console의 테마는 기억하지
 * 않는다 — 다음 실행이 여는 것은 언제나 이 기계의 Console이다.
 *
 * 기억은 편의일 뿐이다. 읽지 못하거나 모양이 어긋나면 기본 판으로 뜨고, 쓰지 못해도 Console을 막지 않는다.
 */
export interface ThemeMemory {
  load(): DesktopThemeSnapshot | null;
  save(snapshot: DesktopThemeSnapshot): void;
}

export function createThemeMemory(statePath: string, fileSystem: ThemeMemoryFileSystem = fs): ThemeMemory {
  const temporaryPath = `${statePath}.tmp`;
  let written: string | null = null;
  return {
    load() {
      try {
        const snapshot = readDesktopThemeSnapshot(JSON.parse(fileSystem.readFileSync(statePath, "utf8")));
        return snapshot ? retireDarkPalette(snapshot) : null;
      } catch {
        return null;
      }
    },
    save(snapshot) {
      const serialized = `${JSON.stringify(snapshot)}\n`;
      if (serialized === written) return;
      try {
        fileSystem.mkdirSync(path.dirname(statePath), { recursive: true });
        fileSystem.writeFileSync(temporaryPath, serialized, "utf8");
        fileSystem.renameSync(temporaryPath, statePath);
        written = serialized;
      } catch {
        // 테마 기억은 best-effort다. 읽기 전용 userData가 Console을 막아서는 안 된다.
      }
    },
  };
}

/**
 * Console이 퇴역시킨 다크 팔레트(maritime/carbon)의 기억은 그 색을 더 쓰지 않는다. 다음 동기화가 보낼 다크는 기본 판
 * (entry.css·CANVAS_FAR_BACKGROUND_COLOR)과 같은 색이라, 팔레트를 버리고 기본 판으로 떠야 첫 프레임에서 색이 튀지 않는다.
 * 제목 표시줄은 대화 중심 화면(높이 52)이면 다크가 모두 같은 색이라 그대로 두고, Command Band(높이 35)면 기본 판의 색으로
 * 돌린다. 크롬 기하는 테마와 무관하므로 남긴다.
 */
const RETIRED_DARK_THEMES: ReadonlySet<string> = new Set(["maritime", "carbon"]);

function retireDarkPalette(snapshot: DesktopThemeSnapshot): DesktopThemeSnapshot {
  if (!RETIRED_DARK_THEMES.has(snapshot.theme)) return snapshot;
  const titleBarOverlay = snapshot.titleBarOverlay.height === INITIAL_WINDOWS_TITLE_BAR_OVERLAY.height
    ? { ...INITIAL_WINDOWS_TITLE_BAR_OVERLAY }
    : snapshot.titleBarOverlay;
  return { theme: "dark", titleBarOverlay, ...(snapshot.chrome ? { chrome: snapshot.chrome } : {}) };
}
