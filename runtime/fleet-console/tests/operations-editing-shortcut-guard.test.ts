import { describe, expect, it } from "vitest";

import { blocksOperationsShortcutWhileEditing } from "../core/client/src/shortcuts.js";

describe("Operations shortcut guard while editing", () => {
  it("lets every shortcut through when nothing is being edited", () => {
    expect(blocksOperationsShortcutWhileEditing(false, { altKey: false, code: "KeyF" })).toBe(false);
    expect(blocksOperationsShortcutWhileEditing(false, { altKey: true, code: "ArrowLeft" })).toBe(false);
  });

  // 타자가 단축키에 먹히면 글을 쓸 수 없다 — 수식자 없는 키는 편집 중 언제나 입력이다.
  it("swallows unmodified keys while an editor has focus", () => {
    expect(blocksOperationsShortcutWhileEditing(true, { altKey: false, code: "KeyF" })).toBe(true);
    expect(blocksOperationsShortcutWhileEditing(true, { altKey: false, code: "Digit1" })).toBe(true);
  });

  // Console 뷰 축은 편집 중에도 산다. 같은 키가 터미널 포커스에서는 이미 살아 있으므로,
  // 채팅 컴포저에 포커스가 있다는 이유로만 죽으면 표면마다 문법이 갈린다.
  it("keeps the Console view axis alive while the chat composer has focus", () => {
    for (const code of ["KeyF", "KeyS", "KeyT", "Digit2"]) {
      expect(blocksOperationsShortcutWhileEditing(true, { altKey: true, code }), code).toBe(false);
    }
  });

  // 편집 중 Alt+화살표는 단어 단위 이동이고, 그것은 화면 배치 명령보다 먼저 이 자리의 것이다.
  it("still yields Alt+Arrow to word-wise caret movement", () => {
    for (const code of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(blocksOperationsShortcutWhileEditing(true, { altKey: true, code }), code).toBe(true);
    }
  });
});
