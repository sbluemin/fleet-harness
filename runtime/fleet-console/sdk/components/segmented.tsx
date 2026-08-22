import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * 세그먼티드 컨트롤 — 제품에 하나뿐인 구현.
 *
 * 이 모듈이 존재하는 이유는 실측이다: 활성 상태를 그리는 레시피가 스물여덟 갈래로 갈려 있었고
 * (채움 4종·테두리 6농도·글자색 4종), 같은 컨트롤이 표면마다 조금씩 다르게 생겨 있었다.
 * CSS 문법만 통일하면 다음 표면이 또 자기 버전을 발명하므로, 선택을 그리는 일 자체를 여기로 옮긴다.
 *
 * 선택은 **색이 아니라 고도**로 말한다. 강조색으로 칠하는 대신 트랙 위에서 썸이 미끄러진다 —
 * 그 방향이 아니면 라이트 테마가 구조적으로 무너진다(brass가 L 56%라 L 95.5% 종이에 섞으면
 * 강조가 주변보다 *어두워진다*: 실측 ΔL −4.8). 썸 면·트랙 면·고도는 전부 테마 토큰이 진다.
 *
 * 썸은 절대 위치 엘리먼트 하나이고, 라벨은 그 위에 색만 바꿔 얹힌다. 폭·위치는 레이아웃에서
 * 읽어 transform으로 옮기므로, 라벨 길이가 언어마다 달라져도 계산이 따로 필요 없다.
 */

export type SegmentedOption<T extends string> = {
  readonly value: T;
  readonly label: ReactNode;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  /** 호출부가 세그먼트를 지목할 수 있게 하는 data-* 한 벌(동작 테스트·자동화가 쓴다). */
  readonly data?: Readonly<Record<string, string>>;
};

export type SegmentedProps<T extends string> = {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** 그룹 자체의 접근성 이름. role="group"에 붙는다. */
  readonly ariaLabel: string;
  /** 호출부가 배치를 위해 얹는 클래스. 컨트롤 문법은 이 모듈과 코어 CSS가 진다. */
  readonly className?: string;
  /** 열을 가득 채우는 변종(사이드바 축 전환처럼 폭이 정해진 자리). */
  readonly stretch?: boolean;
};

type ThumbGeometry = { readonly left: number; readonly width: number } | null;

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  stretch = false,
}: SegmentedProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const [thumb, setThumb] = useState<ThumbGeometry>(null);
  // 첫 배치는 애니메이션하지 않는다 — 열자마자 썸이 왼쪽에서 날아오면 이동이 뜻을 잃는다.
  const [armed, setArmed] = useState(false);

  const measure = useCallback(() => {
    const track = trackRef.current;
    const active = buttonsRef.current.get(value);
    if (!track || !active) {
      setThumb(null);
      return;
    }
    const trackBox = track.getBoundingClientRect();
    const activeBox = active.getBoundingClientRect();
    if (trackBox.width === 0 || activeBox.width === 0) {
      // 숨은 탭(display:none)에서는 0이 나온다 — 그 값을 쓰면 다시 보일 때 썸이 접힌 채로 선다.
      setThumb(null);
      return;
    }
    setThumb({ left: activeBox.left - trackBox.left, width: activeBox.width });
  }, [value]);

  useLayoutEffect(() => {
    measure();
  }, [measure, options]);

  useEffect(() => {
    if (thumb && !armed) {
      const id = requestAnimationFrame(() => setArmed(true));
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [thumb, armed]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return undefined;
    // 폭은 레일 드래그·창 크기·서체 로드로 바뀐다. 그때마다 다시 재지 않으면 썸이 라벨에서 어긋난다.
    const observer = new ResizeObserver(() => measure());
    observer.observe(track);
    for (const button of buttonsRef.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [measure, options]);

  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts?.ready) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, [measure]);

  const focusAt = (index: number) => {
    const target = options[((index % options.length) + options.length) % options.length];
    if (!target) return;
    buttonsRef.current.get(target.value)?.focus();
    if (!target.disabled) onChange(target.value);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    // 세그먼티드는 라디오 그룹처럼 방향키로 옮긴다 — 탭 하나로 그룹을 지나가고 안에서는 화살표다.
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(options.length - 1);
    }
  };

  return (
    <div
      ref={trackRef}
      className={["fc-segmented", stretch ? "is-stretch" : "", armed ? "is-armed" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={ariaLabel}
    >
      {thumb ? (
        <span
          className="fc-segmented__thumb"
          aria-hidden="true"
          style={{ transform: `translateX(${thumb.left}px)`, width: `${thumb.width}px` }}
        />
      ) : null}
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            if (node) buttonsRef.current.set(option.value, node);
            else buttonsRef.current.delete(option.value);
          }}
          type="button"
          className="fc-segmented__option"
          aria-pressed={option.value === value}
          aria-label={option.ariaLabel}
          title={option.title}
          disabled={option.disabled}
          tabIndex={option.value === value ? 0 : -1}
          {...option.data}
          onKeyDown={(event) => onKeyDown(event, index)}
          onClick={() => {
            if (!option.disabled) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
