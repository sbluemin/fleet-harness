import { useState, useSyncExternalStore } from "react";

import type { IdentityTone } from "../../workspace/shared/identity-tones.js";
import { commodoreAvatarKey, pickMongleBase } from "../../workspace/shared/avatars.js";
import { setMongleLook } from "../../workspace/client/avatar-events.js";
import { MongleAvatarPicker, type MongleAvatarPreviewState } from "../../workspace/client/components/mongle-avatar-picker.js";
import { useT, useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { openTheaterInbox } from "../../workspace/client/theater-inbox/store.js";
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
      openTheaterInbox({ theaterId: commodoreId, sectionId: "console:settings", pageId: "theaters" });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="commodore-create-scrim" role="presentation" onPointerDown={onClose}>
      <div className="commodore-create" role="dialog" aria-modal="true" aria-labelledby="commodore-create-title" onPointerDown={(event) => event.stopPropagation()}>
        <h2 id="commodore-create-title">{t("sidebar.commodore.createTitle")}</h2>
        <label className="commodore-create-name">
          <span>{t("sidebar.commodore.name")}</span>
          <input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
        </label>
        <MongleAvatarPicker
          role="commodore"
          base={base}
          tone={tone}
          previewState={preview}
          locale={locale}
          dirty={alias.length > 0}
          busy={busy}
          labels={{
            heading: t("sidebar.commodore.shape"),
            reroll: t("avatar.editor.reroll"),
            reset: t("avatar.editor.reset"),
            preview: t("avatar.editor.preview"),
            cancel: t("sidebar.commodore.cancel"),
            apply: t("sidebar.commodore.create"),
            toneGroup: t("avatar.editor.toneGroup"),
            baseGroup: t("avatar.editor.baseGroup"),
            states: { running: t("avatar.state.running"), awaiting: t("avatar.state.awaiting"), unseen: t("avatar.state.unseen"), idle: t("avatar.state.idle"), ended: t("avatar.state.ended") },
            tones: { cerulean: t("avatar.tone.cerulean"), teal: t("avatar.tone.teal"), amber: t("avatar.tone.amber"), plum: t("avatar.tone.plum"), rose: t("avatar.tone.rose"), moss: t("avatar.tone.moss"), indigo: t("avatar.tone.indigo"), crimson: t("avatar.tone.crimson") },
          }}
          onBase={setBase}
          onTone={setTone}
          onPreviewState={setPreview}
          onReroll={() => setBase(pickMongleBase(new Set([base])))}
          onReset={() => { setBase(1); setTone(null); }}
          onCancel={onClose}
          onApply={() => { void submit(); }}
        />
        {failed ? <p role="alert">{t("sidebar.commodore.failed")}</p> : null}
      </div>
    </div>
  );
}
