import { describe, expect, it } from "vitest";

import { chordFromKeyboardEvent, chordsEquivalent, judgeRecordedChord, matchesChord, setShortcutOverrides, resolveShortcutChords } from "../core/client/src/shortcut-bindings.js";

function key(overrides: Partial<{ code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) {
  return { code: "KeyB", key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe("shortcut bindings", () => {
  it("dispatches the user's rebinding instead of the default and keeps modifiers exact", () => {
    setShortcutOverrides({ "console.toggle-sidebar": ["Mod+Shift+KeyB"] });
    try {
      const [chord] = resolveShortcutChords("console.toggle-sidebar");
      expect(chord).toBe("Mod+Shift+KeyB");
      expect(matchesChord(key({ metaKey: true, shiftKey: true }), chord!, true)).toBe(true);
      // 기본값 ⌘B는 더 이상 이 명령이 아니다 — 수식키가 남거나 모자라면 발화하지 않는다.
      expect(matchesChord(key({ metaKey: true }), chord!, true)).toBe(false);
      expect(matchesChord(key({ metaKey: true, shiftKey: true, altKey: true }), chord!, true)).toBe(false);
    } finally {
      setShortcutOverrides({});
    }
    expect(resolveShortcutChords("console.toggle-sidebar")).toEqual(["Mod+KeyB"]);
  });

  it("does not let an AltGr character keystroke fire a Ctrl+Alt binding on non-Apple platforms", () => {
    // Win/Linux: AltGr+B가 `{`를 내는 레이아웃은 ctrlKey+altKey로 보고된다 — 글자가 b가 아니면 발화 금지.
    expect(matchesChord(key({ ctrlKey: true, altKey: true, key: "{" }), "Mod+Alt+KeyB", false)).toBe(false);
    expect(matchesChord(key({ ctrlKey: true, altKey: true, key: "b" }), "Mod+Alt+KeyB", false)).toBe(true);
    // macOS는 ⌘⌥로 발화하며 ⌥B의 합성문자(∫)는 무시한다.
    expect(matchesChord(key({ metaKey: true, altKey: true, key: "∫" }), "Mod+Alt+KeyB", true)).toBe(true);
  });

  it("treats Ctrl and Mod as one physical key off Apple platforms when detecting conflicts", () => {
    // Windows에서 Ctrl+Space를 기록하면 `Mod+Space`가 되고, Quick Launch의 기본 `Ctrl+Space`와 같은 키다.
    expect(chordsEquivalent("Mod+Space", "Ctrl+Space", false)).toBe(true);
    expect(chordsEquivalent("Mod+Space", "Ctrl+Space", true)).toBe(false);
    expect(chordsEquivalent("Mod+KeyK", "Mod+Shift+KeyK", false)).toBe(false);
  });

  it("records physical chords and refuses ones that would capture typing or close the window", () => {
    expect(chordFromKeyboardEvent(key({ metaKey: true, code: "KeyK", key: "k" }), true)).toBe("Mod+KeyK");
    expect(chordFromKeyboardEvent(key({ ctrlKey: true, code: "Space", key: " " }), false)).toBe("Mod+Space");
    expect(chordFromKeyboardEvent(key({ code: "MetaLeft", key: "Meta", metaKey: true }), true)).toBeNull();
    expect(judgeRecordedChord("KeyB", true)).toEqual({ kind: "reject", reason: "no-modifier" });
    expect(judgeRecordedChord("Shift+KeyB", true)).toEqual({ kind: "reject", reason: "no-modifier" });
    expect(judgeRecordedChord("Mod+KeyW", true)).toEqual({ kind: "reject", reason: "blocked" });
    expect(judgeRecordedChord("Shift+Digit1", true)).toMatchObject({ kind: "ok" });
    expect(judgeRecordedChord("Ctrl+Space", true)).toMatchObject({ kind: "ok", warning: "ime" });
    // Alt+화살표는 재배정 밖의 고정 문법이고, 플러그인이 선언할 수 있는 어떤 물리 코드든 기본값으로 산다.
    expect(judgeRecordedChord("Alt+ArrowRight", true)).toEqual({ kind: "reject", reason: "reserved" });
    expect(matchesChord(key({ altKey: true, code: "Numpad1", key: "1" }), "Alt+Numpad1", true)).toBe(true);
    expect(chordFromKeyboardEvent(key({ ctrlKey: true, code: "Tab", key: "Tab" }), false)).toBeNull();
  });
});
