import { useEffect, useRef } from "react";

import { SHORTCUT_GROUPS } from "../shortcuts-catalog.js";
import { closeShortcuts } from "../store.js";
import type { ConsoleState } from "../types.js";

interface ShortcutsOverlayProps {
  readonly state: ConsoleState;
}

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

// userAgentData.platform은 "macOS"(소문자)를, navigator.platform은 "MacIntel"을 반환하므로
// 대소문자 무시(i)로 두 표기를 모두 Apple 플랫폼으로 인식해야 ⌘가 올바르게 표시된다.
const MAC_PLATFORM_PATTERN = /mac|iphone|ipad|ipod/i;

export function ShortcutsOverlay({ state }: ShortcutsOverlayProps) {
  // 단축키 맵을 열기 직전의 포커스를 저장해 닫힐 때 GNB/본문 조작 흐름을 복원한다.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  if (state.shortcutsOpen && returnFocusRef.current === null) {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    if (!state.shortcutsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeShortcuts();
    };
    closeButtonRef.current?.focus();
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      target?.focus?.();
    };
  }, [state.shortcutsOpen]);

  if (!state.shortcutsOpen) return null;

  const modLabel = resolveModLabel();

  return (
    <div className="shortcuts-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <button type="button" className="shortcuts-overlay-scrim" onClick={closeShortcuts} aria-label="Close keyboard shortcuts" />
      <section className="shortcuts-overlay-card">
        <header className="shortcuts-overlay-header">
          <span className="shortcuts-overlay-kicker">Reference Map</span>
          <h2>Keyboard Shortcuts</h2>
        </header>
        <button ref={closeButtonRef} type="button" className="shortcuts-overlay-close" onClick={closeShortcuts} aria-label="Close keyboard shortcuts">
          ×
        </button>
        <div className="shortcuts-overlay-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="shortcuts-group" aria-labelledby={`shortcuts-${group.title.toLowerCase()}`}>
              <h3 id={`shortcuts-${group.title.toLowerCase()}`}>{group.title}</h3>
              <dl className="shortcuts-list">
                {group.entries.map((entry) => (
                  <div key={`${group.title}:${entry.description}`} className="shortcuts-entry">
                    <dt className="shortcuts-combos">
                      {entry.combos.map((combo, comboIndex) => (
                        <span key={`${entry.description}:${combo.join("+")}`} className="shortcuts-combo">
                          {comboIndex > 0 ? <span className="shortcuts-combo-separator">or</span> : null}
                          <span className="shortcuts-keyset">
                            {combo.map((key) => (
                              <kbd key={key}>{key === "Mod" ? modLabel : key}</kbd>
                            ))}
                          </span>
                        </span>
                      ))}
                    </dt>
                    <dd>{entry.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

function resolveModLabel(): string {
  const userAgentDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform;
  return MAC_PLATFORM_PATTERN.test(platform) ? "⌘" : "Ctrl";
}
