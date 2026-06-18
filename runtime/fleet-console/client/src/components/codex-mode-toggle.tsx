import type { CodexViewMode } from "../codex-view-mode.js";

interface CodexModeToggleProps {
  readonly mode: CodexViewMode;
  readonly onSelect: (mode: CodexViewMode) => void;
}

interface ModeOption {
  readonly id: CodexViewMode;
  readonly label: string;
  readonly title: string;
}

// 표현 모드 — Full(전용 라우트)·Side(우현 패널). 라벨은 표현을 직접 서술한다.
const MODE_OPTIONS: readonly ModeOption[] = [
  { id: "route", label: "Full", title: "Codex view: Full page" },
  { id: "side", label: "Side", title: "Codex view: Side panel" },
];

// GNB와 사이드 헤더에서 공유하는 모드 스위처. 모두 같은 스토어를 구독하므로
// 어느 위치에서 바꿔도 즉각 동기화된다(US-6).
export function CodexModeToggle({ mode, onSelect }: CodexModeToggleProps) {
  return (
    <div className="codex-mode-toggle" role="group" aria-label="Codex view mode">
      {MODE_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`codex-mode-option ${mode === option.id ? "is-active" : ""}`}
          onClick={() => onSelect(option.id)}
          aria-pressed={mode === option.id}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
