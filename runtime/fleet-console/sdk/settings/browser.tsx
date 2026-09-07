import * as React from "react";
import { createPortal } from "react-dom";

import { groupModelsByLaunchProvider, isLaunchProviderGlyphId, launchProviderCaption, launchProviderGlyph, type LaunchProviderGlyphId } from "../components/launch-provider-glyphs.js";
import { SegmentedThumb, useSelect } from "../react/browser.js";
import { CLAUDE_EXPERIMENT_MODEL_OPTIONS, type ExperimentModelOption } from "./experiments.js";
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
  /** 스위치 옆에 보이는 글. 행 라벨이 이미 뜻을 말하면 비우고 `ariaLabel`만 준다. */
  readonly label?: string;
  /** 보이지 않는 접근성 이름 — 행 라벨을 되풀이하는 눈에 띄는 글 없이 스위치를 이름 짓는다. */
  readonly ariaLabel?: string;
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
export function SettingsToggle({ checked, onChange, label, ariaLabel, disabled = false }: SettingsToggleProps): React.ReactElement {
  const id = React.useId();
  return (
    <label className="fc-settings-toggle" htmlFor={id}>
      <input
        id={id}
        className="fc-settings-toggle__input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel ?? (label ? undefined : "Toggle setting")}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="settings-switch fc-settings-toggle__control" aria-hidden="true">
        <span className="settings-switch-knob" />
      </span>
      {label ? <span className="fc-settings-toggle__label">{label}</span> : null}
    </label>
  );
}

export interface ModelPickerEffort {
  readonly value: string;
  /** 사다리 — 호출자가 자기 계약(기능 고정 사다리 또는 선택된 모델의 `effortLevels`)으로 넘긴다. */
  readonly levels: readonly string[];
  readonly onChange: (next: string) => void;
  readonly ariaLabel: string;
  /** 단 이름의 표시 문구. 없으면 단 id를 그대로 쓴다. */
  readonly labelOf?: (level: string) => string;
}

export interface ModelPickerProps {
  readonly value: string;
  readonly options: readonly ExperimentModelOption[];
  readonly onChange: (next: string) => void;
  /** 주면 트리거 오른쪽에 강도 세그먼트가 이어 붙는다. 사다리가 비면 그려지지 않는다. */
  readonly effort?: ModelPickerEffort;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  /** 행 제목이 이름이 된다. 행 제목이 없는 자리만 `label`로 보이지 않는 이름을 준다. */
  readonly "aria-labelledby"?: string;
  readonly label?: string;
}

/**
 * 모델 선택지를 비동기로 채우는 한 훅. Claude 별칭은 즉시 서고, 로더(코어의 수집기 또는
 * 플러그인 브리지)가 늦거나 실패해도 별칭은 남는다 — 카드마다 같은 useState/useEffect를
 * 되풀이하면 그중 하나가 빈 목록으로 떨어지는 날이 온다.
 */
export function useModelPickerOptions(load: () => Promise<readonly ExperimentModelOption[]>): readonly ExperimentModelOption[] {
  const [options, setOptions] = React.useState<readonly ExperimentModelOption[]>(CLAUDE_EXPERIMENT_MODEL_OPTIONS);
  React.useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled && next.length > 0) setOptions(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [load]);
  return options;
}

/** 팝업의 최소 폭 — 트리거가 좁아도 Gateway 모델 이름이 한 줄에 서야 한다. */
const MODEL_PICKER_POPUP_MIN_WIDTH_PX = 260;
const MODEL_PICKER_VIEWPORT_MARGIN_PX = 8;

/**
 * useSelect는 트리거 폭으로 팝업을 놓는다. 여기서 최소 폭을 넓힌 뒤에는 뷰포트 안으로 다시
 * 잠가야 한다 — CSS min-width로만 넓히면 오른쪽 끝에 선 좁은 트리거의 팝업이 화면 밖으로 나간다.
 */
function widenModelPickerPopup(style: React.CSSProperties): React.CSSProperties {
  if (typeof style.left !== "number" || typeof style.width !== "number") return style;
  const margin = MODEL_PICKER_VIEWPORT_MARGIN_PX;
  const viewportWidth = Math.max(0, window.innerWidth);
  const width = Math.min(Math.max(style.width, MODEL_PICKER_POPUP_MIN_WIDTH_PX), Math.max(0, viewportWidth - 2 * margin));
  const left = Math.min(Math.max(style.left, margin), Math.max(margin, viewportWidth - width - margin));
  return { ...style, left, width };
}

function formatModelContextWindow(contextWindow: number | null | undefined): string | null {
  if (contextWindow === null || contextWindow === undefined || contextWindow <= 0) return null;
  return contextWindow >= 1_000_000 ? "1M" : `${Math.round(contextWindow / 1000)}K`;
}

function modelPickerProviderOf(option: ExperimentModelOption): LaunchProviderGlyphId | null {
  return option.provider !== undefined && isLaunchProviderGlyphId(option.provider) ? option.provider : null;
}

/**
 * 설정 화면에서 모델 하나를 고르는 단일 문법.
 *
 * 트리거는 프로바이더 글리프·표시 이름·컨텍스트 메타를 한 줄로 말하고, 팝업은 런치 메뉴와 같은
 * 순서·같은 글리프 배지(공급자 톤)로 프로바이더 밴드를 세운다 — 런치에서 고른 모델이 설정에서 다른 얼굴로 보이면 같은
 * 모델인지 사람이 대조해야 한다. 크기 변형은 두지 않는다: 실험 카드의 42px 필드와 부관단
 * 카드의 무테 11px 텍스트가 한 페이지에 서던 것이 이 컴포넌트가 지우는 어긋남이다.
 *
 * 저장된 값이 목록에 없으면(플러그인이 꺼졌거나 모델이 사라짐) 그 id를 마지막 밴드에 세워
 * 선택이 화면에서 사라지지 않게 한다 — 사라지면 첫 옵션이 골라진 것처럼 읽히고, 다음 저장이
 * 그 값을 조용히 덮어쓴다.
 */
