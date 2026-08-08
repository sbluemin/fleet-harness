import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useT, type CoreMessageKey } from "../i18n/index.js";
import { addRemoteHost } from "../remote-hosts.js";

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * 액세스 링크 한 줄을 받아 다른 콘솔을 목록에 넣는 팝업.
 *
 * 호스트 스위처와 설정이 같은 창을 연다 — 링크를 붙여넣는 일은 호스트를 고르는 자리에서
 * 시작되므로 스위처가 주 입구이고, 설정은 목록을 관리하다 하나 더 붙이는 곁문이다. 입구가
 * 둘이어도 입력 화면은 하나여야 한다: 폼이 두 벌이면 오류 문장과 검증이 갈라진다.
 *
 * 링크는 여기서 풀지 않는다. 문자열 그대로 서버에 넘기고, 서버가 봉투를 열어 인증서를 대조한
 * 뒤에야 목록에 든다 — 화면이 먼저 믿어 버리면 그 대조는 형식이 된다.
 */
export function AddHostDialog({ onClose, openerRef }: {
  readonly onClose: () => void;
  /** 닫힌 뒤 포커스가 돌아갈 자리. 되돌리기는 이 컴포넌트가 하고, 호출자는 자리만 알려 준다. */
  readonly openerRef?: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 같은 링크로 다시 눌러 같은 코드가 돌아와도 포커스는 되돌려야 하므로, 실패는 코드가
  // 아니라 횟수로 센다 — error만 보면 값이 같은 두 번째 실패에 effect가 돌지 않는다.
  const [failures, setFailures] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 응답을 기다리는 동안에도 닫을 수 있다(닿지 않는 주소의 탐침은 몇 초를 끈다) — 닫힌 뒤
  // 도착한 결과로 사라진 화면을 되살리지 않기 위해 살아 있는지부터 본다.
  const aliveRef = useRef(true);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".console-shell");
    if (shell) shell.inert = true;
    inputRef.current?.focus();
    return () => {
      aliveRef.current = false;
      // 순서가 계약이다 — inert를 먼저 풀지 않으면 focus()가 조용히 아무 일도 하지 않고,
      // 브라우저가 근처의 다른 버튼을 골라 준다(실측으로 잡힌 결함).
      if (shell) shell.inert = false;
      openerRef?.current?.focus();
    };
  }, [openerRef]);

  /**
   * 키는 document에서 받는다. 카드에 건 리스너는 포커스가 카드 안에 있을 때만 불리는데,
   * 보내는 동안 입력과 버튼이 비활성이 되면 브라우저가 포커스를 body로 옮긴다 — 그때
   * Escape가 죽고 Tab이 덫을 빠져나간다. 모달은 포커스가 어디 있든 닫혀야 한다.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (card === null) return;
      const focusable = [...card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!card.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 실패 후 포커스는 렌더가 끝난 뒤에야 돌려줄 수 있다 — 비활성 입력은 포커스를 받지 않으므로
  // 같은 호출 안에서 focus()를 불러도 아무 일이 일어나지 않는다.
  useEffect(() => {
    if (failures === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [failures]);

  const submit = () => {
    const value = link.trim();
    if (value.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    void addRemoteHost(value)
      .then(() => { if (aliveRef.current) onClose(); })
      .catch((cause: unknown) => {
        if (!aliveRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
        setFailures((count) => count + 1);
      });
  };

  return createPortal(
    <div className="add-host-overlay" role="presentation">
      <button type="button" className="add-host-scrim" aria-label={t("common.close")} onClick={onClose} />
      <div
        ref={cardRef}
        className="add-host-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("chrome.hosts.addTitle")}
      >
        <div className="add-host-head">
          <h2 className="add-host-title">{t("chrome.hosts.addTitle")}</h2>
          <button type="button" className="add-host-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>
        <p className="add-host-lede">{t("chrome.hosts.addLede")}</p>

        <form
          className="add-host-field"
          onSubmit={(event) => { event.preventDefault(); submit(); }}
        >
          <input
            ref={inputRef}
            value={link}
            aria-label={t("settings.remote.hosts.addLabel")}
            placeholder={t("settings.remote.hosts.addPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            disabled={busy}
            onChange={(event) => setLink(event.target.value)}
          />
          <div className="add-host-actions">
            <button type="button" className="add-host-cancel" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" className="add-host-submit" disabled={busy || link.trim().length === 0}>
              {busy ? t("settings.remote.hosts.adding") : t("settings.remote.hosts.add")}
            </button>
          </div>
        </form>

        {error ? <p className="add-host-error" role="alert">{t(remoteHostErrorKey(error))}</p> : null}
        <p className="add-host-note">{t("settings.remote.hosts.pinned")}</p>
      </div>
    </div>,
    document.body,
  );
}

/** 서버가 준 코드만 문장으로 바꾼다 — 모르는 코드는 지어내지 않고 가장 흔한 원인으로 되돌린다. */
export function remoteHostErrorKey(code: string): CoreMessageKey {
  const known = ["pairing_target_invalid", "remote_host_unreachable", "remote_host_fingerprint_mismatch", "remote_host_is_self"];
  return (known.includes(code) ? `settings.remote.hosts.error.${code}` : "settings.remote.hosts.error.pairing_target_invalid") as CoreMessageKey;
}
