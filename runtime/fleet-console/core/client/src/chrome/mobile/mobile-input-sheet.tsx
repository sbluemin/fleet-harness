import { useState } from "react";

import type { MobileInputSpec } from "@fleet-console/sdk/settings/browser";

import { useT } from "../../i18n/index.js";
import { MobileSheet } from "./mobile-sheet.js";
import { popMobileSheet, pushMobileSheet } from "./mobile-store.js";

/** 설정의 한 칸 입력 시트(P-4)를 연다 — 이름 변경 시트(S-13)와 같은 문법이다. */
export function openMobileInput(spec: MobileInputSpec): void {
  pushMobileSheet({ kind: "custom", render: (close) => <InputSheet spec={spec} close={close} /> });
}

function InputSheet({ spec, close }: { readonly spec: MobileInputSpec; readonly close: () => void }) {
  const t = useT();
  const [value, setValue] = useState(spec.value);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void Promise.resolve().then(action).then(close).catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const save = () => { if (value.trim() !== "") run(() => spec.onSave(value.trim())); };

  return (
    <MobileSheet
      title={spec.title}
      onClose={close}
      footer={<>
        {spec.onClear ? <button type="button" className="mobile-sheet-clear" disabled={busy} onClick={() => run(spec.onClear!)}>{t("mobile.sheet.clear")}</button> : null}
        <button type="button" className="mobile-pill-secondary" onClick={close}>{t("mobile.sheet.cancel")}</button>
        <button type="button" className="mobile-pill-secondary is-inverse" onClick={save} disabled={busy || value.trim() === ""}>{t("mobile.sheet.save")}</button>
      </>}
    >
      {spec.description ? <p className="mobile-input-desc">{spec.description}</p> : null}
      <div className="mobile-input-wrap">
        <input
          className="mobile-field"
          value={value}
          type={spec.secret && !shown ? "password" : "text"}
          inputMode={spec.inputMode ?? "text"}
          placeholder={spec.placeholder}
          aria-label={spec.title}
          aria-invalid={error !== null || undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}
          autoFocus
        />
        {spec.secret ? <button type="button" className="mobile-input-reveal" onClick={() => setShown((current) => !current)}>{t(shown ? "mobile.input.hide" : "mobile.input.show")}</button> : null}
      </div>
      {error ? <p className="mobile-input-error" role="alert">{error}</p> : null}
    </MobileSheet>
  );
}

export { popMobileSheet };