export function ModelPicker({
  value,
  options,
  onChange,
  effort,
  disabled = false,
  id,
  className,
  "aria-labelledby": ariaLabelledBy,
  label,
}: ModelPickerProps): React.ReactElement {
  const groups = React.useMemo(() => {
    const known = options.some((option) => option.id === value);
    const listed = known || value === "" ? options : [...options, { id: value, label: value }];
    return groupModelsByLaunchProvider(listed, modelPickerProviderOf);
  }, [options, value]);
  const flat = React.useMemo(() => groups.flatMap((group) => group.models), [groups]);
  const selectOptions = React.useMemo(() => flat.map((option) => ({ value: option.id, label: option.label })), [flat]);
  const select = useSelect({ value, options: selectOptions, onChange, disabled, id });
  const selected = flat.find((option) => option.id === value);
  const selectedProvider = selected ? modelPickerProviderOf(selected) ?? groups.find((group) => group.models.includes(selected))?.provider ?? null : null;
  const selectedMeta = formatModelContextWindow(selected?.contextWindow);
  const known = options.some((option) => option.id === value);

  const nameProps = ariaLabelledBy
    ? { "aria-labelledby": ariaLabelledBy }
    : label
      ? { "aria-label": label }
      : {};
  const levels = effort?.levels ?? [];
  const rootClassName = ["fc-model-picker", levels.length > 0 ? "has-effort" : "", className ?? ""].filter(Boolean).join(" ");

  let index = -1;
  return (
    <div className={rootClassName}>
      <div ref={select.rootRef} className={`${select.rootProps.className} fc-model-picker__select`}>
        <button {...select.triggerProps} {...nameProps} className="fc-select__trigger fc-model-picker__trigger">
          {selectedProvider ? <span className={`fc-model-picker__glyph fc-model-picker__glyph--mark is-${selectedProvider}`} aria-hidden="true">{launchProviderGlyph(selectedProvider)}</span> : null}
          <span className={`fc-select__value fc-model-picker__name${known ? "" : " is-unknown"}`}>{selected?.label ?? value}</span>
          {selectedMeta ? <span className="fc-model-picker__meta">{selectedMeta}</span> : null}
          <span className="fc-select__caret" aria-hidden="true">⌄</span>
        </button>
        {select.isOpen
          ? createPortal(
              <ul {...select.listboxProps} {...nameProps} className={`${select.listboxProps.className} fc-model-picker__popup`} style={widenModelPickerPopup(select.listboxProps.style)}>
                {groups.map((group) => (
                  <React.Fragment key={group.provider ?? "etc"}>
                    {/* 밴드는 옵션이 아니다 — listbox의 activedescendant 순서는 옵션만 센다. */}
                    <li role="presentation" className="fc-model-picker__band">
                      {group.provider ? <span className={`operation-launch-provider-glyph fc-model-picker__glyph is-${group.provider}`} aria-hidden="true">{launchProviderGlyph(group.provider)}</span> : null}
                      {group.provider ? launchProviderCaption(group.provider) : "…"}
                    </li>
                    {group.models.map((option) => {
                      index += 1;
                      const meta = formatModelContextWindow(option.contextWindow);
                      const optionProps = select.getOptionProps(index);
                      return (
                        <li key={option.id} {...optionProps} className={`${optionProps.className} fc-model-picker__option`}>
                          <span className="fc-model-picker__name">{option.label}</span>
                          {meta ? <span className="fc-model-picker__meta">{meta}</span> : null}
                        </li>
                      );
                    })}
                  </React.Fragment>
                ))}
              </ul>,
              document.body,
            )
          : null}
      </div>
      {effort && levels.length > 0 ? (
        <ModelPickerEffortSegments effort={effort} levels={levels} disabled={disabled} />
      ) : null}
    </div>
  );
}

/**
 * 강도는 배타 선택이라 세그먼트 문법(SegmentedThumb의 brass 다텀)을 쓴다 — Gateway 로스터의
 * 다중 on 사다리(잉크 워시)와 모양이 다른 것은 뜻이 다르기 때문이다.
 */
function ModelPickerEffortSegments({ effort, levels, disabled }: {
  readonly effort: ModelPickerEffort;
  readonly levels: readonly string[];
  readonly disabled: boolean;
}): React.ReactElement {
  const groupRef = React.useRef<HTMLDivElement | null>(null);
  const current = levels.includes(effort.value) ? effort.value : levels[Math.floor(levels.length / 2)] ?? levels[0]!;
  const move = (direction: 1 | -1) => {
    const at = levels.indexOf(current);
    const next = levels[(at + direction + levels.length) % levels.length];
    if (next === undefined) return;
    effort.onChange(next);
    window.setTimeout(() => groupRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(), 0);
  };
  return (
    <div ref={groupRef} className="segmented fc-model-picker__effort" role="radiogroup" aria-label={effort.ariaLabel}>
      <SegmentedThumb />
      {levels.map((level) => {
        const isOn = level === current;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={isOn}
            tabIndex={isOn ? 0 : -1}
            className={`segmented-option${isOn ? " is-active" : ""}`}
            disabled={disabled}
            onClick={() => effort.onChange(level)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(1); }
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(-1); }
            }}
          >
            {effort.labelOf ? effort.labelOf(level) : level}
          </button>
        );
      })}
    </div>
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
