import { describe, expect, it } from "vitest";

import { fileExplorerEn, fileExplorerKo } from "../client/i18n/index.js";

describe("file explorer message catalogs", () => {
  it("keeps English and Korean keys in parity", () => {
    expect(Object.keys(fileExplorerKo).sort()).toEqual(Object.keys(fileExplorerEn).sort());
  });

  it("preserves the fixed context-menu literals in both locales", () => {
    expect(pickMenuMessages(fileExplorerEn)).toEqual({
      "fileExplorer.menu.copyPath": "Copy Path",
      "fileExplorer.menu.copyRelativePath": "Copy Relative Path",
      "fileExplorer.menu.reveal": "Reveal in File Manager",
      "fileExplorer.menu.openExternal": "Open with Default App",
      "fileExplorer.menu.pathCopied": "Path copied",
      "fileExplorer.menu.relativePathCopied": "Relative path copied",
      "fileExplorer.menu.actionUnavailable": "Action unavailable on this platform",
    });
    expect(pickMenuMessages(fileExplorerKo)).toEqual({
      "fileExplorer.menu.copyPath": "경로 복사",
      "fileExplorer.menu.copyRelativePath": "상대 경로 복사",
      "fileExplorer.menu.reveal": "파일 관리자에서 보기",
      "fileExplorer.menu.openExternal": "기본 앱으로 열기",
      "fileExplorer.menu.pathCopied": "경로를 복사했습니다",
      "fileExplorer.menu.relativePathCopied": "상대 경로를 복사했습니다",
      "fileExplorer.menu.actionUnavailable": "이 플랫폼에서는 지원되지 않는 동작입니다",
    });
  });

  it("preserves the fixed divider label in both locales", () => {
    expect(fileExplorerEn["fileExplorer.divider.resizeAria"]).toBe("Resize file panes");
    expect(fileExplorerKo["fileExplorer.divider.resizeAria"]).toBe("파일 창 크기 조절");
  });
});

function pickMenuMessages(messages: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith("fileExplorer.menu.")));
}
