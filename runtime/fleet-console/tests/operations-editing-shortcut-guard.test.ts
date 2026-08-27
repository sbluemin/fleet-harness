import { describe, expect, it } from "vitest";

import { blocksOperationsShortcutWhileEditing } from "../core/client/src/shortcuts.js";

describe("Operations shortcut guard while editing", () => {
  it("lets every shortcut through when nothing is being edited", () => {
    expect(blocksOperationsShortcutWhileEditing(false, { altKey: false })).toBe(false);
    expect(blocksOperationsShortcutWhileEditing(false, { altKey: true })).toBe(false);
  });

  // 타자가 단축키에 먹히면 글을 쓸 수 없다 — 수식자 없는 키는 편집 중 언제나 입력이다.
  it("swallows unmodified keys while an editor has focus", () => {
    expect(blocksOperationsShortcutWhileEditing(true, { altKey: false })).toBe(true);
  });

  // Alt 축은 뷰(Alt+문자)든 패널(Alt+화살표)이든 편집 중에도 산다. 같은 키가 터미널 포커스에서는
  // 이미 살아 있으므로, 컴포저에 포커스가 있다는 이유로만 죽으면 표면마다 문법이 갈린다.
  // 키별 디스패치는 operations-arrow-shortcut·boot-minimization 통합 테스트가 진다.
  it("keeps the Alt axis alive while the chat composer has focus", () => {
    expect(blocksOperationsShortcutWhileEditing(true, { altKey: true })).toBe(false);
  });
});
