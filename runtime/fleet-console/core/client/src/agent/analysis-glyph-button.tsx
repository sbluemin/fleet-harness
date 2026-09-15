import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * 분석가 발판 줄의 글리프 버튼 — 접근 이름 하나가 aria-label과 말풍선 문장을 함께 진다.
 * 부관단 머리 동작과 같은 문법이다: 24px 격자, 글자 없는 마크, hover·키보드 포커스에만 뜨는 이름표,
 * 눌린 면은 brass(위치 채널). 채팅 패널과 아티팩트 패널이 같은 버튼을 쓰므로 둘 밖에 둔다.
 */
export function AnalystGlyphButton({ label, pressed, disabled = false, className, onClick, children }: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <span className="session-analyst__glyph-slot">
      <button
        type="button"
        className={`session-analyst__glyph${className ? ` ${className}` : ""}`}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        // 키를 누르고 있는 것만으로 무장→확정이 이어지지 않게 한다 — Enter 반복은 click을 반복한다.
        onKeyDown={(event) => { if (event.repeat) event.preventDefault(); }}
      >{children}</button>
      <span className="session-analyst__glyph-tip" role="tooltip">{label}</span>
    </span>
  );
}

/** 두 번 누름 — 첫 누름은 무장, 창(1.5초) 안의 두 번째 누름이 실행한다. 언마운트·창 만료에 무장이 풀린다. */
export function useArmedAction(fire: () => void, windowMs = 1_500): { readonly armed: boolean; readonly trigger: () => void } {
  const [armed, setArmed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  }, []);
  React.useEffect(() => disarm, [disarm]);
  const trigger = React.useCallback(() => {
    if (armed) {
      disarm();
      fire();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => { timer.current = null; setArmed(false); }, windowMs);
  }, [armed, disarm, fire, windowMs]);
  return { armed, trigger };
}
