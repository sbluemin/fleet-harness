import * as React from "react";
import { createPortal } from "react-dom";

export interface PluginErrorBoundaryProps {
  readonly children: React.ReactNode;
  readonly fallback?: React.ReactNode;
  readonly onError?: (error: unknown) => void;
}

interface PluginErrorBoundaryState {
  readonly hasError: boolean;
}

const DEFAULT_PLUGIN_ERROR_FALLBACK = <div className="fc-plugin-error">Plugin failed to render.</div>;

export { React };
export default React;

export class PluginErrorBoundary extends React.Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
  readonly state: PluginErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PluginErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback ?? DEFAULT_PLUGIN_ERROR_FALLBACK;
    return this.props.children;
  }
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface UseSelectOptions {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (next: string) => void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly compact?: boolean;
}

export interface UseSelectResult {
  readonly isOpen: boolean;
  readonly activeOptionId: string | undefined;
  readonly placement: "up" | "down";
  readonly rootRef: React.RefObject<HTMLDivElement | null>;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly popupRef: React.RefObject<HTMLUListElement | null>;
  readonly listboxId: string;
  readonly rootProps: {
    readonly ref: React.RefObject<HTMLDivElement | null>;
    readonly className: string;
  };
  readonly triggerProps: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly ref: React.RefObject<HTMLButtonElement | null>;
  };
  readonly listboxProps: React.HTMLAttributes<HTMLUListElement> & {
    readonly ref: React.RefObject<HTMLUListElement | null>;
    readonly style: React.CSSProperties;
    readonly "data-open": "true" | "false";
    readonly "data-placement": "up" | "down";
  };
  readonly getOptionProps: (index: number) => React.LiHTMLAttributes<HTMLLIElement> & {
    readonly id: string;
    readonly "data-active": "true" | "false";
  };
}

export interface SelectProps extends UseSelectOptions {
  readonly label?: string;
  readonly compact?: boolean;
  readonly className?: string;
  readonly "aria-labelledby"?: string;
}

const POPUP_OFFSET_PX = 6;
const POPUP_MAX_HEIGHT_PX = 232;
const COMPACT_POPUP_MIN_WIDTH_PX = 160;
const VIEWPORT_MARGIN_PX = 8;
const TYPEAHEAD_MS = 500;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function enabledIndices(options: readonly SelectOption[]): readonly number[] {
  const indices: number[] = [];
  for (let index = 0; index < options.length; index += 1) {
    if (!options[index]?.disabled) indices.push(index);
  }
  return indices;
}

function computePopupStyle(trigger: DOMRect, placement: "up" | "down", compact: boolean): React.CSSProperties {
  const margin = Math.max(0, VIEWPORT_MARGIN_PX);
  const viewportWidth = Math.max(0, window.innerWidth);
  const viewportHeight = Math.max(0, window.innerHeight);
  const maxWidth = Math.max(0, viewportWidth - 2 * margin);
  const triggerWidth = Math.max(0, trigger.width);
  const width = compact
    ? Math.min(Math.max(COMPACT_POPUP_MIN_WIDTH_PX, triggerWidth), maxWidth)
    : Math.min(triggerWidth, maxWidth);
  const rawLeft = compact ? trigger.right - width : trigger.left;
  const left = clamp(rawLeft, margin, Math.max(margin, viewportWidth - width - margin));
  return placement === "down"
    ? {
        position: "fixed",
        left,
        width,
        top: Math.max(0, trigger.bottom + POPUP_OFFSET_PX),
      }
    : {
        position: "fixed",
        left,
        width,
        bottom: Math.max(0, viewportHeight - trigger.top + POPUP_OFFSET_PX),
      };
}

function resolvePlacement(trigger: DOMRect): "up" | "down" {
  const spaceBelow = window.innerHeight - trigger.bottom - POPUP_OFFSET_PX;
  const spaceAbove = trigger.top - POPUP_OFFSET_PX;
  return spaceBelow < POPUP_MAX_HEIGHT_PX && spaceAbove > spaceBelow ? "up" : "down";
}

/**
 * useSelect is the documented escape hatch for bespoke shells that need listbox
 * behavior without the default Select markup. It holds only instance-local state —
 * never module-scoped coordination.
 */
