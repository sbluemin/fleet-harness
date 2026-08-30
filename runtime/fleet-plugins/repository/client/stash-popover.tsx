import { useEffect, useRef, useState, type RefObject } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { RepositoryMessageKey } from "./i18n/index.js";

type T = Translate<RepositoryMessageKey>;

/**
 * 스태시 메시지 상자. 앵커 옆에 뜬다.
 *
 * 자기 파일에 사는 이유는 부르는 자리가 둘이 되었기 때문이다 — 트리 열의 저장소 행 메뉴와,
 * 작업면 캡션의 스태시 버튼. 어느 한쪽 파일에 두면 다른 쪽이 그 파일을 통째로 의존하고,
 * 그 파일이 다시 이쪽을 부르는 순환이 생긴다.
 */
export function StashSavePopover({ t, hostRef, onSave, onClose }: {
  readonly t: T;
  readonly hostRef: RefObject<HTMLSpanElement | null>;
  readonly onSave: (message: string) => void;
  readonly onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);
  useEffect(() => {
    const host = hostRef.current;
    const handleOutsidePointer = (event: PointerEvent) => {
      // 앵커(버튼 포함) 밖 클릭만 닫는다 — 버튼 재클릭은 토글 핸들러가 맡는다.
      if (event.target instanceof Node && host && !host.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [hostRef, onClose]);
  return <div className="repository-stash-popover" role="dialog" aria-label={t("repository.stash.savePrompt")} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <label className="repository-stash-popover-label" htmlFor="repository-stash-message">{t("repository.stash.savePrompt")}</label>
    <input
      id="repository-stash-message"
      ref={inputRef}
      type="text"
      className="repository-stash-popover-input"
      placeholder={t("repository.stash.savePlaceholder")}
      value={message}
      maxLength={500}
      onChange={(event) => setMessage(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onSave(message); } }}
    />
    <div className="repository-stash-popover-actions">
      <button type="button" className="repository-refresh-btn" onClick={() => onClose()}>{t("repository.stash.saveCancel")}</button>
      <button type="button" className="repository-refresh-btn repository-stash-popover-confirm" onClick={() => onSave(message)}>{t("repository.stash.saveConfirm")}</button>
    </div>
  </div>;
}

