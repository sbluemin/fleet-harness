import { useMemo, useState } from "react";

import { useT } from "../../../core/client/src/i18n/index.js";
import { DirectoryBrowserModal } from "../../../core/client/src/chrome/components/directory-browser-modal.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { forgetTheaterCompletely, registerTheaterFromPath } from "../../workspace/client/theater.js";
import { addCommodoreTheater, removeCommodoreTheater } from "./theaters-api.js";
import { refreshCommodoreList, useCommodoreList, useZoneCommodore } from "./commodore-list.js";

/**
 * 작전 구역의 Theater 탭. 검색, 등록 목록(이미 추가한 행은 체크), 폴더에서 추가.
 * 행을 누르면 바로 추가하고 시트는 연 채로 둔다. 제거는 확인이 없다.
 */
export function CommodoreTheaterTab({ commodoreId: commodoreIdProp }: { readonly commodoreId?: string | null }) {
  const t = useT();
  const zone = useZoneCommodore();
  const commodoreId = commodoreIdProp ?? zone;
  const commodores = useCommodoreList();
  const theaters = useConsoleState().theaters;
  const commodore = commodores.find((item) => item.commodoreId === commodoreId) ?? null;
  const added = new Set(commodore?.theaters.map((theater) => theater.theaterId) ?? []);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => theaters.filter((theater) => needle.length === 0 || theater.label.toLowerCase().includes(needle)), [theaters, needle]);

  const add = (theaterId: string) => {
    if (!commodoreId || added.has(theaterId) || busy) return;
    setBusy(true);
    void addCommodoreTheater({ commodoreId, theaterId }).then(() => refreshCommodoreList()).finally(() => setBusy(false));
  };
  const remove = (theaterId: string) => {
    if (!commodoreId || busy) return;
    setBusy(true);
    void removeCommodoreTheater({ commodoreId, theaterId }).then(() => refreshCommodoreList()).finally(() => setBusy(false));
  };
  const addFromFolder = (path: string) => {
    if (!commodoreId) return;
    setBrowserOpen(false);
    setBusy(true);
    void registerTheaterFromPath(path).then((theaterId) => {
      if (!theaterId) return;
      return addCommodoreTheater({ commodoreId, theaterId }).then(() => refreshCommodoreList());
    }).finally(() => setBusy(false));
  };

  if (!commodoreId) return <p className="commodore-theaters-empty">{t("theaterInbox.theaters.empty")}</p>;

  return (
    <div className="commodore-theaters">
      <p className="commodore-theaters-applies">{t("theaterInbox.theaters.applies")}</p>
      {commodore && commodore.theaters.length === 0 ? <p className="commodore-theaters-empty">{t("theaterInbox.theaters.empty")}</p> : null}
      <ul className="commodore-theaters-list">
        {commodore?.theaters.map((theater) => (
          <li key={theater.theaterId} className={theater.status === "missing" ? "is-missing" : ""}>
            <span className="commodore-theaters-name">{theater.label}</span>
            {theater.status === "missing" ? <span className="commodore-theaters-missing">{t("theaterInbox.theaters.missing")}</span> : null}
            <button type="button" className="commodore-theaters-remove" onClick={() => remove(theater.theaterId)}>{t("theaterInbox.theaters.remove")}</button>
          </li>
        ))}
      </ul>
      <div className="commodore-theaters-sheet">
        <input className="commodore-theaters-search" value={query} placeholder={t("theaterInbox.theaters.search")} aria-label={t("theaterInbox.theaters.search")} onChange={(event) => setQuery(event.target.value)} />
        <ul>
          {rows.map((theater) => (
            <li key={theater.id}>
              <button type="button" className="commodore-theaters-candidate" onClick={() => add(theater.id)} disabled={added.has(theater.id)}>
                <span>{theater.label}</span>
                {added.has(theater.id) ? <span aria-hidden="true">✓</span> : null}
              </button>
              <button type="button" className="commodore-theaters-more" aria-label={t("theaterInbox.theaters.forget")} onClick={() => setMenu(menu === theater.id ? null : theater.id)}>⋯</button>
              {menu === theater.id ? <button type="button" className="commodore-theaters-forget" onClick={() => { setMenu(null); void forgetTheaterCompletely(theater.id); }}>{t("theaterInbox.theaters.forget")}</button> : null}
            </li>
          ))}
        </ul>
        <button type="button" className="commodore-theaters-folder" onClick={() => setBrowserOpen(true)} disabled={busy}>{t("theaterInbox.theaters.fromFolder")}</button>
      </div>
      <DirectoryBrowserModal open={browserOpen} onCancel={() => setBrowserOpen(false)} onConfirm={addFromFolder} />
    </div>
  );
}
