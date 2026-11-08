import { useEffect, useState } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { requestCommodoreCreate } from "../../commodore/client/commodore-create-modal.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { QuakerFigure } from "../../workspace/client/components/quaker-figure.js";
import type { FeatureCardContentProps, FeatureCardLinkProps } from "./feature-cards.js";
import "./quaker-promotion-card.css";

interface QuakerPromotionCopy {
  readonly eyebrow: string;
  readonly badge: string;
  readonly title: string;
  readonly bodyPre: string;
  readonly bodyEm1: string;
  readonly bodyMid: string;
  readonly bodyEm2: string;
  readonly bodyPost: string;
  readonly link: string;
  readonly replay: string;
  readonly dori: string;
  readonly tori: string;
  readonly bori: string;
}

const copyKo: QuakerPromotionCopy = {
  eyebrow: "새 기능",
  badge: "진급",
  title: "퀘이커 부관단이 사령관으로 진급했어요",
  bodyPre: "그동안 함께한 ",
  bodyEm1: "도리·토리·보리",
  bodyMid: "가 부관단을 떠나 사령관이 됐어요. 사령관을 만들거나 아바타를 바꿀 때 ",
  bodyEm2: "진급 사령관",
  bodyPost: "에서 고르면, 그 사령관이 고른 캐릭터의 말투로 답해요.",
  link: "아바타에서 고르기",
  replay: "다시 재생",
  dori: "도리",
  tori: "토리",
  bori: "보리",
};

const copyEn: QuakerPromotionCopy = {
  eyebrow: "New feature",
  badge: "Promotion",
  title: "The quaker aides are promoted to Commodores",
  bodyPre: "",
  bodyEm1: "Dori, Tori, and Bori",
  bodyMid: " have stepped down from the quaker aides and become Commodores. When creating a Commodore or changing an avatar, pick one from ",
  bodyEm2: "Promoted Commodores",
  bodyPost: " to hear their distinct voice in replies.",
  link: "Pick in avatars",
  replay: "Replay",
  dori: "Dori",
  tori: "Tori",
  bori: "Bori",
};

function promotionCopy(locale: ConsoleLocale): QuakerPromotionCopy {
  return locale === "ko" ? copyKo : copyEn;
}

function useOsReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function StarBadge({ className }: { readonly className: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="16" fill="var(--brass-ink)" stroke="var(--qk-ink-deep)" strokeWidth="2.4" />
      <path
        d="M20 10.5 L22.6 16.6 L29 17.1 L24.1 21.3 L25.7 27.6 L20 24.2 L14.3 27.6 L15.9 21.3 L11 17.1 L17.4 16.6 Z"
        fill="var(--qk-ink-deep)"
      />
    </svg>
  );
}

/** 퀘이커 부관단 사령관 진급 카드의 본문 */
export function QuakerPromotionCard({ titleId }: FeatureCardContentProps): React.JSX.Element {
  const locale: ConsoleLocale = useConsoleLocale();
  const copy = promotionCopy(locale);
  const osReduced = useOsReducedMotion();
  const settingReduced = useGlobalSettingsStore().state?.reduceMotion === true;
  const reduced = osReduced || settingReduced;
  const [replayKey, setReplayKey] = useState(0);

  return (
    <>
      <div className="tfi-head">
        <span className="tfi-eyebrow">{copy.eyebrow}</span>
        <span className="tfi-chip">{copy.badge}</span>
      </div>
      <h2 id={titleId} className="tfi-title">{copy.title}</h2>
      <div className={`qpc-stage${reduced ? " is-reduced" : ""}`}>
        <div key={replayKey} className="qpc-stage-inner">
          {/* 별빛 반짝이 */}
          <span className="qpc-tw" style={{ left: 40, top: 30 }} />
          <span className="qpc-tw" style={{ left: 120, top: 70, animationDelay: "0.6s" }} />
          <span className="qpc-tw" style={{ left: 230, top: 24, animationDelay: "1.2s" }} />
          <span className="qpc-tw" style={{ left: 410, top: 44, animationDelay: "0.3s" }} />
          <span className="qpc-tw" style={{ left: 500, top: 90, animationDelay: "1.6s" }} />
          <span className="qpc-tw" style={{ left: 330, top: 60, animationDelay: "0.9s" }} />

          {/* 색종이 */}
          <span className="qpc-conf qpc-conf--moss" style={{ left: 90, animationDelay: "2.3s" }} />
          <span className="qpc-conf qpc-conf--brass" style={{ left: 170, animationDelay: "2.5s" }} />
          <span className="qpc-conf qpc-conf--cerulean" style={{ left: 260, animationDelay: "2.35s" }} />
          <span className="qpc-conf qpc-conf--pearl" style={{ left: 350, animationDelay: "2.6s" }} />
          <span className="qpc-conf qpc-conf--brass" style={{ left: 440, animationDelay: "2.4s" }} />
          <span className="qpc-conf qpc-conf--moss" style={{ left: 500, animationDelay: "2.7s" }} />

          {/* 세 마리 진급 퀘이커 */}
          <div className="qpc-birds">
            {/* 도리 */}
            <div className="qpc-bird-slot">
              <div className="qpc-bird qpc-b1">
                <QuakerFigure morph="dori" size={120} />
                <span className="qpc-ringfx qpc-r1" />
                <StarBadge className="qpc-star qpc-s1" />
              </div>
              <span className="qpc-name qpc-name--dori">{copy.dori}</span>
            </div>

            {/* 토리 */}
            <div className="qpc-bird-slot">
              <div className="qpc-bird qpc-b2">
                <QuakerFigure morph="tori" size={132} />
                <span className="qpc-ringfx qpc-r2" />
                <StarBadge className="qpc-star qpc-s2" />
              </div>
              <span className="qpc-name qpc-name--tori">{copy.tori}</span>
            </div>

            {/* 보리 */}
            <div className="qpc-bird-slot">
              <div className="qpc-bird qpc-b3">
                <QuakerFigure morph="bori" size={120} />
                <span className="qpc-ringfx qpc-r3" />
                <StarBadge className="qpc-star qpc-s3" />
              </div>
              <span className="qpc-name qpc-name--bori">{copy.bori}</span>
            </div>
          </div>
        </div>

        {reduced ? null : (
          <button
            type="button"
            className="qpc-replay"
            onClick={() => setReplayKey((k) => k + 1)}
          >
            {copy.replay}
          </button>
        )}
      </div>
      <p className="tfi-body">
        {copy.bodyPre}
        <strong>{copy.bodyEm1}</strong>
        {copy.bodyMid}
        <strong>{copy.bodyEm2}</strong>
        {copy.bodyPost}
      </p>
    </>
  );
}

/** 카드 아래 줄 왼쪽의 '아바타에서 고르기' — 카드를 닫고 사령관 생성 모달을 띄운다. */
export function QuakerPromotionLink({ onLeave }: FeatureCardLinkProps): React.JSX.Element {
  const copy = promotionCopy(useConsoleLocale());
  const goPick = (): void => {
    onLeave();
    requestCommodoreCreate();
  };
  return (
    <button type="button" className="tfi-link" onClick={goPick}>
      {copy.link} <span aria-hidden="true">→</span>
    </button>
  );
}
