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

// aria-modal 다이얼로그 안에 포커스를 가두기 위한 포커스 가능 요소 선택자(Codex 팔레트/라이트박스와 동일 관례).
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ShortcutsOverlay({ state }: ShortcutsOverlayProps) {
  // 단축키 맵을 열기 직전의 포커스를 저장해 닫힐 때 GNB/본문 조작 흐름을 복원한다.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  if (state.shortcutsOpen && returnFocusRef.current === null) {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    if (!state.shortcutsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 최상위 모달이므로 Esc를 소비해, 배경에 떠 있는 다른 오버레이(JobOverlay/ShellOverlay)의
        // window Esc 리스너가 같은 키 입력으로 함께 닫히는 것을 막는다.
        event.stopImmediatePropagation();
        event.preventDefault();
        closeShortcuts();
        return;
      }
      // aria-modal 다이얼로그이므로 Tab/Shift+Tab이 모달 밖(토버·터미널)으로 새지 않게 카드 안에 포커스를 가둔다.
      if (event.key === "Tab") trapFocus(event, cardRef.current);
    };
    closeButtonRef.current?.focus();
    // capture 단계로 등록해야 먼저 마운트된 배경 오버레이의 bubble 단계 Esc 리스너보다 앞서 이벤트를 소비할 수 있다.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
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
      <section className="shortcuts-overlay-card" ref={cardRef}>
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

// Tab 포커스를 카드 경계에서 순환시켜 모달 밖으로 벗어나지 못하게 한다.
function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