export function useSelect({
  value,
  options,
  onChange,
  disabled = false,
  id,
  compact = false,
}: UseSelectOptions): UseSelectResult {
  const reactId = React.useId();
  const listboxId = id ?? `fc-select-${reactId.replace(/:/g, "")}`;
  const optionIds = React.useMemo(
    () => options.map((option, index) => `${listboxId}-option-${index}-${option.value}`),
    [listboxId, options],
  );

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const popupRef = React.useRef<HTMLUListElement | null>(null);

  const [isOpen, setIsOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [placement, setPlacement] = React.useState<"up" | "down">("down");
  const [popupStyle, setPopupStyle] = React.useState<React.CSSProperties>({});
  const typeaheadRef = React.useRef("");
  const typeaheadTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const enabled = React.useMemo(() => enabledIndices(options), [options]);

  const clearTypeahead = React.useCallback(() => {
    typeaheadRef.current = "";
    if (typeaheadTimerRef.current !== undefined) {
      clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = undefined;
    }
  }, []);

  const close = React.useCallback(() => {
    setIsOpen(false);
    setActiveIndex(-1);
    clearTypeahead();
  }, [clearTypeahead]);

  const commit = React.useCallback(
    (nextValue: string) => {
      onChange(nextValue);
      close();
      triggerRef.current?.focus();
    },
    [close, onChange],
  );

  const updatePopupPosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const nextPlacement = resolvePlacement(rect);
    setPlacement(nextPlacement);
    setPopupStyle(computePopupStyle(rect, nextPlacement, compact));
  }, [compact]);

  const open = React.useCallback(
    (focusSelected = true) => {
      if (disabled || isOpen) return;
      setIsOpen(true);
      const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
      if (focusSelected && selectedIndex >= 0) {
        setActiveIndex(selectedIndex);
      } else {
        setActiveIndex(enabled[0] ?? -1);
      }
    },
    [disabled, enabled, isOpen, options, value],
  );

  const move = React.useCallback(
    (direction: 1 | -1) => {
      if (!enabled.length) return;
      const currentPosition = enabled.indexOf(activeIndex);
      const base = currentPosition >= 0 ? currentPosition : direction > 0 ? -1 : 0;
      const next = enabled[(base + direction + enabled.length) % enabled.length];
      if (next !== undefined) setActiveIndex(next);
    },
    [activeIndex, enabled],
  );

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    updatePopupPosition();
    window.addEventListener("resize", updatePopupPosition);
    window.addEventListener("scroll", updatePopupPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopupPosition);
      window.removeEventListener("scroll", updatePopupPosition, true);
    };
  }, [isOpen, updatePopupPosition]);

  React.useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        const first = enabled[0];
        if (first !== undefined) setActiveIndex(first);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        const last = enabled.at(-1);
        if (last !== undefined) setActiveIndex(last);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        const option = options[activeIndex];
        if (option && !option.disabled) commit(option.value);
        return;
      }
      if (event.key.length === 1 && /\S/u.test(event.key)) {
        typeaheadRef.current += event.key.toLowerCase();
        clearTimeout(typeaheadTimerRef.current);
        typeaheadTimerRef.current = setTimeout(() => {
          typeaheadRef.current = "";
        }, TYPEAHEAD_MS);
        const prefix = typeaheadRef.current;
        const hit = enabled
          .map((index) => options[index])
          .find((option) => option?.label.toLowerCase().startsWith(prefix));
        if (hit) {
          const index = options.indexOf(hit);
          if (index >= 0) setActiveIndex(index);
        }
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeIndex, close, commit, enabled, isOpen, move, options]);

  React.useEffect(() => () => clearTypeahead(), [clearTypeahead]);

  React.useEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    const optionId = optionIds[activeIndex];
    if (!optionId) return;
    const element = document.getElementById(optionId);
    element?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, isOpen, optionIds]);

  const activeOptionId = isOpen && activeIndex >= 0 ? optionIds[activeIndex] : undefined;

  const onTriggerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (isOpen) return;
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      open(event.key !== "ArrowDown");
      if (event.key === "ArrowDown") move(1);
    },
    [isOpen, move, open],
  );

  const onTriggerClick = React.useCallback(() => {
    if (disabled) return;
    if (isOpen) close();
    else open(true);
  }, [close, disabled, isOpen, open]);

  const getOptionProps = React.useCallback(
    (index: number) => {
      const option = options[index];
      return {
        id: optionIds[index] ?? `${listboxId}-option-${index}`,
        role: "option" as const,
        className: "fc-select__option",
        "data-active": (activeIndex === index ? "true" : "false") as "true" | "false",
        "aria-selected": option?.value === value,
        "aria-disabled": option?.disabled ? true : undefined,
        onPointerEnter: () => setActiveIndex(index),
        onClick: () => {
          if (option && !option.disabled) commit(option.value);
        },
      };
    },
    [activeIndex, commit, listboxId, optionIds, options, value],
  );

  return {
    isOpen,
    activeOptionId,
    placement,
    rootRef,
    triggerRef,
    popupRef,
    listboxId,
    rootProps: {
      ref: rootRef,
      className: "fc-select",
    },
    triggerProps: {
      ref: triggerRef,
      type: "button",
      role: "combobox",
      className: "fc-select__trigger",
      disabled,
      "aria-haspopup": "listbox",
      "aria-expanded": isOpen,
      "aria-controls": listboxId,
      "aria-activedescendant": activeOptionId,
      onClick: onTriggerClick,
      onKeyDown: onTriggerKeyDown,
    },
    listboxProps: {
      ref: popupRef,
      id: listboxId,
      role: "listbox",
      className: compact ? "fc-select__popup fc-select__popup--compact" : "fc-select__popup",
      "data-open": isOpen ? "true" : "false",
      "data-placement": placement,
      style: popupStyle,
    },
    getOptionProps,
  };
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

