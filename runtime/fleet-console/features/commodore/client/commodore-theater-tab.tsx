import { useState } from "react";

import { useT } from "../../../core/client/src/i18n/index.js";
import { DirectoryBrowserModal } from "../../../core/client/src/chrome/components/directory-browser-modal.js";
import { MobileFolderSheet } from "../../../core/client/src/chrome/mobile/mobile-folder-sheet.js";
import { pushMobileSheet } from "../../../core/client/src/chrome/mobile/mobile-store.js";
import { describeTheaterRegistrationError } from "../../../core/client/src/integration/failure-notices.js";
import { addCommodoreTheaterFromPath, removeCommodoreTheater } from "./theaters-api.js";
import { refreshCommodoreList, useCommodoreList } from "./commodore-list.js";

/**
 * 설정 맨 위의 「Theater」 — 이 사령관이 가진 Theater 목록이다. 다른 사령관과 나누는 목록에서 골라 잇지 않는다:
 * 「+ Theater 추가」는 곧바로 폴더를 고르고 그 폴더를 이 사령관에 더하며, 행의 「제거」는 이 사령관에서만 뺀다.
 * 데스크톱은 정보 탭의 정보 목록, 폰은 폰 정보 묶음과 같은 줄 문법이다.
 */
export function CommodoreTheaters({ commodoreId, phone = false }: { readonly commodoreId: string; readonly phone?: boolean }) {
  const t = useT(phone);
  const commodore = useCommodoreList().find((item) => item.commodoreId === commodoreId) ?? null;
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const theaters = commodore?.theaters ?? [];

  const run = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailureMessage(null);
    void work().catch((error) => setFailureMessage(describeTheaterRegistrationError(error, t))).finally(() => setBusy(false));
  };
  const remove = (theaterId: string) => run(async () => {
    await removeCommodoreTheater({ commodoreId, theaterId });
    await refreshCommodoreList();
  });
  const addFolder = (path: string) => run(async () => {
    await addCommodoreTheaterFromPath(commodoreId, path);
    await refreshCommodoreList();
  });
  const pickFolder = () => {
    if (busy) return;
    if (phone) pushMobileSheet({ kind: "custom", render: (dismiss) => <MobileFolderSheet onClose={dismiss} onConfirm={(path) => { dismiss(); addFolder(path); }} /> });
    else setBrowserOpen(true);
  };
  const failure = failureMessage ? <p className={phone ? "objectives-cm-note" : "objectives-commodore-hint is-error"} role="alert">{failureMessage}</p> : null;
  if (!commodoreId) return null;
  const note = theaters.length === 0 ? t("theaterInbox.theaters.empty") : t("theaterInbox.theaters.applies");

  if (phone) {
    return (
      <section className="commodore-theaters is-phone" aria-label={t("theaterInbox.theaters.page")}>
        <p className="objectives-cm-glab">{t("theaterInbox.theaters.page")}</p>
        <div className="objectives-cm-grp">
          {theaters.map((theater) => (
            <div key={theater.theaterId} className={`objectives-cm-gr${theater.status === "missing" ? " is-missing" : ""}`}>
              <span className="objectives-cm-gr-tx">{theater.label}{theater.status === "missing" ? <small>{t("theaterInbox.theaters.missing")}</small> : null}</span>
              <button type="button" data-press="r1" className="objectives-cm-tbtn" aria-label={t("theaterInbox.theaters.removeAria", { theater: theater.label })} disabled={busy} onClick={() => remove(theater.theaterId)}>{t("theaterInbox.theaters.remove")}</button>
            </div>
          ))}
          <button type="button" data-press="r1" className="objectives-cm-gr commodore-theaters-phone-add" disabled={busy} onClick={pickFolder}>
            <span className="objectives-cm-intel-plus" aria-hidden="true">+</span>
            <span className="objectives-cm-gr-tx">{t("theaterInbox.theaters.add")}</span>
          </button>
        </div>
        {failure}
        <p className="objectives-cm-secnote">{note}</p>
      </section>
    );
  }

  return (
    <section className="objectives-commodore-section commodore-theaters" aria-label={t("theaterInbox.theaters.page")}>
      <p className="objectives-commodore-section-title">{t("theaterInbox.theaters.page")}</p>
      {theaters.length > 0 ? (
        <ul className="commodore-theaters-list">
          {theaters.map((theater) => (
            <li key={theater.theaterId} className={theater.status === "missing" ? "is-missing" : undefined}>
              <span className="commodore-theaters-name" title={theater.label}>{theater.label}</span>
              {theater.status === "missing" ? <span className="commodore-theaters-missing">{t("theaterInbox.theaters.missing")}</span> : null}
              <button type="button" className="objectives-commodore-text-button" aria-label={t("theaterInbox.theaters.removeAria", { theater: theater.label })} disabled={busy} onClick={() => remove(theater.theaterId)}>{t("theaterInbox.theaters.remove")}</button>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="commodore-theaters-add" disabled={busy} onClick={pickFolder}>
        <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
        <span>{t("theaterInbox.theaters.add")}</span>
      </button>
      {failure}
      <p className="objectives-commodore-hint">{note}</p>
      <DirectoryBrowserModal open={browserOpen} onCancel={() => setBrowserOpen(false)} onConfirm={(path) => { setBrowserOpen(false); addFolder(path); }} />
    </section>
  );
}
