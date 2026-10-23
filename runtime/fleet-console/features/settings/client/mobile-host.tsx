import { createPortal } from "react-dom";
import { useSelect, type SelectProps } from "@fleet-console/ui/react";
import * as React from "react";
import type { ModelRoster } from "../../ai-gateway/shared/models.js";
/**
 * 모바일 셸이 설정 화면에 주입하는 능력. 호스트가 provider를 세운 안에서만 값이 있고(데스크톱·구버전 호스트는 `null`),
 * 이 안의 SDK 설정 컴포넌트는 스스로 모바일 문법으로 그린다 — 선택지는 현재값 줄이 있는 행 → 목록 위 팝업.
 * 뒤로 레지스트리·시스템 바 신호는 팝업을 여는 호스트가 소유한다. 특수한 섹션만 `useMobileSettingsHost()`로 직접 연다.
 */
export interface MobileChoiceOption {
  readonly value: string;
  readonly label: string;
  /** 이름 아래 한 줄. */
  readonly description?: string;
  readonly icon?: React.ReactNode;
  readonly disabled?: boolean;
}


export interface MobileChoiceSpec {
  /** 팝업 접근성 이름. */
  readonly title: string;
  readonly options: readonly MobileChoiceOption[];
  readonly value: string;
  readonly onSelect: (value: string) => void;
  /** 연 컨트롤의 세로 범위(뷰포트 좌표). 주면 팝업이 그 근처에 서고, 없으면 호스트가 정한다. */
  readonly anchor?: { readonly top: number; readonly bottom: number };
}


/** 모델 팝업의 한 묶음(제공자) — 머리 글자와 앞 아이콘, 그 아래 모델 행들. */
export interface MobileModelGroup {
  readonly key: string;
  readonly label: string;
  readonly icon?: React.ReactNode;
  /** `meta`는 오른쪽 끝의 짧은 표식(「1M」), `description`은 이름 아래 설명 줄이다(선택 방식의 풀이처럼 긴 글). */
  readonly options: readonly { readonly value: string; readonly label: string; readonly meta?: string; readonly description?: string }[];
}


/**
 * 모델 팝업(P-1 변형)의 속성. 호출자(`ModelPicker`)가 열려 있는 동안 계속 다시 그려 주므로 값은 늘 살아 있다 —
 * 모델을 골라도 팝업은 열린 채이고, 강도 사다리가 모델에 따라 바뀌어도 따라온다. 닫기는 `onClose`다.
 */
export interface MobileModelChoiceProps {
  readonly title: string;
  readonly groups: readonly MobileModelGroup[];
  readonly value: string;
  readonly onSelect: (value: string) => void;
  /** 주면 구분선 아래에 「추론 강도」 머리 + 글자 탭 줄이 선다. */
  readonly effort?: {
    readonly label: string;
    readonly levels: readonly { readonly value: string; readonly label: string }[];
    readonly value: string;
    readonly onSelect: (value: string) => void;
  };
  /** 주면 맨 아래에 구분선 + 두 줄 행(「기본값 사용」)이 선다. 누르면 `onSelect`를 부르고 팝업을 닫는다. 값을 바꾼 상태일 때만 넘긴다. */
  readonly reset?: MobileModelReset;
  readonly onClose: () => void;
}


/** 모델 팝업 맨 아래의 되돌리기 행. `description`은 되돌아갈 기본값(예: 「Sonnet 4.5 · 보통」). */
export interface MobileModelReset {
  readonly label: string;
  readonly description?: string;
  readonly onSelect: () => void;
}


/**
 * 한 칸 입력 시트(P-4). 제목 → 설명 → 입력칸 → 오류 줄, 발에 「취소」·「저장」(그리고 `onClear`가 있으면 왼쪽 「지우기」).
 * `onSave`가 거절(reject)되면 그 `Error.message`가 오류 줄에 서고 시트는 열린 채다 — 호출부가 현지화한 문장을 던진다.
 */
export interface MobileInputSpec {
  readonly title: string;
  readonly description?: string;
  readonly value: string;
  readonly placeholder?: string;
  /** 비밀값(API 키) — `type=password`이고 입력칸 안에 「보기」 글자 버튼이 선다. */
  readonly secret?: boolean;
  readonly inputMode?: "text" | "numeric" | "url";
  readonly onSave: (value: string) => void | Promise<void>;
  readonly onClear?: () => void | Promise<void>;
}


/** 설정 하위 화면(섹션 안의 한 단 더) — 길어서 팝업에 맞지 않는 목록·관리 화면용. `render`는 열려 있는 동안 호스트가 다시 부르므로 안에서 스토어 훅을 써도 값이 살아 있다. */
export interface MobileSubScreenSpec {
  readonly title: string;
  readonly render: () => React.ReactNode;
}


