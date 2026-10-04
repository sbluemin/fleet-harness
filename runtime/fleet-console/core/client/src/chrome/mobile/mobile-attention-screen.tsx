import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { useT } from "../../i18n/index.js";
import { navigateConsoleRoute } from "../../integration/console-location.js";
import { focusOperation } from "../../integration/store.js";
import { AttentionReason } from "./mobile-attention-reason.js";
import { useMobileAttentionRows } from "./mobile-attention-context.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { setMobileDestination } from "./mobile-store.js";

/** S-35 「확인 필요」 전체 화면 — 드로어 구역이 세 건까지만 싣는 것의 전부. 답하면 이 목록에서 빠진다. */
export function MobileAttentionScreen() {
  const t = useT();
  const rows = useMobileAttentionRows();
  useClaimMobileBar({ variant: "centered", title: t("mobile.drawer.attention"), leading: "menu" });
  return (
    <section className="mobile-attention-screen">
      {rows.length === 0 ? <p className="mobile-attention-empty">{t("mobile.attention.empty")}</p> : (
        <>
          <div className="mobile-group">
            {rows.map((row) => row.kind === "operation" ? (
              <button type="button" className="mobile-group-row is-two" key={row.key} onClick={() => { setMobileDestination({ kind: "home" }); navigateConsoleRoute("/operations"); focusOperation(row.operation.id); }}>
                <span className={statusGlyphClassName("awaiting")} aria-hidden="true" />
                <span className="mobile-group-row-copy">{row.operation.title}<small className="is-awaiting"><AttentionReason row={row} /></small></span>
              </button>
            ) : (
              <button type="button" className="mobile-group-row is-two" key={row.key} onClick={() => { setMobileDestination({ kind: "plugin", entryId: row.entryId }); navigateConsoleRoute("/operations"); row.item.open(); }}>
                <span className={statusGlyphClassName("review")} aria-hidden="true" />
                <span className="mobile-group-row-copy">{row.item.title}<small className="is-awaiting"><AttentionReason row={row} /></small></span>
              </button>
            ))}
          </div>
          <p className="mobile-secnote">{t("mobile.attention.note")}</p>
        </>
      )}
    </section>
  );
}
