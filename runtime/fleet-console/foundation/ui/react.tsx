import * as React from "react";
export interface FeatureErrorBoundaryProps {
  readonly children: React.ReactNode;
  readonly fallback?: React.ReactNode;
  readonly onError?: (error: unknown) => void;
}


interface FeatureErrorBoundaryState {
  readonly hasError: boolean;
}


const DEFAULT_PLUGIN_ERROR_FALLBACK = <div className="fc-plugin-error">Plugin failed to render.</div>;


export { React };

export default React;


export class FeatureErrorBoundary extends React.Component<FeatureErrorBoundaryProps, FeatureErrorBoundaryState> {
  readonly state: FeatureErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): FeatureErrorBoundaryState {
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
    /** 활성 행을 마지막으로 옮긴 입력. 키보드일 때만 활성 행이 포커스 링을 그린다(마우스는 hover 워시뿐). */
    readonly "data-nav": "keyboard" | "pointer";
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
  const [navigation, setNavigation] = React.useState<"keyboard" | "pointer">("pointer");
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
        setNavigation("keyboard");
        move(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setNavigation("keyboard");
        move(-1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setNavigation("keyboard");
        const first = enabled[0];
        if (first !== undefined) setActiveIndex(first);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setNavigation("keyboard");
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
          if (index >= 0) {
            setNavigation("keyboard");
            setActiveIndex(index);
          }
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
      setNavigation("keyboard");
      open(event.key !== "ArrowDown");
      if (event.key === "ArrowDown") move(1);
    },
    [isOpen, move, open],
  );

  const onTriggerClick = React.useCallback(() => {
    if (disabled) return;
    if (isOpen) close();
    else {
      setNavigation("pointer");
      open(true);
    }
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
        onPointerEnter: () => {
          setNavigation("pointer");
          setActiveIndex(index);
        },
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
      "data-nav": navigation,
      style: popupStyle,
    },
    getOptionProps,
  };
}


/**
 * Quiet Controls C′의 미끄러지는 워시(+다텀).
 *
 * 세그먼트 컨테이너(position: relative)의 첫 자식으로 넣으면, 활성 옵션
 * (`aria-pressed="true"` 또는 `.is-active`)의 offset 좌표 위에 `.segmented-thumb`
 * 장식을 얹고 선택 이동을 미끄러짐으로 잇는다. 시각과 전환은 전부 CSS 토큰
 * (--control-wash·brass 다텀)과 CSS transition이 지므로 prefers-reduced-motion
 * 단락도 CSS에서 함께 닫힌다. 자리를 잡기 전(is-placed 없음)에는 활성 옵션의
 * 자체 face가 그대로 서므로 JS가 늦는 프레임에도 선택 상태는 항상 보인다.
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


/**
 * 막대 몫(`--m-chrome-top`)을 위 안쪽 여백으로 품는 떠 있는 줄(목차·탭 머리)의 제 높이 — 테두리 상자 높이에서 그 위 여백을 뺀다.
 * 막대 높이가 바뀌는 커밋(막대 변형 전환)이 이 줄을 그린 컴포넌트의 커밋과 달라도 값이 흔들리지 않게, 스크롤 영역은 막대 몫과 이 값을 더해 쓴다.
 * `useChromeHeightProperty`의 `measure`로 넘긴다.
 */
export function chromeRowHeight(node: HTMLElement): number {
  return node.getBoundingClientRect().height - (Number.parseFloat(getComputedStyle(node).paddingTop) || 0);
}


/**
 * 떠 있는 모바일 크롬(상단 막대·화면 머리·입력 독)의 높이를 `target`의 CSS 사용자 속성으로 옮겨 적는다. 크롬 밑으로 흐르는 스크롤
 * 내용은 이 값만큼 크롬 뒤로 늘어나고 같은 값만큼 안쪽 여백을 두어, 스크롤 끝의 첫·마지막 줄이 크롬에 가리지 않는다. 큰 글자 배율이나
 * 여러 줄 입력으로 크롬이 자라면 따라 적는다. `measure`가 없으면 `source`의 테두리 상자 높이다. 상자가 없는 원천(`display: contents`·
 * `display: none`)은 0이다. 원천이나 대상이 나중에 마운트·교체되면(조건부 머리) 다음 커밋에서 다시 붙고, 사라지면 속성을 지운다.
 *
 * 이 훅을 쓰는 컴포넌트의 커밋마다 그 레이아웃 단계에서 다시 재서 적는다 — 붙는 순간(첫 그림)과 그 커밋이 바꾼 크롬(막대 숨김·조건부 머리·
 * 탭 전환)은 같은 그림에서 여백이 맞는다. 크롬이 다른 컴포넌트의 상태로 바뀌면 그 상태를 이 컴포넌트도 구독해 같은 커밋에 서게 한다.
 * React 밖의 크기 변화(글자 배율·입력창 성장·창 크기)는 관찰자 알림을 받은 다음 프레임에 적는다 — 알림 안에서 적으면 바뀐 여백이 같은
 * 프레임에 원천과 같은 깊이의 관찰 대상(예: 목차가 보는 문서 스크롤 영역)의 크기를 바꿔, 브라우저가 그 알림을 넘기지 못하고
 * `ResizeObserver loop completed with undelivered notifications` 오류를 낸다. 값이 그대로면 적지 않는다.
 */
export function useChromeHeightProperty(
  source: React.RefObject<HTMLElement | null>,
  target: React.RefObject<HTMLElement | null>,
  property: `--${string}`,
  measure?: (source: HTMLElement) => number,
): void {
  const measureRef = React.useRef(measure);
  measureRef.current = measure;
  const bound = React.useRef<{ readonly node: HTMLElement; readonly host: HTMLElement; readonly sync: () => void; readonly release: () => void } | null>(null);
  const release = React.useCallback(() => {
    bound.current?.release();
    bound.current = null;
  }, []);
  // 매 커밋 뒤 원천·대상의 정체를 견준다 — 같으면 관찰자를 그대로 두고 지금 높이만 다시 적는다.
  React.useLayoutEffect(() => {
    const node = source.current;
    const host = target.current;
    const current = bound.current;
    if (current && current.node === node && current.host === host) { current.sync(); return; }
    release();
    if (!node || !host) return;
    let written: string | null = null;
    let frame: number | null = null;
    const write = () => {
      frame = null;
      const height = measureRef.current ? measureRef.current(node) : node.getBoundingClientRect().height;
      const value = `${Math.max(0, Math.ceil(height))}px`;
      if (value === written) return;
      written = value;
      host.style.setProperty(property, value);
    };
    write();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (frame === null) frame = requestAnimationFrame(write);
    });
    observer?.observe(node);
    bound.current = {
      node,
      host,
      sync: () => {
        if (frame !== null) cancelAnimationFrame(frame);
        write();
      },
      release: () => {
        observer?.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        host.style.removeProperty(property);
      },
    };
  });
  React.useLayoutEffect(() => release, [release]);
}
