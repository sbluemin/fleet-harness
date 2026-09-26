import { useEffect, useId, useRef, useState, type Ref } from "react";

import { useT } from "../../i18n/index.js";
import { setZenChromeSlot, setZenToolsSlot } from "../../integration/zen-chrome-slot.js";
import { requestZenMode } from "../../integration/zen-mode.js";
import { BrandMarkIcon } from "../components/command-band.js";

/**
 * Zen 바 — 작업 표시줄 오른쪽 끝의 트레이. 접기 화살표 · 레일 도구 · 밴드에서 옮겨 온 플러그인 항목 ·
 * 종료 버튼이 한 줄로 서고, 맨 끝에 Fleet 앰블럼이 선다(Zen 전환 장면에서 Band의 브랜드가 내려앉는 자리).
 * 화살표로 도구를 종료 버튼 쪽으로 말아 넣으면 종료 버튼과 앰블럼만 남는다.
 *
 * 작업 표시줄은 Operations 페이지 소속이지만 이 트레이는 콘솔 크롬이다 — 도구 칸과 플러그인 칸은
 * Zen이 꺼져 있어도 DOM에 남아야 한다(포털의 컨테이너가 커밋 중에 사라지면 옮겨 가던 항목이 분리된
 * 노드에 남는다). 그래서 앱 셸이 들고 작업 표시줄 위 오른쪽에 겹쳐 세우고, 제 폭을
 * --zen-bar-width로 알려 작업 표시줄이 그만큼 비켜 서게 한다. 바 전체가 hidden이라 Zen이 아닐
 * 때는 그려지지 않는다.
 */

const FOLD_STORAGE_KEY = "fleet-console.zen.tools-folded";
const WIDTH_PROPERTY = "--zen-bar-width";

function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLD_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(FOLD_STORAGE_KEY, String(folded));
  } catch {
    // 기억하지 못해도 이번 화면의 접힘은 그대로 선다.
  }
}

/** local — 개발 채널이면 Band와 같은 개발 브랜드(열린 링 · 마침표)를 세운다. 전환 장면의 마크가 같은 조형으로 내려앉는다. */
export function ZenBar({ active, local = false }: { readonly active: boolean; readonly local?: boolean }) {
  const t = useT();
  const barRef = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const [folded, setFolded] = useState(readFolded);

  // 작업 표시줄이 트레이 자리를 비켜 설 수 있게 폭을 알린다. 접고 펼치는 동안에도 매 프레임 따라간다.
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

  const toggleFold = () => {
    const next = !folded;
    setFolded(next);
    writeFolded(next);
  };

  return (
    <div ref={barRef} className={`zen-bar${folded ? " is-folded" : ""}`} hidden={!active} role="toolbar" aria-label={t("zen.bar.aria")}>
      <button
        type="button"
        className="zen-bar-fold"
        aria-label={t(folded ? "zen.bar.expand" : "zen.bar.fold")}
        title={t(folded ? "zen.bar.expand" : "zen.bar.fold")}
        aria-expanded={!folded}
        onClick={toggleFold}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {/* 서랍 — 접으면 폭이 0으로 말려 들어가며 흐려진다. 칸들은 DOM에 남는다(포털 계약). */}
      <div className="zen-bar-drawer" inert={folded || undefined}>
        <div className="zen-bar-drawer-inner">
          <span className="zen-bar-tools" ref={setZenToolsSlot} />
          <span className="zen-mode-chrome-slot" ref={setZenChromeSlot} />
        </div>
      </div>
      <button type="button" className="zen-bar-exit" aria-label={t("zen.exit")} aria-describedby={tipId} onClick={() => requestZenMode(false)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 5.5 5 5m0-5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <span className="zen-bar-tip" id={tipId} role="tooltip">{t("zen.exitShort")}</span>
      </button>
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
