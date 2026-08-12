import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { fetchRemoteAccessStatus } from "../global-settings-api.js";
import { renderMessage, useT } from "../i18n/index.js";
import type { RemoteAccessLink } from "../types.js";
import { QrCode } from "./qr-code.js";

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** 붙었는지 보려고 설정 화면을 다시 읽게 하지 않으려면 이 창이 스스로 확인해야 한다. */
const POLL_INTERVAL_MS = 2_000;

/**
 * QR의 목표 변 길이. 실제 크기는 QrCode가 모듈 정수배로 내려 맞추므로 이 값보다 조금 작다.
 * 흔한 v13 심볼(여백 포함 77모듈)에서 모듈당 4px가 나오는 자리를 골랐다.
 */
const QR_TARGET_PX = 320;

type PairPhase = "waiting" | "paired" | "expired";

/**
 * 방금 만든 액세스 링크를 그 자리에서 폰에 넘기는 창.
 *
 * 발급과 전달이 갈라져 있는 것이 이 창이 생긴 이유다. 링크만 띄우면 남은 일은 전부 제품 밖에서
 * 일어난다 — 복사해서 메신저로 보내는 그 경로가, 같은 화면이 "신뢰하는 경로로만 보내라"고
 * 경고하는 바로 그 경로다. 카메라는 같은 방 안에서만 닿으므로 그 경고를 어기지 않는다.
 *
 * 성사를 여기서 확인하는 것도 같은 이유다. 확인이 표에만 있으면 사용자는 창을 닫고 표를 다시
 * 읽어야 하고, 그 사이 15분짜리 링크가 살아 있는지는 아무도 말해 주지 않는다.
 */