/**
 * Quiet Controls의 미끄러지는 융기면(thumb).
 *
 * 세그먼트 컨테이너(position: relative)의 첫 자식으로 넣으면, 활성 옵션
 * (`aria-pressed="true"` 또는 `.is-active`)의 offset 좌표 위에 `.segmented-thumb`
 * 장식을 얹고 선택 이동을 미끄러짐으로 잇는다. 시각과 전환은 전부 CSS 토큰
 * (--control-thumb*)과 CSS transition이 지므로 prefers-reduced-motion 단락도
 * CSS에서 함께 닫힌다. 자리를 잡기 전(is-placed 없음)에는 활성 옵션의 자체
 * face가 그대로 서므로 JS가 늦는 프레임에도 선택 상태는 항상 보인다.
 */
export function SegmentedThumb({
  activeSelector = '[aria-pressed="true"], .is-active',
}: {
  readonly activeSelector?: string;
} = {}): React.ReactElement {
  const thumbRef = React.useRef<HTMLSpanElement | null>(null);

  React.useLayoutEffect(() => {
    const thumb = thumbRef.current;
    const host = thumb?.parentElement;
    if (!thumb || !host) return;

    const place = () => {
      const active = host.querySelector<HTMLElement>(activeSelector);
      // display:none 조상 아래에서는 offsetWidth가 0이다 — 그 좌표로 자리를 잡으면
      // 탭 복귀 프레임에 0폭 썸이 미끄러진다. 자리를 걷고 face 폴백에 맡긴다.
      // classList.add/remove는 값이 그대로여도 class 어트리뷰트를 다시 써서 MutationObserver
      // 레코드를 만든다 — 무조건 쓰면 아래 관찰과 무한 반향이 된다. 변할 때만 쓴다.
      if (!active || active.offsetWidth === 0) {
        if (thumb.classList.contains("is-placed")) thumb.classList.remove("is-placed");
        return;
      }
      // 첫 자리 잡기(또는 숨김 복귀)는 이동이 아니라 등장이다 — 좌상단 원점에서
      // 미끄러져 들어오는 유령 슬라이드가 보이지 않도록 전환 없이 앉힌다.
      const firstPlacement = !thumb.classList.contains("is-placed");
      if (firstPlacement) thumb.style.transition = "none";
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.height = `${active.offsetHeight}px`;
      thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
      if (firstPlacement) {
        thumb.classList.add("is-placed");
        void thumb.offsetWidth;
        thumb.style.transition = "";
      }
    };

    place();
    // 크기 변화(RO)와 활성 표식 변화(MO)를 함께 듣는다 — aria-pressed 토글은
    // 컨테이너의 어떤 크기도 바꾸지 않으므로 ResizeObserver만으로는 놓친다.
    // jsdom에는 ResizeObserver가 없다 — 관찰만 건너뛰고 place()는 항상 달린다
    // (조기 반환으로 훅 전체를 잠그면 테스트 환경이 배치 로직까지 잃는다).
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (resizeObserver) {
      resizeObserver.observe(host);
      for (const child of host.children) {
        if (child !== thumb) resizeObserver.observe(child);
      }
    }
    const mutationObserver = new MutationObserver((records) => {
      // thumb 자신의 표식 변화는 place()의 메아리다 — 되울리면 무한 루프로 렌더러가 잠긴다.
      if (records.every((record) => record.target === thumb)) return;
      place();
    });
    mutationObserver.observe(host, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-pressed", "class"],
    });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
    };
  }, [activeSelector]);

  return <span ref={thumbRef} className="segmented-thumb" aria-hidden="true" />;
}
