import type { ReactNode } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { openCommodoreTheaterSettings } from "../../../commodore/client/commodore-conversation.js";
import "./theater-tools.css";

/**
 * 등록 Theater가 없을 때 패널 본문 — 안내 한 줄과 「Theater 추가」 단추뿐이다.
 * 단추는 사령관 대화의 설정 탭 Theater 구역으로 간다.
 */
export function CommodoreToolsEmptyState({ commodoreId }: { readonly commodoreId: string }): ReactNode {
  const t = useT();
  return (
    <div className="ctt-empty">
      <p className="ctt-empty-body">{t("theaterTools.empty.body")}</p>
      <button type="button" className="ctt-empty-add" onClick={() => openCommodoreTheaterSettings(commodoreId)}>
        <span className="ctt-empty-plus" aria-hidden="true">+</span>
        <span>{t("theaterTools.empty.add")}</span>
      </button>
    </div>
  );
}
