import { useEffect, useRef, type Ref } from "react";

import { useT } from "../../i18n/index.js";
import { setZenToolbarHost } from "../../integration/toolbar-slots.js";
import { BrandMarkIcon } from "../components/command-band.js";

/**
 * Zen 바 — 작업 표시줄 오른쪽 끝의 트레이. 콘솔의 도구모음(console-toolbar.tsx)이 Zen 동안 이 자리에
 * 서고, 맨 끝에 Fleet 앰블럼이 선다(Zen 전환 장면에서 Band의 브랜드가 내려앉는 자리).
 *
 * 작업 표시줄은 Operations 페이지 소속이지만 이 트레이는 콘솔 크롬이다 — 도구모음의 자리는 Zen이
 * 꺼져 있어도 DOM에 남아 있어야 한다(도구모음이 자기 노드를 옮겨 끼우는 자리). 그래서 앱 셸이 들고
 * 작업 표시줄 위 오른쪽에 겹쳐 세우고, 제 폭을 --zen-bar-width로 알려 작업 표시줄이 그만큼 비켜 서게
 * 한다. 바 전체가 hidden이라 Zen이 아닐 때는 그려지지 않는다.
 */

const WIDTH_PROPERTY = "--zen-bar-width";

/** local — 개발 채널이면 Band와 같은 개발 브랜드(열린 링 · 마침표)를 세운다. 전환 장면의 마크가 같은 조형으로 내려앉는다. */
export function ZenBar({ active, local = false }: { readonly active: boolean; readonly local?: boolean }) {
  const t = useT();
  const barRef = useRef<HTMLDivElement>(null);

  // 작업 표시줄이 트레이 자리를 비켜 설 수 있게 폭을 알린다. 도구를 접고 펼치는 동안에도 매 프레임 따라간다.
  useEffect(() => {
    const bar = barRef.current;
    const root = document.documentElement;
    if (!active || bar === null) return;
    const publish = () => root.style.setProperty(WIDTH_PROPERTY, `${Math.ceil(bar.getBoundingClientRect().width)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty(WIDTH_PROPERTY);
    };
  }, [active]);

  return (
    <div ref={barRef} className="zen-bar" hidden={!active} role="group" aria-label={t("zen.bar.aria")}>
      <span className="zen-bar-toolbar" ref={setZenToolbarHost} />
      <span className="zen-bar-brand" title="Fleet">
        <BrandMarkIcon className="zen-bar-brand-glyph" local={local} />
        <BrandWordmark className="zen-bar-brand-wordmark" local={local} />
      </span>
    </div>
  );
}

/** 브랜드 워드마크 — 서체는 밴드 워드마크를 함께 입어 받고, 개발 채널이면 Band와 같은 잉크와 마침표를 쓴다. */
export function BrandWordmark({ className, local, ref }: { readonly className: string; readonly local: boolean; readonly ref?: Ref<HTMLSpanElement> }) {
  return (
    <span ref={ref} className={`command-band-brand-wordmark ${className}${local ? " is-local" : ""}`}>
      Fleet{local ? <span className="command-band-brand-wordmark-dot" aria-hidden="true">.</span> : null}
    </span>
  );
}