export interface MobileSettingsHost {
  /** 5줄을 넘는 설명을 접을 때 글자 버튼에 쓰는 현지화한 문구(「더 보기」). 없으면 접지 않는다. */
  readonly moreLabel?: string;
  /** 하위 화면을 연다. 위쪽 막대의 ‹·뒤로가 닫는다. 없는 호스트에서는 호출부가 같은 자리에 그대로 그린다. */
  readonly openSubScreen?: (spec: MobileSubScreenSpec) => void;
  /** 한 칸 입력 시트를 연다. 저장이 끝나면 시트가 닫힌다. */
  readonly openInput?: (spec: MobileInputSpec) => void;
  /** 선택 팝업을 연다. 고르면 팝업이 닫히고 `onSelect`가 불린다. */
  readonly openChoice: (spec: MobileChoiceSpec) => void;
  /**
   * 모델 팝업을 그리는 컴포넌트. `ModelPicker`가 열려 있는 동안 이것을 세운다. 없으면 `ModelPicker`는 데스크톱 모양 그대로다.
   * @deprecated `CoordinateChoice`가 대신한다. Fleet 1.215.0에서 제거한다.
   */
  readonly ModelChoice?: React.ComponentType<MobileModelChoiceProps>;
  /** 모델·강도 좌표 시트. `ModelCoordinatePicker`가 열려 있는 동안 세운다. 없으면 선택기는 데스크톱 메뉴로 그린다. */
  readonly CoordinateChoice?: React.ComponentType<MobileCoordinateChoiceProps>;
}


/**
 * 폰의 좌표 시트 속성 — 모델 로스터의 공급자 띠·모델 행과 고른 행의 강도 탭. 강도 탭(그리고 강도를 받지 않는 모델 탭)은
 * 확정이다: `onSelect(next, { final: true })`로 알리고 시트는 스스로 닫는다. 강도가 있는 모델 탭은 강도 단계로 넘어가는
 * 초안(`final` 없음)이고 시트는 열린 채다. 호출자가 열려 있는 동안 다시 그려 주므로 값은 늘 살아 있다. 닫기는 `onClose`다.
 */
export interface MobileCoordinateChoiceProps {
  readonly title: string;
  readonly roster: ModelRoster;
  readonly value: { readonly model?: string; readonly effort?: string };
  readonly onSelect: (next: { readonly model: string; readonly effort?: string }, meta?: { readonly final: boolean }) => void;
  /** `none`이면 강도 탭이 서지 않는다(모델만 고르는 칸). */
  readonly effort: "track" | "none";
  readonly effortLabel: string;
  /** 로스터 밖 저장값의 띠 머리(「꺼짐」). */
  readonly offLabel?: string;
  readonly extras?: readonly { readonly id: string; readonly label: string; readonly hint?: string; readonly active: boolean; readonly disabled?: boolean; readonly onPick: () => void }[];
  readonly reset?: MobileModelReset;
  readonly onClose: () => void;
}


export const MobileSettingsHostContext = React.createContext<MobileSettingsHost | null>(null);


/** 모바일 `SettingsRow`가 세우는 값 — 행의 제목. 안의 `Select`·`ModelPicker`가 팝업 제목으로 쓴다. 행 밖이면 `null`. */
export const MobileSettingsRowLabelContext = React.createContext<string | null>(null);


/** 호스트가 모바일 설정 능력을 세웠으면 그 값, 아니면 `null`(데스크톱 그대로 그린다). */
export function useMobileSettingsHost(): MobileSettingsHost | null {
  return React.useContext(MobileSettingsHostContext);
}


export function Select({
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
  className,
  id,
  label,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps): React.ReactElement {
  const select = useSelect({ value, options, onChange, disabled, id, compact });
  const selected = options.find((option) => option.value === value);
  const mobileHost = useMobileSettingsHost();
  const rowLabel = React.useContext(MobileSettingsRowLabelContext);
  if (mobileHost) {
    const sharedMobileLabel = ariaLabelledBy ? { "aria-labelledby": ariaLabelledBy } : label ? { "aria-label": label } : {};
    return (
      <button
        type="button"
        id={id}
        className={["fc-select__trigger", "fc-select--mobile", className ?? ""].filter(Boolean).join(" ")}
        disabled={disabled}
        aria-haspopup="listbox"
        {...sharedMobileLabel}
        onClick={(event) => mobileHost.openChoice({
          anchor: event.currentTarget.getBoundingClientRect(),
          title: rowLabel ?? label ?? selected?.label ?? "",
          options: options.map((option) => ({ value: option.value, label: option.label, ...(option.disabled ? { disabled: true } : {}) })),
          value,
          onSelect: onChange,
        })}
      >
        <span className="fc-select__value">{selected?.label ?? ""}</span>
        <span className="fc-select__caret" aria-hidden="true">›</span>
      </button>
    );
  }
  const rootClassName = [
    select.rootProps.className,
    compact ? "fc-select--compact" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const sharedLabelProps = ariaLabelledBy
    ? { "aria-labelledby": ariaLabelledBy }
    : label
      ? { "aria-label": label }
      : {};

  return (
    <div ref={select.rootRef} className={rootClassName}>
      <button {...select.triggerProps} {...sharedLabelProps}>
        <span className="fc-select__value">{selected?.label ?? ""}</span>
        <span className="fc-select__caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {select.isOpen
        ? createPortal(
            <ul {...select.listboxProps} {...sharedLabelProps}>
              {options.map((option, index) => (
                <li key={option.value} {...select.getOptionProps(index)}>
                  {option.label}
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