export function PairDeviceDialog({ link, onClose, openerRef }: {
  readonly link: RemoteAccessLink;
  readonly onClose: () => void;
  /** 닫힌 뒤 포커스가 돌아갈 자리. 되돌리기는 이 컴포넌트가 하고, 호출자는 자리만 알려 준다. */
  readonly openerRef?: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, link.expiresAt - Date.now()));
  const [phase, setPhase] = useState<PairPhase>(() => (link.expiresAt <= Date.now() ? "expired" : "waiting"));
  const [pairedDevice, setPairedDevice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".console-shell");
    if (shell) shell.inert = true;
    closeRef.current?.focus();
    return () => {
      // 순서가 계약이다 — inert를 먼저 풀지 않으면 focus()가 조용히 아무 일도 하지 않는다
      // (add-host-dialog에서 실측으로 잡힌 결함과 같은 것).
      if (shell) shell.inert = false;
      openerRef?.current?.focus();
    };
  }, [openerRef]);

  /**
   * 키는 document에서 받는다. 카드에 건 리스너는 포커스가 카드 안에 있을 때만 불리는데,
   * 성사 후 버튼이 바뀌는 순간 브라우저가 포커스를 body로 옮기면 Escape가 죽는다.
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

  // 남은 시간은 만료 시각에서 다시 계산한다 — 흘려보낸 초를 세면 탭이 잠든 사이 시계가 어긋난다.
  useEffect(() => {
    if (phase === "paired") return;
    const tick = () => {
      const left = Math.max(0, link.expiresAt - Date.now());
      setRemainingMs(left);
      if (left === 0) setPhase((current) => (current === "paired" ? current : "expired"));
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [link.expiresAt, phase]);

  /**
   * 성사는 링크가 사라졌다는 사실이 아니라 기기가 늘었다는 사실로 판정한다. 링크는 회수와
   * 만료로도 목록에서 빠지므로, 그것만 보면 아무도 붙지 않은 만료를 성공으로 읽는다.
   */
  useEffect(() => {
    if (phase !== "waiting") return;
    const controller = new AbortController();
    let known: ReadonlySet<string> | null = null;
    let stopped = false;

    const poll = () => {
      void fetchRemoteAccessStatus(controller.signal)
        .then((status) => {
          if (stopped) return;
          const ids = new Set(status.devices.map((device) => device.id));
          if (known === null) {
            known = ids;
            return;
          }
          const arrived = status.devices.find((device) => !known!.has(device.id));
          if (arrived === undefined) return;
          setPairedDevice(arrived.device);
          setPhase("paired");
        })
        .catch(() => {
          // 폴링 실패는 상태를 뒤집지 않는다. 붙지 않았다고 단정하면, 실제로 붙은 기기를
          // 두고 사용자가 링크를 하나 더 만들게 된다.
        });
    };

    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [phase]);

  const copy = () => {
    void navigator.clipboard.writeText(link.link).then(() => setCopied(true)).catch(() => setCopied(false));
  };

  return createPortal(
    <div className="pair-overlay" role="presentation">
      <button type="button" className="pair-scrim" aria-label={t("common.close")} onClick={onClose} />
      <div
        ref={cardRef}
        className="pair-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.remote.pair.title")}
      >
        <div className="pair-head">
          <h2 className="pair-title">{t("settings.remote.pair.title")}</h2>
          <button ref={closeRef} type="button" className="pair-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>

        <div className="pair-body">
          <div className="pair-symbol" data-phase={phase}>
            {phase === "waiting"
              ? <QrCode value={link.link} size={QR_TARGET_PX} label={t("settings.remote.pair.qrLabel")} />
              : <p className="pair-symbol-void">{t(phase === "paired" ? "settings.remote.pair.symbolDone" : "settings.remote.pair.symbolExpired")}</p>}
          </div>

          <div className="pair-side">
            <ol className="pair-steps">
              <li><span className="pair-step-index">1</span><span>{t("settings.remote.pair.step1")}</span></li>
              <li><span className="pair-step-index">2</span><span>{t("settings.remote.pair.step2")}</span></li>
              <li><span className="pair-step-index">3</span><span>{t("settings.remote.pair.step3")}</span></li>
            </ol>

            {phase === "waiting" ? <PairExpiry remainingMs={remainingMs} /> : null}

            <p className={`pair-state is-${phase}`} role="status">
              {phase === "paired"
                ? renderMessage(t("settings.remote.pair.paired"), { device: pairedDevice ?? t("settings.remote.table.unnamedDevice") })
                : phase === "expired"
                  ? t("settings.remote.pair.expired")
                  : t("settings.remote.pair.waiting")}
            </p>

            {link.access === "full" && phase === "waiting"
              ? <p className="pair-warning">{t("settings.remote.warning")}</p>
              : null}
          </div>
        </div>

        {/*
          QR을 읽을 수 없는 자리도 있다 — 카메라가 없는 기기, 화면을 공유 중인 회의, 원격 데스크톱.
          링크 문자열은 접어 두되 없애지는 않는다. 이 창이 기존의 붙여넣기 경로를 막으면,
          QR이 실패한 사람에게 남는 길이 사라진다.
        */}
        {phase === "waiting" ? (
          <div className="pair-fallback">
            {revealed ? (
              <div className="pair-link-field">
                <input readOnly value={link.link} aria-label={t("settings.remote.linkLabel")} onFocus={(event) => event.currentTarget.select()} />
                <button type="button" onClick={copy}>{copied ? t("settings.remote.copied") : t("settings.remote.copy")}</button>
              </div>
            ) : (
              <button type="button" className="pair-reveal" onClick={() => setRevealed(true)}>
                {t("settings.remote.pair.reveal")}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 남은 시간은 문장이 아니라 게이지로 준다. 15분이라는 제약은 숫자로 읽을 때는 압박이지만,
 * 줄어드는 길이로 볼 때는 안내가 된다 — 지금 서두를 일인지 아닌지가 한눈에 갈린다.
 */
function PairExpiry({ remainingMs }: { readonly remainingMs: number }) {
  const t = useT();
  const total = REMOTE_GRANT_TTL_MS;
  const ratio = Math.max(0, Math.min(1, remainingMs / total));
  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1_000);
  const urgent = remainingMs <= URGENT_THRESHOLD_MS;

  return (
    <div className="pair-expiry" data-urgent={urgent ? "true" : "false"}>
      <div className="pair-expiry-row">
        <span className="pair-expiry-label">{t("settings.remote.pair.expiresIn")}</span>
        <span className="pair-expiry-time">{`${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`}</span>
      </div>
      <div className="pair-expiry-track">
        <div className="pair-expiry-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}

/** 서버의 기본 유효 기간(auth.ts)과 같은 값이다. 게이지의 가득 찬 상태가 그 시간을 뜻한다. */
const REMOTE_GRANT_TTL_MS = 15 * 60 * 1_000;
/** 남은 시간이 이보다 적으면 게이지가 색으로도 말한다 — 숫자를 읽지 않는 사람에게도 보이도록. */
const URGENT_THRESHOLD_MS = 3 * 60 * 1_000;
