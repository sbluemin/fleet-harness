import * as React from "react";

import { Select } from "../react/browser.js";
import type { SettingsSectionDescriptor } from "./types.js";

// 실험 설정의 순수 도우미 — 브라우저 번들은 이 진입점만 공유 shim으로 노출되므로 여기서도 낸다.
export {
  CLAUDE_EXPERIMENT_MODEL_OPTIONS,
  DEFAULT_EXPERIMENT_MODELS,
  DEFAULT_EXPERIMENT_SETTINGS,
  EXPERIMENT_FEATURES,
  EXPERIMENT_MODEL_FEATURES,
  experimentFeatureModel,
  isExperimentModelId,
  resolveExperimentSettings,
} from "./experiments.js";

export interface SettingsCardProps {
  readonly title?: React.ReactNode;
  readonly description?: string;
  readonly children: React.ReactNode;
}

export interface SettingsRowProps {
  readonly label: string;
  readonly hint?: string;
  /** 라벨 오른쪽에 서는 도움말 팁 — `<SettingsHelpTip>` 노드를 그대로 받는다. */
  readonly helpTip?: React.ReactNode;
  readonly children: React.ReactNode;
}

export interface SettingsHelpTipProps {
  /**
   * '?' 버튼의 접근성 이름. 호출자가 자기 카탈로그로 "{제목} 도움말" 꼴을 조립해 넘긴다 —
   * SDK는 로케일을 모르므로 여기서 문장을 만들지 않는다.
   */
  readonly ariaLabel: string;
  /**
   * 말풍선이 항상 DOM에 남을 때의 안정 id. 닫힌 동안 hidden이어도 aria-describedby IDREF
   * 계산에는 포함되므로, 기존에 도움말 문단 id를 참조하던 배선이 그대로 이 팁을 가리킬 수 있다.
   */
  readonly id?: string;
  readonly children: React.ReactNode;
}

export interface SettingsToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export interface SettingsSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SettingsSelectProps {
  readonly value: string;
  readonly options: readonly SettingsSelectOption[];
  readonly onChange: (next: string) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export interface SettingsFieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

export interface SettingsSliderProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 끌리는 동안 매 틱 호출된다 — 미리보기만 하고 저장하지 않는다. */
  readonly onPreview: (next: number) => void;
  /** 손을 뗄 때 한 번 호출된다 — 저장은 여기서만 일어난다. */
  readonly onCommit: (next: number) => void;
  readonly label: string;
  readonly formatValue: (value: number) => string;
  readonly decreaseLabel: string;
  readonly increaseLabel: string;
  readonly disabled?: boolean;
}

export function defineSettingsSection(descriptor: SettingsSectionDescriptor): SettingsSectionDescriptor {
  return descriptor;
}

