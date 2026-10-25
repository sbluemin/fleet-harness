import { useState, useSyncExternalStore } from "react";

import type { IdentityTone } from "../../workspace/shared/identity-tones.js";
import { commodoreAvatarKey, pickMongleBase } from "../../workspace/shared/avatars.js";
import { setMongleLook } from "../../workspace/client/avatar-events.js";
import { MongleBaseGrid, MonglePreviewStates, MongleToneDots, type MongleAvatarPreviewState } from "../../workspace/client/components/mongle-avatar-picker.js";
import { MongleAvatar } from "../../workspace/client/components/mongle-avatar.js";
import { useT, useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { openTheaterInbox } from "../../workspace/client/theater-inbox/store.js";
import { openCommodoreConversation } from "./commodore-conversation.js";
import { createCommodore } from "./theaters-api.js";
import { refreshCommodoreList, setZoneCommodore } from "./commodore-list.js";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function requestCommodoreCreate(): void {
  open = true;
  emit();
}

export function CommodoreCreateModal() {
  const shown = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => open, () => false);
  if (!shown) return null;
  return <CommodoreCreateDialog onClose={() => { open = false; emit(); }} />;
}

function CommodoreCreateDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const locale = useConsoleLocale() === "ko" ? "ko" : "en";
  const [name, setName] = useState("");
  const [base, setBase] = useState(() => pickMongleBase(new Set()));
  const [tone, setTone] = useState<IdentityTone | null>(null);
  const [preview, setPreview] = useState<MongleAvatarPreviewState>("idle");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const alias = name.trim();

  const submit = async () => {
    if (!alias || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const commodoreId = createdId ?? (await createCommodore({ alias })).commodoreId;
      setCreatedId(commodoreId);
      const saved = await setMongleLook(commodoreAvatarKey(commodoreId), base, tone);
      if (!saved) { setFailed(true); return; }
      await refreshCommodoreList();
      setZoneCommodore(commodoreId);
      openCommodoreConversation(commodoreId);
      // 만든 사령관의 「설정」으로 착지한다 — 맨 위가 그 사령관의 Theater 목록이다.
      openTheaterInbox({ theaterId: commodoreId, sectionId: "commodore:commodore", pageId: "settings" });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const tones = { cerulean: t("avatar.tone.cerulean"), teal: t("avatar.tone.teal"), amber: t("avatar.tone.amber"), plum: t("avatar.tone.plum"), rose: t("avatar.tone.rose"), moss: t("avatar.tone.moss"), indigo: t("avatar.tone.indigo"), crimson: t("avatar.tone.crimson") };
  const states = { running: t("avatar.state.running"), awaiting: t("avatar.state.awaiting"), unseen: t("avatar.state.unseen"), idle: t("avatar.state.idle"), ended: t("avatar.state.ended") };

  // 머리(제목·닫기) · 본문(큰 미리보기와 상태 줄 · 이름 · 모양 · 색) · 발(취소·만들기)이 구분선으로 나뉜다. 큰 아바타가 고른 상태를 연기한다.
  return (
    <div className="commodore-create-scrim" role="presentation" onPointerDown={onClose}>
      <div
        className="commodore-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commodore-create-title"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      >
        <header className="commodore-create-head">
          <h2 id="commodore-create-title">{t("sidebar.commodore.createTitle")}</h2>
          <button type="button" className="commodore-create-close" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
          </button>
        </header>
        <div className="commodore-create-body">
          <div className="commodore-create-hero">
            <MongleAvatar base={base} tone={tone} role="commodore" state={preview} size={112} label={alias || t("sidebar.commodore.createTitle")} decorative />
          </div>
          <MonglePreviewStates previewState={preview} label={t("avatar.editor.preview")} states={states} onPreviewState={setPreview} showLabel={false} />
          <input
            className="commodore-create-name"
            value={name}
            autoFocus
            placeholder={t("sidebar.commodore.namePlaceholder")}
            aria-label={t("sidebar.commodore.name")}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
          />
          <MongleBaseGrid role="commodore" base={base} tone={tone} locale={locale} label={t("avatar.editor.baseGroup")} size={44} onBase={setBase} />
          <MongleToneDots base={base} tone={tone} label={t("avatar.editor.toneGroup")} names={tones} onTone={setTone} />
          {failed ? <p className="commodore-create-failed" role="alert">{t("sidebar.commodore.failed")}</p> : null}
        </div>
        <footer className="commodore-create-foot">
          <button type="button" className="fc-btn fc-btn--secondary commodore-create-button" onClick={onClose}>{t("sidebar.commodore.cancel")}</button>
          <button type="button" className="fc-btn fc-btn--primary commodore-create-button" disabled={!alias || busy} onClick={() => { void submit(); }}>{t("sidebar.commodore.create")}</button>
        </footer>
      </div>
    </div>
  );
}
