import { useState } from "react";

import { SHORTCUT_GROUPS } from "../shortcuts-catalog.js";

const STORAGE_KEY = "fleet-console.map.shortcutsCollapsed";
const MAP_GROUP = SHORTCUT_GROUPS.find((group) => group.title === "Map") ?? null;

export function MapShortcuts() {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  if (!MAP_GROUP) return null;

  const toggle = () => {
    setCollapsed((value) => {
      const next = !value;
      writeCollapsed(next);
      return next;
    });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="map-shortcuts-fab"
        data-canvas-blocker
        onClick={toggle}
        aria-label="맵 단축키 보기"
        title="Map shortcuts"
      >
        <QuestionIcon />
      </button>
    );
  }

  return (
    <aside className="map-shortcuts" data-canvas-blocker aria-label="Map shortcuts">
      <div className="map-shortcuts-head">
        <span className="map-shortcuts-label">Shortcuts</span>
        <button type="button" className="map-shortcuts-toggle" onClick={toggle} aria-label="맵 단축키 접기" title="Collapse">
          <CollapseIcon />
        </button>
      </div>
      <dl className="map-shortcuts-list">
        {MAP_GROUP.entries.map((entry) => (
          <div key={entry.description} className="map-shortcuts-entry">
            <dt className="map-shortcuts-combos">
              {entry.combos.map((combo, comboIndex) => (
                <span key={combo.join("+")} className="map-shortcuts-combo">
                  {comboIndex > 0 ? <span className="map-shortcuts-or">or</span> : null}
                  <span className="map-shortcuts-keyset">
                    {combo.map((key) => <kbd key={key}>{key}</kbd>)}
                  </span>
                </span>
              ))}
            </dt>
            <dd>{entry.description}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // 도움말 접힘 선호 저장 실패는 런타임 동작을 막지 않는다.
  }
}

function QuestionIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.3 6.1a1.8 1.8 0 1 1 2.5 1.7c-.5.3-.8.6-.8 1.2v.3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r=".8" fill="currentColor" />
    </svg>
  );
}

function CollapseIcon() {
  // 좌상단 도움말을 접는 방향을 가리키는 위쪽 셰브런.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 10.5 8 5.5l3.5 5M8 11V5.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