export function ExperimentalBadge({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <span className="experimental-badge">{children}</span>;
}

export type SettingsScopeKind = "live" | "restart" | "sessions";

/**
 * 한 설정이 언제 효력을 갖는지 말하는 칩. 저장 위치와 적용 시점은 설정마다 한 번,
 * 이 한 모양으로만 말한다 — 카드마다 다른 문장으로 되풀이하면 서로 어긋나기 시작한다.
 * 문구는 호출자가 자기 카탈로그에서 가져온다(코어는 en/ko, 플러그인은 자기 로케일).
 */
export function SettingsScope({ kind, label }: { readonly kind: SettingsScopeKind; readonly label: string }): React.ReactElement {
  return (
    <span className={`settings-scope is-${kind}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * 행·카드 제목 옆의 '?' — 설정 설명의 단일 공개 문법.
 *
 * 설명은 매 방문마다 화면을 차지하는 대신 요구가 있는 순간에만 선다: hover(또는 키보드
 * 포커스 후 Enter/Space)는 미리보기를 열고, 클릭·탭은 고정한다. 고정 중에는 본문을 선택할
 * 수 있고, Esc와 바깥 클릭이 닫는다 — Esc는 캡처 단계에서 preventDefault로 소비하므로
 * 설정 페인의 "Esc=페인 닫기"보다 먼저 서고, 페인은 계약대로 물러선다.
 *
 * 말풍선은 닫힌 동안에도 hidden으로 DOM에 남는다. aria-labelledby/aria-describedby의
 * IDREF 계산은 hidden 노드도 포함하므로, 버튼은 언제나 설명을 서술로 갖고, 도움말 문단
 * id를 참조하던 기존 배선은 id를 이 팁에 넘겨 그대로 잇는다.
 *
 * 배치는 열릴 때 한 번 잰다 — 담긴 카드(없으면 뷰포트) 오른쪽 모서리를 넘으면 왼쪽으로
 * 밀고, 뷰포트 바닥을 넘는데 위쪽에 자리가 있으면 위로 뒤집는다(fc-select 팝업의
 * data-placement 문법). 전역 등록부는 두지 않는다 — 다른 팁을 여는 pointerdown이 곧
 * 앞선 팁의 바깥 클릭이라, 한 번에 하나만 열리는 규칙이 조정 없이 성립한다.
 */
export function SettingsHelpTip({ ariaLabel, id, children }: SettingsHelpTipProps): React.ReactElement {
  const autoId = React.useId();
  const bubbleId = id ?? autoId;
  const wrapRef = React.useRef<HTMLSpanElement | null>(null);
  const bubbleRef = React.useRef<HTMLDivElement | null>(null);
  const closeTimer = React.useRef<number | null>(null);
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const [placement, setPlacement] = React.useState<"down" | "up">("down");
  const [shiftX, setShiftX] = React.useState(0);

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const close = React.useCallback(() => {
    setOpen(false);
    setPinned(false);
  }, []);

  React.useLayoutEffect(() => {
    if (!open) {
      setPlacement("down");
      setShiftX(0);
      return;
    }
    const bubble = bubbleRef.current;
    const wrap = wrapRef.current;
    if (!bubble || !wrap) return;
    const rect = bubble.getBoundingClientRect();
    const edge = wrap.closest("section")?.getBoundingClientRect().right ?? window.innerWidth;
    setShiftX(Math.min(0, Math.round(Math.min(edge, window.innerWidth) - 8 - rect.right)));
    if (rect.bottom > window.innerHeight - 8 && wrap.getBoundingClientRect().top > rect.height + 16) {
      setPlacement("up");
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && event.target instanceof Node && wrapRef.current.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  React.useEffect(() => clearCloseTimer, []);

  return (
    <span
      ref={wrapRef}
      className="settings-help-tip"
      onMouseEnter={() => {
        clearCloseTimer();
        setOpen(true);
      }}
      onMouseLeave={() => {
        if (pinned) return;
        // 글리프와 말풍선 사이의 8px 틈을 건너는 손을 즉시 닫기가 끊지 않도록 한 박자 늦춘다.
        clearCloseTimer();
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null;
          setOpen(false);
        }, 120);
      }}
    >
      <button
        type="button"
        className="settings-help-tip__glyph"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-describedby={bubbleId}
        onClick={() => {
          if (pinned) {
            close();
            return;
          }
          clearCloseTimer();
          setOpen(true);
          setPinned(true);
        }}
      >
        ?
      </button>
      <div
        ref={bubbleRef}
        className="settings-help-tip__bubble"
        role="tooltip"
        id={bubbleId}
        hidden={!open}
        data-placement={placement}
        style={shiftX === 0 ? undefined : { marginLeft: `${shiftX}px` }}
      >
        {children}
      </div>
    </span>
  );
}

export function SettingsCard({ title, description, children }: SettingsCardProps): React.ReactElement {
  return (
    <section className="fc-settings-card">
      {title ? <h3 className="fc-settings-card__title">{title}</h3> : null}
      {description ? <p className="fc-settings-card__desc">{description}</p> : null}
      <div className="fc-settings-card__body">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, hint, helpTip, children }: SettingsRowProps): React.ReactElement {
  const labelId = React.useId();
  const hintId = React.useId();
  return (
    <div className="fc-settings-row" role="group" aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined}>
      <div className="fc-settings-row__copy">
        {/* id는 라벨 글자만 감싼 span이 진다 — 팁 버튼이 라벨 요소 안에 서면 aria-labelledby
            이름 계산에 버튼의 접근성 이름까지 딸려 들어가 그룹 이름이 "라벨 + 라벨 도움말"이 된다. */}
        <div className="fc-settings-row__label">
          <span id={labelId}>{label}</span>
          {helpTip}
        </div>
        {hint ? <div className="fc-settings-row__hint" id={hintId}>{hint}</div> : null}
      </div>
      <div className="fc-settings-row__control">{children}</div>
    </div>
  );
}

/**
 * 켬/끔은 콘솔 전체에서 이 한 모양으로만 말한다. 이전에는 플러그인 SDK가 자기 iOS형 스위치를
 * aurora로 칠하고, 코어의 리퀴드 글래스는 맨 체크박스를 쓰고, 원격 접속은 또 다른 스위치를 써서
 * 같은 뜻이 한 화면에서 세 모양으로 갈렸다. 켜짐은 선택이자 위치이므로 brass가 칠하고,
 * 신호 토큰(aurora/warn/coral)은 상태를 말하는 자리에만 남는다.
 */
export function SettingsToggle({ checked, onChange, label, disabled = false }: SettingsToggleProps): React.ReactElement {
  const id = React.useId();
  return (
    <label className="fc-settings-toggle" htmlFor={id}>
      <input
        id={id}
        className="fc-settings-toggle__input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : "Toggle setting"}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="settings-switch fc-settings-toggle__control" aria-hidden="true">
        <span className="settings-switch-knob" />
      </span>
      {label ? <span className="fc-settings-toggle__label">{label}</span> : null}
    </label>
  );
}

export function SettingsSelect({ value, options, onChange, label, disabled = false }: SettingsSelectProps): React.ReactElement {
  const labelId = React.useId();
  const selectOptions = options.map((option) => ({ value: option.value, label: option.label }));
  const control = (
    <Select
      value={value}
      options={selectOptions}
      onChange={onChange}
      disabled={disabled}
      label={label ? undefined : "Select setting"}
      aria-labelledby={label ? labelId : undefined}
    />
  );
  return label ? (
    <label className="fc-settings-select">
      <span className="fc-settings-select__label" id={labelId}>{label}</span>
      {control}
    </label>
  ) : (
    <div className="fc-settings-select">{control}</div>
  );
}

/**
 * 연속값을 고르는 하나의 문법. 코어의 터미널·UI 글꼴 크기가 쓰는 −/슬라이더/+ 조합을 그대로
 * 플러그인에 연다 — 같은 조작이 표면마다 다른 물건으로 보이면 한쪽만 고쳐지는 날이 온다.
 * 트랙과 손잡이는 코어의 공유 `.fleet-slider`가 그리고, 채움 비율만 `--slider-fill`로 싣는다.
 *
 * 저장 시점이 이 컴포넌트의 계약이다. 끌리는 동안에는 onPreview만 부르고 손을 뗄 때(pointerup·
 * keyup·blur) onCommit을 한 번 부른다. 매 틱 저장하면 플러그인 설정 문서가 통째로 초당 수십 번
 * 다시 쓰이고, 진행 중인 쓰기끼리 롤백이 엇갈려 앞선 저장을 되돌린다.
 */
export function SettingsSlider({
  value,
  min,
  max,
  step,
  onPreview,
  onCommit,
  label,
  formatValue,
  decreaseLabel,
  increaseLabel,
  disabled = false,
}: SettingsSliderProps): React.ReactElement {
  const clamp = (next: number): number => Math.max(min, Math.min(max, next));
  const read = (event: React.SyntheticEvent<HTMLInputElement>): number =>
    clamp(Number(event.currentTarget.value));
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;

  // 한 번의 조작이 pointerup·keyup·blur를 잇달아 낸다. 소비처마다 중복을 걸러 내게 두면
  // 저마다 다르게 걸러 내므로, 같은 값을 두 번 저장하지 않는 책임은 이 컨트롤이 진다.
  const lastCommittedRef = React.useRef(value);
  const dirtyRef = React.useRef(false);
  const commit = (next: number, deliberate = false): void => {
    if (!deliberate && !dirtyRef.current && next === lastCommittedRef.current) return;
    lastCommittedRef.current = next;
    dirtyRef.current = false;
    onCommit(next);
  };

  return (
    <div className="fc-settings-slider">
      <button
        type="button"
        className="fc-settings-slider__stepper"
        disabled={disabled || value <= min}
        aria-label={decreaseLabel}
        onClick={() => commit(clamp(value - step), true)}
      >
        −
      </button>
      <input
        className="fleet-slider fc-settings-slider__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={formatValue(value)}
        style={{ "--slider-fill": `${fill}%` } as React.CSSProperties}
        onChange={(event) => {
          dirtyRef.current = true;
          onPreview(read(event));
        }}
        onPointerUp={(event) => commit(read(event))}
        // 값을 움직이는 키에서만 저장한다 — Tab·Shift·Escape의 keyup까지 받으면 값이 그대로인
        // 채로 설정을 다시 쓴다.
        onKeyUp={(event) => {
          if (VALUE_KEYS.has(event.key)) commit(read(event));
        }}
        onBlur={(event) => commit(read(event))}
      />
      <button
        type="button"
        className="fc-settings-slider__stepper"
        disabled={disabled || value >= max}
        aria-label={increaseLabel}
        onClick={() => commit(clamp(value + step), true)}
      >
        +
      </button>
      {/* 값은 range 가 aria-valuetext 로 이미 읽어 준다. output 은 role=status(라이브 영역)라
          그대로 두면 한 번 움직일 때마다 같은 값을 두 번 말한다 — 눈으로만 읽는 표시로 남긴다. */}
      <output className="fc-settings-slider__value" aria-hidden="true">{formatValue(value)}</output>
    </div>
  );
}

const VALUE_KEYS = new Set([
  "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
  "End", "Home", "PageDown", "PageUp",
]);

export function SettingsField({ label, hint, children }: SettingsFieldProps): React.ReactElement {
  const labelId = React.useId();
  const hintId = React.useId();
  return (
    <div className="fc-settings-field" role="group" aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined}>
      <div className="fc-settings-field__label" id={labelId}>
        {label}
      </div>
      {hint ? <div className="fc-settings-field__hint" id={hintId}>{hint}</div> : null}
      <div className="fc-settings-field__control">
        {children}
      </div>
    </div>
  );
}
